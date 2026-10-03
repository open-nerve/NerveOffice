// 组件级的按需加载（M2-P5 S3）：点了入口才下载功能的代码（例如分享对话框），不进页面的首屏。
// 路由级的页面由路由表与内容区的错误边界处理（app/routes.ts、app/pages/error-page.tsx）；组件级的入口在页面里，代码没能下载下来时
// 不能整页换掉（页面上可能有用户正在做的事，例如展开着的面板、填了一半的表单），由入口自己说明（shared/ui/chunk-load-notice.tsx）。
// 下载的包装与判断原因与路由级共用（shared/lib/chunk-load.ts）：部署了新版本时不自动整页重新加载，说明"已部署新版本"，由用户重试。
import type { ChunkProblem } from './chunk-load.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { diagnoseChunkLoad, loadChunk } from './chunk-load.ts'

/** 下载到了哪一步 */
export type LazyChunk<T>
  = | { readonly state: 'idle' }
    | { readonly state: 'loading' }
    | { readonly state: 'ready', readonly module: T }
    /** 没能下载下来；problem 为 undefined 时还在判断原因（向服务端要一次入口页，有时限） */
    | { readonly state: 'failed', readonly problem: ChunkProblem | undefined }

export interface LazyChunkHandle<T> {
  readonly chunk: LazyChunk<T>
  /**
   * 开始下载（正在下载时等同一次，下载好了直接给出）：兑现为模块；没能下载下来时兑现为 undefined，原因随后由 chunk 给出。
   * 失败之后再调用会重新下载一次（有的浏览器在同一页里记住了失败的模块，再下载也还是失败：说明里的"重试"整页重新加载）
   */
  readonly load: () => Promise<T | undefined>
}

/**
 * importer 是那一处动态 import()：写在入口所在的文件里（lint 的模块边界只允许那几个文件动态引用这个功能），要在模块的顶层定义
 * （每次渲染都是同一个函数）
 */
export function useLazyChunk<T>(importer: () => Promise<T>): LazyChunkHandle<T> {
  const [chunk, setChunk] = useState<LazyChunk<T>>({ state: 'idle' })
  const inFlightRef = useRef<Promise<T | undefined>>(undefined)
  const loadedRef = useRef<{ readonly module: T }>(undefined)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<T | undefined> => {
    if (loadedRef.current !== undefined)
      return loadedRef.current.module
    if (inFlightRef.current !== undefined)
      return inFlightRef.current
    setChunk({ state: 'loading' })
    const attempt = (async () => {
      try {
        const module = await loadChunk(importer)
        loadedRef.current = { module }
        if (mountedRef.current)
          setChunk({ state: 'ready', module })
        return module
      }
      catch {
        if (mountedRef.current)
          setChunk({ state: 'failed', problem: undefined })
        // 组件级不自动整页重新加载：部署了新版本也只说明，由用户决定（不给 onDeployed，结果因此总有原因）
        const problem = (await diagnoseChunkLoad()) ?? 'updated'
        if (mountedRef.current)
          setChunk(current => (current.state === 'failed' ? { state: 'failed', problem } : current))
        return undefined
      }
      finally {
        inFlightRef.current = undefined
      }
    })()
    inFlightRef.current = attempt
    return attempt
  }, [importer])

  return { chunk, load }
}

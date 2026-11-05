import type { DocumentHistoryDetail, SessionResponse } from '@nerve-office/contracts'
import type { SessionImageAccessController } from '../../shared/lib/session-image-access.ts'
import { compareVersions, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { isAccessDenied, isAuthenticationError, isTransientError } from '../../shared/api/index.ts'
import { createSessionImageAccess } from '../../shared/lib/session-image-access.ts'

export type PreviewState = { readonly kind: 'loading' | 'unavailable' | 'unsupported' | 'unusable' | 'signed-out' | 'changed-user' | 'disposed' } | { readonly kind: 'ready', readonly history: DocumentHistoryDetail } | { readonly kind: 'failed', readonly error: unknown }
export interface PreviewEditor {
  readonly usable: boolean
  readonly dispose: () => Promise<void>
}
type PreviewActivity = 'user' | 'background'
export interface PreviewDependencies {
  readonly session: (signal: AbortSignal, activity: PreviewActivity) => Promise<SessionResponse>
  readonly detail: (signal: AbortSignal) => Promise<DocumentHistoryDetail>
  readonly content: (signal: AbortSignal) => Promise<string>
  readonly mount: (snapshot: string, images: SessionImageAccessController, metadata: DocumentHistoryDetail) => Promise<PreviewEditor>
  readonly adopt: (session: SessionResponse | undefined) => void
  /** 数据类的失败（正文解不开、SDK 按数据拒绝）：按“无法预览”的终态处理（M5R-M-05）；由组装处判定，控制器不依赖编辑器模块 */
  readonly unusable?: (error: unknown) => boolean
}
export interface HistoryPreviewController {
  readonly refresh: (activity?: PreviewActivity) => Promise<void>
  readonly view: () => PreviewState
  readonly subscribe: (listener: () => void) => () => void
  readonly dispose: () => Promise<void>
}
/** 就绪时的后台复核超过这么久仍没有结论，才隐藏正文、暂停图片（D-06） */
export const VERIFY_HIDE_MS = 10_000

/**
 * 后台复核不再自动重试的状态：无法预览、不受支持，以及不是网络或服务端临时故障的失败。
 * 重试也是同样的结果，只在用户点击时重来（M5R-M-04、D-06）
 */
function settled(state: PreviewState): boolean {
  return state.kind === 'unusable' || state.kind === 'unsupported' || (state.kind === 'failed' && !isTransientError(state.error))
}

function supported(history: DocumentHistoryDetail): boolean {
  return history.compatibility === 'supported' && history.type === 'sheet'
    && history.profile === DOCUMENT_PROFILE_OF.sheet && history.formatVersion === PLATFORM_FORMAT_VERSION
    && (compareVersions(history.sdkVersion, UNIVER_SDK_VERSION) ?? 1) <= 0
}

/** 只有读取、资格复核与 read 实例；不依赖完整编辑会话、草稿维护或自动保存。 */
export function createHistoryPreview(deps: PreviewDependencies): HistoryPreviewController {
  let state: PreviewState = { kind: 'loading' }
  let generation = 0
  let disposed = false
  let ended = false
  let abort: AbortController | undefined
  let images: SessionImageAccessController | undefined
  let editor: PreviewEditor | undefined
  let mounting = Promise.resolve()
  let retiring = Promise.resolve()
  const listeners = new Set<() => void>()
  const current = (token: number) => !disposed && !ended && token === generation
  function publish(next: PreviewState): void {
    state = next
    for (const listener of [...listeners])
      listener()
  }
  async function retire(): Promise<void> {
    const previous = editor
    editor = undefined
    if (previous !== undefined)
      retiring = retiring.then(async () => previous.dispose())
    return retiring
  }
  async function block(next: PreviewState, terminal = false): Promise<void> {
    images?.suspend()
    if (terminal) {
      ended = true
      deps.adopt(undefined)
    }
    publish(next)
    await retire()
  }
  async function authorize(token: number, signal: AbortSignal, activity: PreviewActivity = 'background') {
    const session = await deps.session(signal, activity)
    if (!current(token))
      return undefined
    if (images !== undefined && images.owner !== session.user.id) {
      await block({ kind: 'changed-user' }, true)
      return undefined
    }
    images ??= createSessionImageAccess(session.user.id)
    deps.adopt(session)
    const history = await deps.detail(signal)
    if (!current(token))
      return undefined
    if (!supported(history)) {
      await block({ kind: 'unsupported' })
      return undefined
    }
    return { session, history }
  }
  async function refresh(activity: PreviewActivity = 'user'): Promise<void> {
    if (disposed || ended || (activity === 'background' && settled(state)))
      return
    const token = ++generation
    abort?.abort()
    abort = new AbortController()
    const { signal } = abort
    // 就绪时的后台复核只核验（D-06）：不暂停图片、不隐藏画布、不发布加载态，超过 VERIFY_HIDE_MS 仍没有结论才隐藏。
    // 换人、撤权、登录失效与失败照旧立即清除（block）。其余情况（首次加载、用户重试、失败后的重试）隐藏画布并停止图片
    const verifying = activity === 'background' && state.kind === 'ready' && editor !== undefined
    let slow: ReturnType<typeof setTimeout> | undefined
    if (verifying) {
      slow = setTimeout(() => {
        if (current(token)) {
          images?.suspend()
          publish({ kind: 'loading' })
        }
      }, VERIFY_HIDE_MS)
    }
    else {
      images?.suspend()
      publish({ kind: 'loading' })
    }
    try {
      let access = await authorize(token, signal, activity)
      if (access === undefined || !current(token))
        return
      if (editor === undefined) {
        const snapshot = await deps.content(signal)
        if (!current(token))
          return
        access = await authorize(token, signal)
        if (access === undefined || !current(token))
          return
        const { history } = access
        const imageAccess = images
        if (imageAccess === undefined)
          return
        // 连续复核遇到仍在创建的 SDK 时串行；晚到实例先销毁，才允许下一实例使用同一容器。
        const pending = mounting.then(async () => {
          await retiring
          if (!current(token))
            return
          const mounted = await deps.mount(snapshot, imageAccess, history)
          if (!current(token)) {
            await mounted.dispose()
            return
          }
          if (!mounted.usable) {
            await mounted.dispose()
            await block({ kind: 'unusable' })
            return
          }
          editor = mounted
        })
        mounting = pending.catch(() => {})
        await pending
        if (!current(token) || editor === undefined)
          return
        // SDK 初始化可能很慢，显示之前再次确认，图片也只在这之后启用。
        access = await authorize(token, signal)
        if (access === undefined || !current(token))
          return
      }
      images?.confirm(access.session)
      publish({ kind: 'ready', history: access.history })
    }
    catch (error) {
      if (!current(token))
        return
      if (isAuthenticationError(error))
        await block({ kind: 'signed-out' }, true)
      else if (isAccessDenied(error))
        await block({ kind: 'unavailable' })
      else if (deps.unusable?.(error) === true)
        await block({ kind: 'unusable' })
      else
        await block({ kind: 'failed', error })
    }
    finally {
      clearTimeout(slow)
    }
  }
  return {
    refresh,
    view: () => state,
    subscribe: (listener) => {
      if (!disposed)
        listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: async () => {
      if (!disposed) {
        disposed = true
        generation += 1
        abort?.abort()
        images?.dispose()
        publish({ kind: 'disposed' })
        listeners.clear()
      }
      await retire()
      await mounting
    },
  }
}

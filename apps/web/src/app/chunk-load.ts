// 按需加载的页面的代码（分块）没能下载下来（M2-P6 复核 S6）：断网，或者部署之后旧的分块已经不在了（文件名带哈希，部署一次换一批）。

/** 动态 import() 失败：浏览器不给出原因（404 与断网是同一个 TypeError），由错误边界再判断是不是部署了新版本 */
export class ChunkLoadError extends Error {
  override readonly name = 'ChunkLoadError'
}

/** 下载按需加载的页面：失败时换成 ChunkLoadError，路由的错误边界据此认出它（而不是按浏览器各不相同的说明去猜） */
export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  }
  catch (error) {
    throw new ChunkLoadError('页面的代码没能加载', { cause: error })
  }
}

/** 入口页里的模块脚本（入口与它引用的那些）：部署一次，带哈希的文件名就变一次 */
function moduleScriptsOf(root: ParentNode): string {
  return [...root.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')).join(' ')
}

/**
 * 服务端现在的入口页与这个页面加载时的比：deployed 是部署了新版本（version 是新版本的入口脚本）；
 * same 是没有变（分块是临时没下载下来）；unreachable 是服务端连不上（断网）
 */
export type DeploymentCheck
  = | { readonly kind: 'deployed', readonly version: string }
    | { readonly kind: 'same' | 'unreachable' }

/**
 * 向服务端要一次入口页（不走缓存），看入口脚本还是不是这个页面加载的那几个。
 * 入口页本身是 no-store 的（apps/api 的 web-hosting），带哈希的资源长期缓存：部署之后旧页面要的分块已经不在了
 */
export async function checkDeployment(currentDocument: Document = document): Promise<DeploymentCheck> {
  let html: string
  try {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'text/html' } })
    if (!response.ok)
      return { kind: 'unreachable' }
    html = await response.text()
  }
  catch {
    return { kind: 'unreachable' }
  }
  const deployed = moduleScriptsOf(new DOMParser().parseFromString(html, 'text/html'))
  return deployed !== '' && deployed !== moduleScriptsOf(currentDocument) ? { kind: 'deployed', version: deployed } : { kind: 'same' }
}

const RELOADED_FOR = 'nerve-office:reloaded-for-deployment'

/**
 * 部署了新版本时整页重新加载一次（加载新的入口页，拿到新的分块）。防止循环：记下为哪个版本重新加载过（sessionStorage，
 * 只在这个标签页里），同一个版本不再重新加载；存不进去（隐私模式等）时也不重新加载，交给"重试"。
 * 返回是否已经发起重新加载
 */
export function reloadOnceForDeployment(version: string, reload: () => void): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_FOR) === version)
      return false
    sessionStorage.setItem(RELOADED_FOR, version)
  }
  catch {
    return false
  }
  reload()
  return true
}

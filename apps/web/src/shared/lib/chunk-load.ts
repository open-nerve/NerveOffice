// 按需加载的代码（分块）没能下载下来（M2-P6 复核 S6）：断网，或者部署之后旧的分块已经不在了（文件名带哈希，部署一次换一批）。
// 路由级的页面（app/routes.ts，失败由内容区的错误边界接住）与组件级的功能（M2-P5 的分享对话框，失败由入口自己说明，
// shared/lib/use-lazy-chunk.ts）共用这里的下载与判断原因：放在 shared，功能模块引用不到 app/。

/** 动态 import() 失败：浏览器不给出原因（404 与断网是同一个 TypeError），由错误边界再判断是不是部署了新版本 */
export class ChunkLoadError extends Error {
  override readonly name = 'ChunkLoadError'
}

/** 下载按需加载的代码：失败时换成 ChunkLoadError，错误边界与入口据此认出它（而不是按浏览器各不相同的说明去猜） */
export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  }
  catch (error) {
    throw new ChunkLoadError('按需加载的代码没能下载下来', { cause: error })
  }
}

/** 入口页里的模块脚本（入口与它引用的那些）：部署一次，带哈希的文件名就变一次 */
function moduleScriptsOf(root: ParentNode): string {
  return [...root.querySelectorAll('script[type="module"][src]')].map(script => script.getAttribute('src')).join(' ')
}

/**
 * 服务端现在的入口页与这个页面加载时的比：deployed 是部署了新版本（version 是新版本的入口脚本）；
 * same 是没有变（服务端连得上、版本也没变，是分块本身没下载下来：一时的网络抖动，或者服务器上缺了这个文件）；
 * unreachable 是连不上我们的服务端（断网、服务端挂起超过时限、取回来的不是入口页，例如代理或认证网关自己的页面）
 */
export type DeploymentCheck
  = | { readonly kind: 'deployed', readonly version: string }
    | { readonly kind: 'same' | 'unreachable' }

/**
 * 向服务端要入口页最多等多久（M2-P6 复核第二批 G-4）：服务端挂起时不一直停在"正在打开页面"的骨架屏上。
 * 入口页很小、不经过数据库，正常几百毫秒就回来；超过这个时限按连不上处理，说明之后可以重试
 */
export const DEPLOYMENT_CHECK_TIMEOUT_MS = 10_000

/**
 * 向服务端要一次入口页（不走缓存），看入口脚本还是不是这个页面加载的那几个。
 * 入口页本身是 no-store 的（apps/api 的 web-hosting），带哈希的资源长期缓存：部署之后旧页面要的分块已经不在了。
 * 取回来的页面里没有模块脚本：那不是我们的入口页（代理的错误页、认证网关的登录页常常也是 200），按连不上处理，
 * 不当成部署了新版本去整页重新加载
 */
export async function checkDeployment(currentDocument: Document = document, timeoutMs: number = DEPLOYMENT_CHECK_TIMEOUT_MS): Promise<DeploymentCheck> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let html: string
  try {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'text/html' }, signal: controller.signal })
    if (!response.ok)
      return { kind: 'unreachable' }
    html = await response.text()
  }
  catch {
    return { kind: 'unreachable' }
  }
  finally {
    clearTimeout(timer)
  }
  const deployed = moduleScriptsOf(new DOMParser().parseFromString(html, 'text/html'))
  if (deployed === '')
    return { kind: 'unreachable' }
  return deployed !== moduleScriptsOf(currentDocument) ? { kind: 'deployed', version: deployed } : { kind: 'same' }
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

/**
 * 分块没能下载下来的原因（说明用，路由级与组件级共用）：连不上服务器（offline：断网、服务端挂起、取回来的不是入口页）；
 * 服务器连得上、版本也没变，分块本身下载不下来（missing）；服务器上已经是新版本，这个页面却还是旧的（updated，M2-P6 复核第三批 G-c）。
 * updated 不能说成"版本也没有变"
 */
export type ChunkProblem = 'offline' | 'missing' | 'updated'

/**
 * 判断分块为什么没能下载下来：向服务端要一次入口页（有时限，checkDeployment）。部署了新版本时先交给 onDeployed：
 * 路由级的页面整页重新加载一次换上新版本（reloadOnceForDeployment），已经发起时兑现为 undefined——页面马上就换了，不必说明；
 * 没有给 onDeployed（组件级：页面上可能有用户正在做的事，不自动整页重新加载）或者没能自动换上时是 updated
 */
export async function diagnoseChunkLoad(onDeployed?: (version: string) => boolean): Promise<ChunkProblem | undefined> {
  const check = await checkDeployment()
  if (check.kind === 'deployed')
    return onDeployed?.(check.version) === true ? undefined : 'updated'
  return check.kind === 'unreachable' ? 'offline' : 'missing'
}

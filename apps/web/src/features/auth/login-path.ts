/** 登录页的地址：from 是登录后回到的地址，reason 说明为什么要登录（过期时提示）。 */
export type LoginReason = 'required' | 'expired'

export const LOGIN_PATH = '/login'

export function loginPath(from: string | undefined, reason: LoginReason = 'required'): string {
  const params = new URLSearchParams()
  const target = from === undefined ? undefined : safeRedirectPath(from)
  if (target !== undefined && target !== '/')
    params.set('from', target)
  if (reason === 'expired')
    params.set('reason', 'expired')
  const query = params.toString()
  return query === '' ? LOGIN_PATH : `${LOGIN_PATH}?${query}`
}

/** 是不是登录页。路由的匹配不区分大小写，也不管末尾的斜杠，这里一样 */
export function isLoginPage(pathname: string): boolean {
  return pathname.toLowerCase().replace(/\/+$/, '') === LOGIN_PATH
}

/** 控制字符与空白：浏览器解析地址时会去掉制表符与换行，/\t/evil.example 就成了 //evil.example（00 号计划书 §11.3：含控制字符一律拒绝） */
const CONTROL_OR_SPACE = /[\s\p{Cc}]/u

/**
 * 登录后可以回去的站内地址，防开放重定向；不安全时返回 undefined。
 * 按浏览器解析的结果判断，而不是按字符串的前缀（审查 B5）：以 / 开头、没有控制字符与空白，相对本站解析之后仍在本站，
 * 而且不是登录页本身。返回解析后的规范写法（路径、查询与片段）。
 * 解析会去掉 . 与 .. 这样的路径段、把反斜杠换成斜杠：/.//evil.example、/x/..//evil.example、/./\evil.example
 * 解析之后的路径都是 //evil.example，它再被当作地址使用时就是另一个站点（协议相对的地址），同样拒绝（复验 R1）。
 */
export function safeRedirectPath(path: string): string | undefined {
  if (!path.startsWith('/') || CONTROL_OR_SPACE.test(path))
    return undefined
  const site = window.location.origin
  let url: URL
  try {
    url = new URL(path, site)
  }
  catch {
    return undefined
  }
  if (url.origin !== site || url.pathname.startsWith('//') || isLoginPage(url.pathname))
    return undefined
  return `${url.pathname}${url.search}${url.hash}`
}

/** 登录后去哪里：from 合法就回去，否则去首页。 */
export function redirectTarget(from: string | null): string {
  return (from === null ? undefined : safeRedirectPath(from)) ?? '/'
}

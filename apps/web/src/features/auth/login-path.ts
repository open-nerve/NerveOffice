/** 登录页的地址：from 是登录后回到的地址，reason 说明为什么要登录（过期时提示）。 */
export type LoginReason = 'required' | 'expired'

export function loginPath(from: string | undefined, reason: LoginReason = 'required'): string {
  const params = new URLSearchParams()
  if (from !== undefined && from !== '/' && isSafeRedirect(from))
    params.set('from', from)
  if (reason === 'expired')
    params.set('reason', 'expired')
  const query = params.toString()
  return query === '' ? '/login' : `/login?${query}`
}

/** 只接受站内的路径：以 / 开头，不是 //（协议相对地址）或 /\，也不是登录页本身。防开放重定向 */
export function isSafeRedirect(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') && !path.startsWith('/login')
}

/** 登录后去哪里：from 合法就回去，否则去首页。 */
export function redirectTarget(from: string | null): string {
  return from !== null && isSafeRedirect(from) ? from : '/'
}

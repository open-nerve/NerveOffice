// 编辑器页的请求缓存：编辑器页没有平台页面的请求缓存，页头（EditorChrome 在最外层提供）给分享对话框与确认框一个自己的，
// 默认选项与平台页面相同；请求得到未登录或令牌失效时交给本页的会话确认。
import type { EditorPage } from './editor-page.ts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isAuthenticationError, isCsrfTokenError } from '../../shared/api/index.ts'
import { QUERY_CLIENT_DEFAULTS } from '../../shared/api/query-defaults.ts'

/** 请求得到未登录或令牌失效时，向服务端确认会话（与别的标签页登录或退出时同一个确认），页头随之说明 */
export function editorQueryClient(page: EditorPage): QueryClient {
  const onError = (error: unknown): void => {
    if (isAuthenticationError(error) || isCsrfTokenError(error))
      void page.recheckSession()
  }
  return new QueryClient({ queryCache: new QueryCache({ onError }), mutationCache: new MutationCache({ onError }), defaultOptions: QUERY_CLIENT_DEFAULTS })
}

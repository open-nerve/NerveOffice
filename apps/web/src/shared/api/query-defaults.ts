// 请求缓存（TanStack Query）的默认选项：平台页面的请求缓存（app/query-client.ts）与编辑器页给分享对话框用的请求缓存
// （features/sheet-editor/share-entry.tsx，M2-P5）共用，两处的请求按同样的规则重试、断网时同样照常发出。
// 不经 shared/api/index.ts 转出：用到的地方按路径引用。
import type { DefaultOptions } from '@tanstack/react-query'
import { isTransientError } from './client.ts'

/** 网络问题与服务端的临时错误重试一次；其他错误（4xx）重试也没用 */
const MAX_TRANSIENT_RETRIES = 1

/**
 * networkMode 'always'：不看 navigator.onLine，断网时请求照常发出、照常失败，由请求层归为 NetworkError 显示出来（审查 B4）。
 * 默认的 'online' 在浏览器认为离线时把查询与变更挂起，界面一直停在"进行中"：退出时尤其危险，请求根本没发出去，会话仍然有效。
 * navigator.onLine 本身也不可靠：连着局域网、却到不了服务器时它仍是 true。
 * 变更不自动重试：写操作的结果未知之后由界面按共用的做法刷新、说明（shared/api/write-outcome.ts）
 */
export const QUERY_CLIENT_DEFAULTS: DefaultOptions = {
  queries: {
    networkMode: 'always',
    retry: (failures, error) => isTransientError(error) && failures < MAX_TRANSIENT_RETRIES,
    refetchOnWindowFocus: false,
  },
  mutations: { networkMode: 'always', retry: false },
}

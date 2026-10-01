export { ApiError, apiFetch, apiRequest, isAccessDenied, isAuthenticationError, isCsrfTokenError, isDefiniteRejection, isMissingResource, isNotFoundError, isPermissionDeniedError, isTransientError, isUnknownOutcome, NetworkError, readJson, ResponseFormatError, setCsrfToken } from './client.ts'
export type { HttpMethod, RawRequestOptions, RequestOptions } from './client.ts'
export { describeError } from './describe-error.ts'
export type { ErrorDescription } from './describe-error.ts'
export { requestSession } from './session.ts'
// 只给平台页面用的两个模块不经这里转出，用到的地方按路径引用：request-ids.ts（带 requestId 的新建的记账）、write-outcome.ts（写操作结果未知之后的共用做法）。
// 编辑器页也引用这个文件，经这里转出它们就进了两个入口共用的块；实测（vite 8.3 / rolldown 1.2）这会让平台页面的入口多出两个小块
// （共用的 react-router 等不再并进入口块，另有一个运行时的块），首屏多约 0.4 KiB（M2-P6 复核第二批）

/**
 * 编辑器页的地址：/documents/<文档 id>（P4 设计 §3.8）。最后一段是 UUID，不带点。
 * 服务端托管按它把请求交给编辑器页（editor.html）；平台页面的列表、新建与登录后的跳转按它整页打开编辑器页。
 * 只认 UUID 的写法（8-4-4-4-12 位十六进制）；是不是合法的文档 id 由接口判断。
 */
export const DOCUMENT_PAGE_PATTERN = /^\/documents\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i

export function documentPagePath(documentId: string): string {
  return `/documents/${documentId}`
}

/** 编辑器页地址里的文档 id；不是编辑器页的地址时为 undefined。 */
export function documentIdFromPagePath(pathname: string): string | undefined {
  return DOCUMENT_PAGE_PATTERN.exec(pathname)?.[1]
}

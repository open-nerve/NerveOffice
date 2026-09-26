import type { RequestHandler } from 'express'

/** M0 定稿的内容安全策略（00 号计划书 §11.3）。放宽要先写 ADR（规范 §6）。 */
export const CONTENT_SECURITY_POLICY = [
  'default-src \'self\'',
  'img-src \'self\' data: blob:',
  'connect-src \'self\'',
  'font-src \'self\'',
  'style-src \'self\' \'unsafe-inline\'',
  'script-src \'self\'',
  'worker-src \'self\'',
  'frame-ancestors \'none\'',
  'base-uri \'self\'',
  'form-action \'self\'',
].join('; ')

/** 对所有响应下发的安全头（P2 设计 §3.6）。 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  // 文档地址不带给任何外部站点
  'Referrer-Policy': 'no-referrer',
  // 与 frame-ancestors 'none' 相同，照顾旧浏览器
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  // 剪贴板保持浏览器的默认（同源可用），编辑器需要
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // 默认不缓存：接口响应都带着用户数据。托管前端产物时，带哈希的静态资源另行设置（P3）
  'Cache-Control': 'no-store',
}

/** 只在 HTTPS 请求上下发；不加 includeSubDomains：自部署时同一域名下可能还有别的服务。 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000'

/** 在任何响应之前写入安全头，所以错误响应、404 也带着。反向代理转发的 HTTPS 经 trust proxy 识别。 */
export function securityHeaders(): RequestHandler {
  return (request, response, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS))
      response.setHeader(name, value)
    if (request.secure)
      response.setHeader('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY)
    next()
  }
}

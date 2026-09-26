import type { RequestHandler } from 'express'
import express from 'express'
import { AppError } from '../../shared/errors/app-error.ts'
import { checkJsonLimits, JSON_MAX_DEPTH, JSON_MAX_ENTRIES } from './json-limits.ts'

/** body-parser 的错误类型 → 统一的错误码与说明（说明不回显请求内容）。 */
const BODY_ERRORS: Readonly<Record<string, (limitBytes: number) => AppError>> = {
  'entity.parse.failed': () => new AppError('REQUEST_INVALID', '请求体不是合法的 JSON'),
  'entity.too.large': limitBytes => new AppError('PAYLOAD_TOO_LARGE', `请求体超过上限（${limitBytes} 字节）`),
  'request.size.invalid': () => new AppError('REQUEST_INVALID', '请求体的长度与声明的不一致'),
  'request.aborted': () => new AppError('REQUEST_INVALID', '请求在传输中被中断'),
  'charset.unsupported': () => new AppError('UNSUPPORTED_MEDIA_TYPE', '请求体的字符集不受支持，只接受 UTF-8'),
  'encoding.unsupported': () => new AppError('UNSUPPORTED_MEDIA_TYPE', '请求体的内容编码不受支持'),
}

/** 解析器的错误换成 AppError；认不出的原样交给异常过滤器（按意外错误处理）。 */
export function toBodyError(error: unknown, limitBytes: number): unknown {
  const type = typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string' ? error.type : undefined
  const create = type === undefined ? undefined : BODY_ERRORS[type]
  return create === undefined ? error : create(limitBytes)
}

/** 只解析 JSON，上限取自配置；解析后检查嵌套深度与元素数量（P2 设计 §3.6）。 */
export function jsonBody(limitBytes: number): RequestHandler {
  const parse = express.json({ limit: limitBytes, strict: true, type: ['application/json', 'application/*+json'] })
  return (request, response, next) => {
    parse(request, response, (error?: unknown) => {
      if (error !== undefined && error !== null) {
        next(toBodyError(error, limitBytes))
        return
      }
      const violation = checkJsonLimits(request.body)
      if (violation === undefined)
        next()
      else
        next(new AppError('PAYLOAD_TOO_LARGE', violation === 'depth' ? `请求体的嵌套超过 ${JSON_MAX_DEPTH} 层` : `请求体的元素超过 ${JSON_MAX_ENTRIES} 个`))
    })
  }
}

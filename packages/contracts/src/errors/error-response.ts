import { z } from 'zod'

/** 错误码：大写字母开头的大写下划线形式，例如 `DOCUMENT_NOT_FOUND`（规范 §2.3）。 */
export const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/)

/**
 * 统一的错误响应（规范 §4）：`{ error: { code, message, requestId } }`。
 * 只允许这三个字段，内部细节（堆栈、SQL 等）不会随响应带给客户端。
 */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

import { z } from 'zod'

/** 错误码：大写字母开头的大写下划线形式，例如 `DOCUMENT_NOT_FOUND`（规范 §2.3）。 */
export const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/)

/**
 * 统一的错误响应（规范 §4）：`{ error: { code, message, requestId } }`。
 * 服务端只发这三个字段，内部细节（堆栈、SQL 等）不随响应带给客户端：集成测试按响应原文核对。
 * 结构是宽松的：将来错误响应加字段时，打开着的旧页面仍然认得错误码（例如未登录时回到登录页）。
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
})

export type ErrorResponse = z.infer<typeof errorResponseSchema>

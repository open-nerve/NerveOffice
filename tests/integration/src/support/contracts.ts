// 按契约原文核对服务端的响应。契约里的响应结构是宽松的：客户端丢弃不认识的字段，接口只做加法时旧页面照常工作。
// 服务端却只能发契约里的字段，多出的字段可能是泄漏的内部细节（规范 §4），所以测试要逐字核对。
import type { z } from 'zod'
import { expect } from 'vitest'

export function parseExact<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.parse(body)
  // 解析丢弃了多出的字段：与原文不同，说明响应带了契约之外的字段
  expect(body, '响应带了契约之外的字段').toEqual(parsed)
  return parsed
}

// 打开自检失败的上报（M3-P4 设计 §3.13，US-M3-15）：POST /api/documents/{id}/open-check-failures 的请求体，服务端严格解析、记日志。
// 失败的种类与写法在 open-check-failures.ts（不引用 zod，编辑器页引用它）；这里只有结构，编辑器页不引用（页面发的是普通的 JSON）。
// 上报只带种类、资源名与异常的构造器名，不带快照、资源的 data 与异常的 message（JSON.parse 的报错带着输入的片段）
import type { OpenCheckFailureKind } from './open-check-failures.ts'
import { z } from 'zod'
import { clientFormatRequiredBodyShape } from './client-format.ts'
import { REVISION_MAX } from './content.ts'
import { ERROR_NAME_PATTERN, OPEN_CHECK_ACCESS, OPEN_CHECK_FAILURE_KINDS, OPEN_CHECK_FAILURES_MAX, OPEN_CHECK_TRIGGERS, RESOURCE_NAME_PATTERN, THROWN_FAILURE_KINDS } from './open-check-failures.ts'

/** 一项失败（请求里，严格）：资源名与构造器名按写法；只有抛错的三种能带构造器名 */
export const openCheckFailureSchema = z.strictObject({
  kind: z.enum(OPEN_CHECK_FAILURE_KINDS),
  resource: z.string().regex(RESOURCE_NAME_PATTERN),
  error: z.string().regex(ERROR_NAME_PATTERN).optional(),
}).refine(
  failure => failure.error === undefined || (THROWN_FAILURE_KINDS as readonly OpenCheckFailureKind[]).includes(failure.kind),
  { message: '只有抛错的种类带异常的构造器名', path: ['error'] },
)

/**
 * 打开自检失败的上报（请求体，严格）：
 * - revision：载入的内容的修订号（ETag 那个）；access、trigger：这一次怎样、为什么创建（open-check-failures.ts 的两个枚举）；
 * - failures：1–32 项；
 * - clientBuild、univerVersion、profile、formatVersion：页面的构建与数据格式，必填（client-format.ts 的 clientFormatRequiredBodyShape）。
 * 不带快照、资源的 data、异常的 message；多出的字段一律 400
 */
export const openCheckReportSchema = z.strictObject({
  revision: z.number().int().min(1).max(REVISION_MAX),
  access: z.enum(OPEN_CHECK_ACCESS),
  trigger: z.enum(OPEN_CHECK_TRIGGERS),
  failures: z.array(openCheckFailureSchema).min(1).max(OPEN_CHECK_FAILURES_MAX),
  ...clientFormatRequiredBodyShape,
})

export type OpenCheckReport = z.infer<typeof openCheckReportSchema>

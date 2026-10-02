import type { AuditActionDetails, AuditActionDetailsInput } from '@nerve-office/contracts'
import { AUDIT_TARGET_TYPES, auditDetailsSchema } from '@nerve-office/contracts'
import { z } from 'zod'

/** 客户端地址：数据库的 inet 能存的 IPv4 或 IPv6（不带作用域）。 */
export const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

/**
 * 审计事件的来源：HTTP 请求带请求标识与客户端地址；命令行（例如初始化管理员）与
 * 应用自己的定时任务（modules/jobs，例如到期的回收站清理）没有。
 * 请求标识是服务端自己生成的，不是客户端带来的 X-Request-Id（M2-P6 复核 C2，见 logging/request-id.ts）。
 */
export const auditOriginSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('http'), requestId: z.string().min(1).max(128), clientIp: clientIpSchema.optional() }),
  z.strictObject({ source: z.literal('cli') }),
  z.strictObject({ source: z.literal('job') }),
])

/** 审计事件里动作与明细之外的部分：谁、对什么、从哪里来（P2 设计 §3.8） */
export const auditEnvelopeSchema = z.strictObject({
  actor: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('user'), id: z.uuid() }),
    z.strictObject({ type: z.literal('system') }),
    z.strictObject({ type: z.literal('anonymous') }),
  ]),
  target: z.strictObject({ type: z.enum(AUDIT_TARGET_TYPES), id: z.uuid() }).optional(),
  origin: auditOriginSchema,
})

export type AuditOrigin = z.infer<typeof auditOriginSchema>

/**
 * 写审计时给的事件：动作与明细按动作区分（contracts 的 auditDetailsSchema，M2-P6 复核 M-1），
 * 明细里没有必填字段的动作可以不给 details。明细不含正文、标题、名称、密码与令牌（规范 §6、M2 总设计 §2.1 第 5 条）。
 */
export type AuditEvent = z.input<typeof auditEnvelopeSchema> & AuditActionDetailsInput

/** 校验之后的事件：明细一定有（没给时是空对象） */
export type ValidAuditEvent = z.output<typeof auditEnvelopeSchema> & AuditActionDetails

/**
 * 写入之前的校验：动作与明细按 contracts 的严格结构（多一个键、少一个键都拒绝），其余按 auditEnvelopeSchema。
 * 明细的长度由结构本身限住：每个字段都是有界的标量（id、份数、原因、有上限的名称），没有数组与嵌套，
 * 最长的也在 AUDIT_DETAILS_MAX_BYTES 之内（contracts 的 audit-details.test.ts 核对）。审计与业务写在同一个事务里，
 * 超长会把整条业务一起回滚（M2-P4 审查 A1），所以不能让明细长度随数据增长。
 */
export function parseAuditEvent(event: AuditEvent): ValidAuditEvent {
  const { action, details, ...envelope } = event
  return { ...auditEnvelopeSchema.parse(envelope), ...auditDetailsSchema.parse({ action, details: details ?? {} }) }
}

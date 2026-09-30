import { Buffer } from 'node:buffer'
import { AUDIT_DETAILS_MAX_BYTES, AUDIT_TARGET_TYPES, auditActionSchema } from '@nerve-office/contracts'
import { z } from 'zod'

/** 客户端地址：数据库的 inet 能存的 IPv4 或 IPv6（不带作用域）。 */
export const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

/**
 * 审计事件的来源：HTTP 请求带请求标识与客户端地址；命令行（例如初始化管理员）与
 * 应用自己的定时任务（modules/jobs，例如到期的回收站清理）没有。
 */
export const auditOriginSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('http'), requestId: z.string().min(1).max(128), clientIp: clientIpSchema.optional() }),
  z.strictObject({ source: z.literal('cli') }),
  z.strictObject({ source: z.literal('job') }),
])

/**
 * details 里每个键的值：只能是标量（字符串、数字、布尔、null）。
 *
 * 为什么不收 z.json()（数组与嵌套对象）：那些的长度没有上界，很容易越过 AUDIT_DETAILS_MAX_BYTES，
 * 而审计与业务写在同一个事务里，校验不过会把整条业务事务一起回滚成 500（M2-P4 审查 A1）。
 * 要记"哪几个"时记份数或别的有界的标量，别把清单原样塞进来（例如连带删除只记 cascadedEntries 的条数）。
 * 下面的字节上限是第二道：单个字符串同样可能很长。
 */
const auditDetailSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

/**
 * 审计事件（P2 设计 §3.8）：写入之前按这个结构校验。
 * details 只放不敏感的补充信息，不含正文、密码与令牌（规范 §6）。
 */
export const auditEventSchema = z.strictObject({
  action: auditActionSchema,
  actor: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('user'), id: z.uuid() }),
    z.strictObject({ type: z.literal('system') }),
    z.strictObject({ type: z.literal('anonymous') }),
  ]),
  target: z.strictObject({ type: z.enum(AUDIT_TARGET_TYPES), id: z.uuid() }).optional(),
  origin: auditOriginSchema,
  details: z.record(z.string(), auditDetailSchema)
    .refine(details => Buffer.byteLength(JSON.stringify(details)) <= AUDIT_DETAILS_MAX_BYTES, `details 超过 ${AUDIT_DETAILS_MAX_BYTES} 字节`)
    .optional(),
})

export type AuditOrigin = z.infer<typeof auditOriginSchema>
export type AuditEvent = z.input<typeof auditEventSchema>
export type ValidAuditEvent = z.output<typeof auditEventSchema>

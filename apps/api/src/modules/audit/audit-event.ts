import { Buffer } from 'node:buffer'
import { AUDIT_DETAILS_MAX_BYTES, AUDIT_TARGET_TYPES, auditActionSchema } from '@nerve-office/contracts'
import { z } from 'zod'

/** 客户端地址：数据库的 inet 能存的 IPv4 或 IPv6（不带作用域）。 */
export const clientIpSchema = z.union([z.ipv4(), z.ipv6()])

/** 审计事件的来源：HTTP 请求带请求标识与客户端地址；命令行（例如初始化管理员）没有。 */
export const auditOriginSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('http'), requestId: z.string().min(1).max(128), clientIp: clientIpSchema.optional() }),
  z.strictObject({ source: z.literal('cli') }),
])

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
  details: z.record(z.string(), z.json())
    .refine(details => Buffer.byteLength(JSON.stringify(details)) <= AUDIT_DETAILS_MAX_BYTES, `details 超过 ${AUDIT_DETAILS_MAX_BYTES} 字节`)
    .optional(),
})

export type AuditOrigin = z.infer<typeof auditOriginSchema>
export type AuditEvent = z.input<typeof auditEventSchema>
export type ValidAuditEvent = z.output<typeof auditEventSchema>

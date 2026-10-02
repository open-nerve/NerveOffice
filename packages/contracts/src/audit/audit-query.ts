import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from './audit.ts'

/**
 * 查询条件里的时刻：ISO 8601（UTC），年份至少是 1。z.iso.datetime 与 JavaScript 的 Date 都接受 0 年，
 * PostgreSQL 没有 0 年，查询会报错变成 500（M2-P1 审查 A4，与 P3 审查 A3 同类）
 */
const instantSchema = z.iso.datetime().refine(value => !value.startsWith('0000'), '年份至少是 1')

/**
 * 审计查询（GET /api/admin/audit-events，M2-P1 设计 §3.7）：只给系统管理员。
 * 条件之间是"并且"；按时间与 id 倒序，游标是服务端给出的不透明字符串。
 */
export const auditEventQuerySchema = z.strictObject({
  /** 含 */
  from: instantSchema.optional(),
  /** 不含 */
  to: instantSchema.optional(),
  actorId: uuidSchema.optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  targetId: uuidSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
})

export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>

/** 一个账户当前的登录名与显示名：分开给出，界面分别呈现（显示名是本人填的，可以写成"李四（lisi）"，M2-P6 复核 M2） */
export const auditUserNameSchema = z.object({
  username: z.string(),
  displayName: z.string(),
})

export type AuditUserName = z.infer<typeof auditUserNameSchema>

/**
 * 一条审计事件。响应的结构宽松：动作、对象类型等不按已知的取值校验，以后新增的取值在旧页面上照样能显示。
 * 账户（操作者与对象）另给出当前的登录名与显示名，邀请给出登录名；审计表本身只有 id。
 */
export const auditEventItemSchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  action: z.string(),
  actor: z.object({
    type: z.string(),
    id: z.uuid().nullable(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  target: z.object({
    type: z.string(),
    id: z.uuid(),
    /**
     * 不是账户的对象能补上的名字：邀请是被邀请的登录名，空间是当前的名称；文档不补标题（M2 总设计 §2.1 第 5 条），其他为空。
     * 账户不在这里：用 user（登录名与显示名分开给出）。原来的 label 对账户给的是拼好的"显示名（登录名）"，显示名冒充得了登录名；
     * 它只为打开着的旧页面保留，v0.1 还没有部署、没有旧页面，M2-P6 第 6 片复核 S2 删掉它（DEF-034）
     */
    name: z.string().nullable(),
    /** 对象是账户时它当前的登录名与显示名（分开给出，M2-P6 复核 M2）；不是账户、或者账户已经不在时为空 */
    user: auditUserNameSchema.nullable(),
  }).nullable(),
  source: z.string(),
  requestId: z.string().nullable(),
  clientIp: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
})

export type AuditEventItem = z.infer<typeof auditEventItemSchema>

export const auditEventListResponseSchema = z.object({
  items: z.array(auditEventItemSchema),
  nextCursor: z.string().nullable(),
})

export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>

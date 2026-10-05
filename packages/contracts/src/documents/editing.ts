// 编辑租约（M3-P1 设计 §3.2）：同一时刻只有一个标签页能写一份文档。申请、心跳续租、释放与编辑状态的契约。
// 时间一律由数据库给出（UTC 的 ISO 8601）；页面不拿自己的时钟去比它们，"多久没有操作"只报相对的秒数（M3 总设计 §2.1）。
import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { userSummarySchema } from '../users/users.ts'
import { clientFormatBodyShape } from './client-format.ts'
import { revisionSourceSchema } from './content.ts'

/**
 * 有效期（秒）：申请与每次心跳续租时，到期时间是数据库的 now() 加上它（00 号计划书 §6.2，r13）。
 * 有效期与心跳间隔都是起始参数，经网络波动、后台标签页与休眠的测试之后再调整（M3 总设计 §6.1）
 */
export const EDIT_LEASE_TTL_SECONDS = 90

/** 心跳的间隔（秒）：有效期内能重试好几次；P5 的交接消息随心跳送达，请求编辑最多约 10 秒就能送到持有者（M3 总设计 §2.1） */
export const EDIT_LEASE_HEARTBEAT_SECONDS = 10

/** 服务端的兜底回收（秒）：最后活动时间距今满 12 分钟，租约按空闲失效（页面自己在 10 分钟时先保存再释放，P5） */
export const EDIT_LEASE_IDLE_RECLAIM_SECONDS = 720

/** 上一个租约异常结束之后的这段时间里（秒），申请编辑时给出提醒（US-M3-10）：30 分钟 */
export const EDIT_INTERRUPTION_NOTICE_SECONDS = 1800

/**
 * 心跳上报的"多久没有操作"的上限（秒）：一天。空闲再久与一天没有区别（早已超过兜底回收），上限只挡住不合理的数；
 * 页面空闲超过它时按它上报
 */
export const EDIT_IDLE_SECONDS_MAX = 86_400

/**
 * 令牌经这个请求头传递（心跳、释放、保存）：不进地址与日志（规范 §4；日志本来就不记请求头）。
 * HTTP 头名不区分大小写，写成小写，与 CSRF_TOKEN_HEADER 一致：Node 收到的请求头名都是小写，服务端按它读
 */
export const EDIT_LEASE_HEADER = 'x-edit-lease'

/**
 * 令牌：32 字节安全随机数的 base64url（不带填充），43 个字符，与会话令牌同样的强度。只在申请的响应里出现一次，
 * 页面放在内存里；服务端只存它的 SHA-256 摘要。请求头里的令牌按它校验，格式不对是 REQUEST_INVALID
 */
export const editLeaseTokenSchema = z.string().regex(/^[\w-]{43}$/)

/**
 * 申请编辑权（POST /api/documents/{id}/edit-lease，要能编辑）：clientInstanceId 是编辑器页每次加载生成的标识
 * （保存一直带着它），租约绑定它与这次登录。客户端的构建与数据格式（clientBuild、univerVersion、profile、formatVersion，
 * M3-P3 设计 §3.5）可选：过旧的页面不让进入编辑（CLIENT_OUTDATED），缺了由服务端按过旧处理
 */
export const acquireEditLeaseRequestSchema = z.strictObject({
  clientInstanceId: uuidSchema,
  ...clientFormatBodyShape,
})

export type AcquireEditLeaseRequest = z.infer<typeof acquireEditLeaseRequestSchema>

/**
 * 上一个租约异常结束（到期、空闲回收、登录失效，不是释放或收回）的提醒，只在结束之后 30 分钟以内给出（P1 设计 §3.4.5）：
 * 上一位持有者与结束的时间（他最近一次续租的时间）。本 Phase 只给出，提示的界面在 P5
 */
export const editInterruptionSchema = z.object({
  holder: userSummarySchema,
  endedAt: z.iso.datetime(),
})

export type EditInterruption = z.infer<typeof editInterruptionSchema>

/**
 * 申请成功（201）：
 * - token：之后的心跳、释放与保存经 EDIT_LEASE_HEADER 带上它；
 * - writeEpoch：这一代的代次（申请时文档的代次加一，所以至少是 1），保存时作为查询参数带上；
 * - revision：文档当前的修订号，页面拿它与自己载入的比较（落后就先重新加载，P2）；
 * - source：文档当前修订的来源——产生它的那次保存的标签页与本地序号；当前修订是新建、复制出来的，或者不是调用者本人保存的，为 null。
 *   续上时（编辑权中断之后同一个页面重新申请），修订号比本页的基准新，页面据此认出期间的那一版是不是本页自己一次结果未知的保存：
 *   是的话以它为基准接着编辑，不当成别处的修改（00 号计划书 §7.5）。取法与修订号冲突的详情相同；
 * - expiresAt：到期时间；interruption：上一个租约异常结束的提醒，没有时为 null；
 * - formulasPending：文档的"公式待更新"（M3-P3 设计 §3.8，最近一次写入时页面带来的标记）：P4 据此在进入编辑时先全量重算。
 * 响应的结构宽松（多出的字段被丢弃），见 auth 的会话信息
 */
export const acquiredEditLeaseSchema = z.object({
  token: editLeaseTokenSchema,
  writeEpoch: z.number().int().min(1),
  revision: z.number().int().min(1),
  source: revisionSourceSchema.nullable(),
  expiresAt: z.iso.datetime(),
  interruption: editInterruptionSchema.nullable(),
  formulasPending: z.boolean(),
})

export type AcquiredEditLease = z.infer<typeof acquiredEditLeaseSchema>

/**
 * 心跳续租（PUT /api/documents/{id}/edit-lease，要能编辑，带令牌）：idleSeconds 是距离本页最后一次键盘、鼠标操作的秒数，
 * 服务端据此算出最后活动时间（不早于申请的时间、不晚于数据库的 now()），空闲满 12 分钟就回收。
 * 客户端的构建与数据格式与申请相同、可选（M3-P3 设计 §3.5）：服务端升级之后，正在编辑的页面在一次心跳之内就知道需要刷新
 */
export const renewEditLeaseRequestSchema = z.strictObject({
  idleSeconds: z.number().int().min(0).max(EDIT_IDLE_SECONDS_MAX),
  ...clientFormatBodyShape,
})

export type RenewEditLeaseRequest = z.infer<typeof renewEditLeaseRequestSchema>

/** 续租成功（200）：新的到期时间 */
export const renewedEditLeaseSchema = z.object({
  expiresAt: z.iso.datetime(),
})

export type RenewedEditLease = z.infer<typeof renewedEditLeaseSchema>

/**
 * 正在编辑这份文档的人：持有者（"人"的结构，界面经人名组件显示）、他的最后活动时间，以及他是不是调用者自己
 * （sameUser：在别的标签页或设备上，P5 据此给出"在此编辑"）。编辑状态的 editor 与 EDIT_LEASE_HELD 的 details 同形
 */
export const documentEditorSchema = z.object({
  holder: userSummarySchema,
  lastActiveAt: z.iso.datetime(),
  sameUser: z.boolean(),
})

export type DocumentEditor = z.infer<typeof documentEditorSchema>

/**
 * 编辑状态（GET /api/documents/{id}/edit-lease，能读就能看，在只读快照里读，ADR-017）：文档当前的修订号，
 * 正在编辑的人——没有有效的租约时为 null，调用者现在能不能编辑这份文档（canEdit，M3-P2 设计 §3.2：与详情的
 * permissions.canEdit 同一个规则、同一个快照里算；阅读页每 30 秒读一次，据此显示或隐藏"编辑"——权限在阅读期间可能变化），
 * 以及文档的"公式待更新"（formulasPending，M3-P3 设计 §3.8：阅读页据此说明公式结果可能还没更新，P4）
 */
export const editStatusSchema = z.object({
  revision: z.number().int().min(1),
  editor: documentEditorSchema.nullable(),
  canEdit: z.boolean(),
  formulasPending: z.boolean(),
})

export type EditStatus = z.infer<typeof editStatusSchema>

/** 有效的租约在别人手里（EDIT_LEASE_HELD）的详情：正在编辑的人（documentEditorSchema） */
export const editLeaseHeldDetailsSchema = documentEditorSchema

export type EditLeaseHeldDetails = z.infer<typeof editLeaseHeldDetailsSchema>

/**
 * 编辑权失效的原因（EDIT_LEASE_LOST 的 details，P1 设计 §3.4.1；按有效条件的顺序，第一条不满足的就是原因）：
 * - none：没有租约（没有这一行，或者请求没带令牌）；
 * - replaced：令牌对不上，这份文档已经是新的一代（别人，或者自己在别的标签页、设备上接手了）；
 * - released：已经释放；revoked：编辑权被收回（明确收回，或者持有者已经不能编辑）；
 * - stale：代次过时（删除、跨空间移动、转移、收回写入权之后）；
 * - expired：到期；idle：空闲满 12 分钟被服务端回收；
 * - session：绑定的登录已经失效，或者请求的登录、标签页不是租约绑定的那一个。
 * released、revoked 同时是租约行上记下的明确结束的原因（document_edit_leases.end_reason）。
 * 失去访问（404）与失去编辑权（403）先于租约判断，不在这里
 */
export const EDIT_LEASE_LOST_REASONS = ['none', 'replaced', 'released', 'revoked', 'stale', 'expired', 'idle', 'session'] as const
export type EditLeaseLostReason = (typeof EDIT_LEASE_LOST_REASONS)[number]

/**
 * EDIT_LEASE_LOST 的详情。以后的 Phase 会加原因（P5 的交接），而响应的结构是宽松的（请求严格、响应宽松，架构总览 §3）：
 * 不认识的原因（以及缺少原因）解析成 undefined，不让整个解析失败，页面按通用的"编辑权已失效"处理
 */
export const editLeaseLostDetailsSchema = z.object({
  reason: z.enum(EDIT_LEASE_LOST_REASONS).optional().catch(undefined),
})

export type EditLeaseLostDetails = z.infer<typeof editLeaseLostDetailsSchema>

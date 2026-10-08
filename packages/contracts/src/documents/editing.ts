// 编辑租约（M3-P1 设计 §3.2）：同一时刻只有一个标签页能写一份文档。申请、心跳续租、释放与编辑状态的契约；
// 交接规则（M3-P5 设计 §3.3）：空闲释放、请求编辑与交出、本人接管、强制接管与异常中断的提醒。
// 时间一律由数据库给出（UTC 的 ISO 8601）；页面不拿自己的时钟去比它们，"多久没有操作"只报相对的秒数（M3 总设计 §2.1）。
import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'
import { localKeyVersionSchema } from '../local-keys/local-keys.ts'
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

/** 服务端的兜底回收（秒）：最后活动时间距今满 12 分钟，租约按空闲失效（页面自己在 10 分钟时先保存再释放，EDIT_IDLE_RELEASE_SECONDS） */
export const EDIT_LEASE_IDLE_RECLAIM_SECONDS = 720

/** 上一个租约异常结束之后的这段时间里（秒），申请编辑时给出提醒（US-M3-10）：30 分钟 */
export const EDIT_INTERRUPTION_NOTICE_SECONDS = 1800

/**
 * 心跳上报的"多久没有操作"的上限（秒）：一天。空闲再久与一天没有区别（早已超过兜底回收），上限只挡住不合理的数；
 * 页面空闲超过它时按它上报
 */
export const EDIT_IDLE_SECONDS_MAX = 86_400

/**
 * 申请（续上）带来的"多久没有操作"的上限（秒，M3-P5 审查 A4）：比服务端的回收阈值少一秒——新的一代的最后活动是申请的时刻减去它，
 * 带到回收阈值（12 分钟）就是一出生就按空闲失效，白加一次代次，还给别人留下一条不实的异常中断提醒，所以超出的 400。
 * 页面只在人在（本页空闲不到回收阈值）时续上，带的是同一刻的空闲，不会超过它
 */
export const EDIT_ACQUIRE_IDLE_SECONDS_MAX = EDIT_LEASE_IDLE_RECLAIM_SECONDS - 1

/**
 * 页面的空闲释放（秒，US-M3-07，00 号计划书 §6.3）：10 分钟没有键盘、鼠标操作，页面先保存再释放编辑权、回到阅读；
 * 没存上就留在编辑，由服务端 12 分钟兜底（EDIT_LEASE_IDLE_RECLAIM_SECONDS）
 */
export const EDIT_IDLE_RELEASE_SECONDS = 600

/** 有人请求编辑时，持有者的页面空闲满它（秒）就先保存再自动交出（US-M3-06，00 号计划书 §6.3）：2 分钟 */
export const EDIT_HANDOVER_IDLE_SECONDS = 120

/** 交出之后编辑权只留给请求方的时长（秒，M3-P5 设计 §3.6）：2 分钟，期间别人申请得到 EDIT_LEASE_RESERVED（强制接管也挡） */
export const EDIT_HANDOVER_RESERVE_SECONDS = 120

/**
 * 请求方停止续期满它（秒）请求就失效（M3-P5 设计 §3.6）：10 分钟。持有者不理会时请求照样一直有效（00 号计划书 §6.3），
 * 只是请求方的页面不在了（崩溃、合盖、被浏览器暂停，pagehide 不一定触发）才失效，免得持有者空闲之后把编辑权交给一个没人的页面
 */
export const EDIT_REQUEST_TTL_SECONDS = 600

/** 等待中的请求方续期请求的间隔（秒）：续期的响应就是请求的现状，交出之后请求方最多约 5 秒就得知 */
export const EDIT_REQUEST_RENEW_SECONDS = 5

/** 同一个浏览器里的交接（M3-P5 设计 §3.7）：正在编辑的标签页回应交接请求的时限（毫秒），没有回应就接手 */
export const EDIT_TAB_HANDOVER_ACK_MS = 3000

/** 同一个浏览器里的交接：回应之后，正在编辑的标签页先保存再交出的时限（毫秒） */
export const EDIT_TAB_HANDOVER_DONE_MS = 20_000

/**
 * 刷新时有在途的保存（M3-P5 设计 §3.7 的 R1）：旧标签页离开时留下记号，新标签页本人接管之前最多等它（毫秒），
 * 那次保存提交了（修订号前进）就不再等
 */
export const EDIT_PENDING_SAVE_WAIT_MS = 30_000

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

/** 本页"多久没有操作"（秒）：0 到一天之间的整数（心跳必带） */
const idleSecondsSchema = z.number().int().min(0).max(EDIT_IDLE_SECONDS_MAX)

/** 申请时（只在续上时带）本页"多久没有操作"（秒）：0 到 EDIT_ACQUIRE_IDLE_SECONDS_MAX 之间的整数，比回收阈值短（M3-P5 审查 A4） */
const acquireIdleSecondsSchema = z.number().int().min(0).max(EDIT_ACQUIRE_IDLE_SECONDS_MAX)

/**
 * 申请时的接管方式（M3-P5 设计 §3.7、§3.8）：
 * - self：本人接管——当前有效的租约就在调用者自己手里（别的标签页、别的设备）时，原子地结束那一代、发新的一代；
 * - force：强制接管——当前有效的租约在别人手里时照样接管，要能强制接管（canTakeOver），记审计。
 * 持有者不符时不起作用（self 遇到别人的租约照常被占用），当前的租约本来就无效时按普通申请处理
 */
export const EDIT_TAKEOVER_MODES = ['self', 'force'] as const
export type EditTakeoverMode = (typeof EDIT_TAKEOVER_MODES)[number]

/**
 * 申请编辑权（POST /api/documents/{id}/edit-lease，要能编辑）：clientInstanceId 是编辑器页每次加载生成的标识
 * （保存一直带着它），租约绑定它与这次登录。客户端的构建与数据格式（clientBuild、univerVersion、profile、formatVersion，
 * M3-P3 设计 §3.5）可选：过旧的页面不让进入编辑（CLIENT_OUTDATED），缺了由服务端按过旧处理。
 * M3-P5（设计 §3.3、§3.5）另有两项可选：takeover——接管方式（EDIT_TAKEOVER_MODES）；idleSeconds——只给续上用，
 * 本页已经空闲的秒数，新的一代的最后活动按它往前推（服务端的空闲兜底计时准确），上限比回收阈值短（EDIT_ACQUIRE_IDLE_SECONDS_MAX）
 */
export const acquireEditLeaseRequestSchema = z.strictObject({
  clientInstanceId: uuidSchema,
  takeover: z.enum(EDIT_TAKEOVER_MODES).optional(),
  idleSeconds: acquireIdleSecondsSchema.optional(),
  ...clientFormatBodyShape,
})

export type AcquireEditLeaseRequest = z.infer<typeof acquireEditLeaseRequestSchema>

/**
 * 上一个租约异常结束（到期、空闲回收、登录失效，不是释放、交出、接管或收回）的提醒，只在结束之后 30 分钟以内给出（P1 设计 §3.4.5）：
 * 上一位持有者、结束的时间（他最近一次续租的时间），以及他是不是调用者自己（sameUser，M3-P5 设计 §3.5：页面据此分别说
 * "上一位编辑者……的会话异常中断"与"你上一次的编辑异常中断"）。申请的结果与编辑状态（没人在编辑时）都带它
 */
export const editInterruptionSchema = z.object({
  holder: userSummarySchema,
  endedAt: z.iso.datetime(),
  sameUser: z.boolean(),
})

export type EditInterruption = z.infer<typeof editInterruptionSchema>

/**
 * 申请的结果里的提醒：另带 samePage——异常结束的那一代绑定的就是这次申请的页面（同一个人、同一个标签页，clientInstanceId 相同）。
 * 本页退出时释放没送到，那一代到期之后本页再进入编辑，服务端照样按事实算异常中断，而本页的修改其实都已存上（没存上的本页自己知道）：
 * 页面在 samePage 时不说。编辑状态（GET）没有页面，它的提醒不带这一项（阅读时页面只说别人那一代的）
 */
export const acquiredEditInterruptionSchema = editInterruptionSchema.extend({
  samePage: z.boolean(),
})

export type AcquiredEditInterruption = z.infer<typeof acquiredEditInterruptionSchema>

/**
 * 申请成功（201）：
 * - token：之后的心跳、释放与保存经 EDIT_LEASE_HEADER 带上它；
 * - writeEpoch：这一代的代次（申请时文档的代次加一，所以至少是 1），保存时作为查询参数带上；
 * - revision：文档当前的修订号，页面拿它与自己载入的比较（落后就先重新加载，P2）；
 * - source：文档当前修订的来源——产生它的那次保存的标签页与本地序号；当前修订是新建、复制出来的，或者不是调用者本人保存的，为 null。
 *   续上时（编辑权中断之后同一个页面重新申请），修订号比本页的基准新，页面据此认出期间的那一版是不是本页自己一次结果未知的保存：
 *   是的话以它为基准接着编辑，不当成别处的修改（00 号计划书 §7.5）。取法与修订号冲突的详情相同；
 * - expiresAt：到期时间；interruption：上一个租约异常结束的提醒（带上是不是这个页面自己的那一代，samePage），没有时为 null；
 * - formulasPending：文档的"公式待更新"（M3-P3 设计 §3.8，最近一次写入时页面带来的标记）：P4 据此在进入编辑时先全量重算。
 * 响应的结构宽松（多出的字段被丢弃），见 auth 的会话信息
 */
export const acquiredEditLeaseSchema = z.object({
  token: editLeaseTokenSchema,
  writeEpoch: z.number().int().min(1),
  revision: z.number().int().min(1),
  source: revisionSourceSchema.nullable(),
  expiresAt: z.iso.datetime(),
  interruption: acquiredEditInterruptionSchema.nullable(),
  formulasPending: z.boolean(),
})

export type AcquiredEditLease = z.infer<typeof acquiredEditLeaseSchema>

/**
 * 心跳续租（PUT /api/documents/{id}/edit-lease，要能编辑，带令牌）：idleSeconds 是距离本页最后一次键盘、鼠标操作的秒数，
 * 服务端据此算出最后活动时间（只前进不后退、不晚于数据库的 now()：续上时带来的空闲不被抹掉，M3-P5 设计 §3.5），空闲满 12 分钟就回收。
 * 客户端的构建与数据格式与申请相同、可选（M3-P3 设计 §3.5）：服务端升级之后，正在编辑的页面在一次心跳之内就知道需要刷新
 */
export const renewEditLeaseRequestSchema = z.strictObject({
  idleSeconds: idleSecondsSchema,
  ...clientFormatBodyShape,
})

export type RenewEditLeaseRequest = z.infer<typeof renewEditLeaseRequestSchema>

/**
 * 持有者收到的待回应的请求编辑（M3-P5 设计 §3.6，心跳的响应带它）：请求的标识（交出与谢绝时带上，对不上就不算数）、
 * 请求方（"人"的结构）与发出的时刻。只给待回应的：已谢绝、已失效的不给
 */
export const pendingEditRequestSchema = z.object({
  id: z.uuid(),
  requester: userSummarySchema,
  requestedAt: z.iso.datetime(),
})

export type PendingEditRequest = z.infer<typeof pendingEditRequestSchema>

/**
 * 续租成功（200）：新的到期时间，与待回应的请求编辑（M3-P5 设计 §3.3：持有者最多约一个心跳周期之后得知；没有时为 null）；
 * 调用者自己当前的本机密钥的版本（M3-P6 设计 §3.6：从没取过时为 null）——正在编辑的页面据此在一个心跳周期之内得知密钥已被吊销
 * （M4 起停止用旧密钥写发件箱、重新取密钥）。M3 的页面解析出它，不保存也不消费
 */
export const renewedEditLeaseSchema = z.object({
  expiresAt: z.iso.datetime(),
  request: pendingEditRequestSchema.nullable(),
  localKeyVersion: localKeyVersionSchema.nullable(),
})

export type RenewedEditLease = z.infer<typeof renewedEditLeaseSchema>

/**
 * 正在编辑的人：持有者（"人"的结构，界面经人名组件显示）、他的最后活动时间、他是不是调用者自己（sameUser：在别的标签页或设备上，
 * P5 据此给出"在此编辑"），以及持有者的租约绑定的是不是调用者这次登录（sameSession，M3-P5 设计 §3.3：同一个浏览器的标签页
 * 共用登录，为真就是"在这个浏览器里"，页面据此查本机锁、走同一个浏览器的交接）。
 * 编辑状态的 editor 与 EDIT_LEASE_HELD 的 details（另带两项，见 editLeaseHeldDetailsSchema）同一个结构
 */
export const documentEditorSchema = z.object({
  holder: userSummarySchema,
  lastActiveAt: z.iso.datetime(),
  sameUser: z.boolean(),
  sameSession: z.boolean(),
})

export type DocumentEditor = z.infer<typeof documentEditorSchema>

/**
 * 有人在请求编辑（M3-P5 设计 §3.6，编辑状态与 EDIT_LEASE_HELD 的详情带它）：请求方、发出的时刻，以及请求方是不是调用者自己（mine）。
 * 只给待回应的；不带请求的标识（交出、谢绝只由持有者经心跳拿到它）
 */
export const editRequestViewSchema = z.object({
  requester: userSummarySchema,
  requestedAt: z.iso.datetime(),
  mine: z.boolean(),
})

export type EditRequestView = z.infer<typeof editRequestViewSchema>

/**
 * 交出之后的保留（M3-P5 设计 §3.6）：编辑权留给了谁（"人"的结构）、留到何时。编辑状态、交出的响应、EDIT_LEASE_RESERVED 的详情
 * 与请求编辑的结果共用
 */
const reservationShape = {
  reservedFor: userSummarySchema,
  reservedUntil: z.iso.datetime(),
}

/**
 * 交出之后编辑权留给了谁（M3-P5 设计 §3.6，编辑状态带它）：留给的人、留到何时，以及留给的是不是调用者自己（mine）。
 * 保留期内除了留给的人，别人申请得到 EDIT_LEASE_RESERVED
 */
export const editReservationSchema = z.object({
  ...reservationShape,
  mine: z.boolean(),
})

export type EditReservation = z.infer<typeof editReservationSchema>

/**
 * 编辑状态（GET /api/documents/{id}/edit-lease，能读就能看，在只读快照里读，ADR-017）：
 * - revision：文档当前的修订号；editor：正在编辑的人，没有有效的租约时为 null；
 * - canEdit：调用者现在能不能编辑这份文档（M3-P2 设计 §3.2：与详情的 permissions.canEdit 同一个规则、同一个快照里算；阅读页每 30 秒
 *   读一次，据此显示或隐藏"编辑"——权限在阅读期间可能变化）；canTakeOver：调用者能不能强制接管（M3-P5，与 permissions.canTakeOver 同一位）；
 * - formulasPending：文档的"公式待更新"（M3-P3 设计 §3.8：阅读页据此说明公式结果可能还没更新，P4）；
 * - request：有人在请求编辑（待回应的），没有时为 null；reservation：交出之后的保留，没有时为 null；
 * - interruption：没人在编辑、上一个租约异常结束在 30 分钟以内时的提醒（M3-P5 设计 §3.5：阅读页不必等点"编辑"），没有时为 null
 */
export const editStatusSchema = z.object({
  revision: z.number().int().min(1),
  editor: documentEditorSchema.nullable(),
  canEdit: z.boolean(),
  canTakeOver: z.boolean(),
  formulasPending: z.boolean(),
  request: editRequestViewSchema.nullable(),
  reservation: editReservationSchema.nullable(),
  interruption: editInterruptionSchema.nullable(),
})

export type EditStatus = z.infer<typeof editStatusSchema>

/**
 * 有效的租约在别人手里（EDIT_LEASE_HELD）的详情：正在编辑的人（与编辑状态的 editor 同一个结构），另带调用者能不能强制接管
 * （canTakeOver）与有没有人在请求编辑（request，M3-P5 设计 §3.3）：页面据此给出"请求编辑""强制接管"或"在此编辑"
 */
export const editLeaseHeldDetailsSchema = documentEditorSchema.extend({
  canTakeOver: z.boolean(),
  request: editRequestViewSchema.nullable(),
})

export type EditLeaseHeldDetails = z.infer<typeof editLeaseHeldDetailsSchema>

/**
 * 编辑权失效的原因（EDIT_LEASE_LOST 的 details，P1 设计 §3.4.1；按有效条件的顺序，第一条不满足的就是原因）：
 * - none：没有租约（没有这一行，或者请求没带令牌）；
 * - replaced：令牌对不上，这份文档已经是新的一代（别人，或者自己在别的标签页、设备上申请过）；
 * - taken_over：令牌对不上，而新的一代正是接管了请求的这一代（M3-P5：本人在别处接手，或空间管理员强制接管，details.forced 区分）；
 * - released：已经释放；revoked：编辑权被收回（明确收回，或者持有者已经不能编辑）；handed_over：已经交给了请求编辑的人（M3-P5）；
 * - stale：代次过时（删除、跨空间移动、转移、收回写入权之后）；
 * - expired：到期；idle：空闲满 12 分钟被服务端回收；
 * - session：绑定的登录已经失效，或者请求的登录、标签页不是租约绑定的那一个。
 * released、revoked、handed_over 同时是租约行上记下的明确结束的原因（document_edit_leases.end_reason）。
 * 页面不续上 taken_over 与 handed_over（编辑权是有意交给别处的，续上就是抢回来）。
 * 失去访问（404）与失去编辑权（403）先于租约判断，不在这里
 */
export const EDIT_LEASE_LOST_REASONS = ['none', 'replaced', 'taken_over', 'released', 'revoked', 'handed_over', 'stale', 'expired', 'idle', 'session'] as const
export type EditLeaseLostReason = (typeof EDIT_LEASE_LOST_REASONS)[number]

/**
 * EDIT_LEASE_LOST 的详情：原因，被接管时另有 forced（M3-P5：空间管理员强制接管为真，本人在别处接手为假；别的原因不带）。
 * 响应的结构是宽松的（请求严格、响应宽松，架构总览 §3）：以后的 Phase 还会加原因，不认识的原因（以及缺少原因）解析成 undefined，
 * forced 不是布尔值时同样当作没有，不让整个解析失败，页面按通用的"编辑权已失效"处理
 */
export const editLeaseLostDetailsSchema = z.object({
  reason: z.enum(EDIT_LEASE_LOST_REASONS).optional().catch(undefined),
  forced: z.boolean().optional().catch(undefined),
})

export type EditLeaseLostDetails = z.infer<typeof editLeaseLostDetailsSchema>

/**
 * 发出请求编辑（POST /api/documents/{id}/edit-lease/request，要能编辑，M3-P5 设计 §3.4、§3.6）：请求体只有页面上报的构建与数据格式，
 * 过旧的页面先拦下（CLIENT_OUTDATED），免得编辑权交给一个之后申请不了的页面。请求方与登录取自会话，不由请求给出
 */
export const requestEditRequestSchema = z.strictObject({
  ...clientFormatBodyShape,
})

export type RequestEditRequest = z.infer<typeof requestEditRequestSchema>

/**
 * 请求编辑的结果（M3-P5 设计 §3.3、§3.6）：发出（POST）与续期（PUT …/request，等待中的页面每 EDIT_REQUEST_RENEW_SECONDS 秒一次）的响应，
 * 按 kind 区分：
 * - pending：在等待——请求的标识、发出的时刻、有效期（续期往后推）与正在编辑的人；
 * - declined：持有者选择继续编辑，请求已取消（只有请求方自己的续期得知）；
 * - reserved：已经交给你了，留到 reservedUntil——立即申请；
 * - free：没人在编辑——立即申请；
 * - self：正在编辑的是你自己（别的标签页或设备）——改用本人接管；
 * - occupied：别人先请求了（单槽、先到先得）——请求方与发出的时刻；
 * - reservedForOther：编辑权刚交给了别人，留到 reservedUntil；
 * - gone：只出现在续期——我的请求已不在（换了一代、过期），附现在正在编辑的人（没有时为 null）。
 * 每一种的结构宽松（多出的字段被丢弃）；不认识的 kind 整个解析失败
 */
export const editRequestOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), id: z.uuid(), requestedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), holder: documentEditorSchema }),
  z.object({ kind: z.literal('declined'), id: z.uuid(), holder: documentEditorSchema }),
  z.object({ kind: z.literal('reserved'), reservedUntil: z.iso.datetime() }),
  z.object({ kind: z.literal('free') }),
  z.object({ kind: z.literal('self'), holder: documentEditorSchema }),
  z.object({ kind: z.literal('occupied'), requester: userSummarySchema, requestedAt: z.iso.datetime() }),
  z.object({ kind: z.literal('reservedForOther'), ...reservationShape }),
  z.object({ kind: z.literal('gone'), holder: documentEditorSchema.nullable() }),
])

export type EditRequestOutcome = z.infer<typeof editRequestOutcomeSchema>

/**
 * 谢绝请求编辑（POST /api/documents/{id}/edit-lease/request/decline，要能编辑，带令牌，M3-P5 设计 §3.6）：谢绝哪一个请求
 * （心跳带来的 id）。对不上（已取消、已换成新的请求）时什么也不做
 */
export const declineEditRequestSchema = z.strictObject({
  requestId: uuidSchema,
})

export type DeclineEditRequest = z.infer<typeof declineEditRequestSchema>

/**
 * 交出编辑权（POST /api/documents/{id}/edit-lease/handover，要能编辑，带令牌，M3-P5 设计 §3.6）：交给哪一个请求（心跳带来的 id）。
 * 请求已经不在了（取消、过期、换了一代）时 EDIT_REQUEST_GONE，租约不动
 */
export const handOverEditLeaseRequestSchema = z.strictObject({
  requestId: uuidSchema,
})

export type HandOverEditLeaseRequest = z.infer<typeof handOverEditLeaseRequestSchema>

/** 交出成功（200）：编辑权留给了谁、留到何时（EDIT_HANDOVER_RESERVE_SECONDS 之后谁都能申请） */
export const handedOverEditLeaseSchema = z.object(reservationShape)

export type HandedOverEditLease = z.infer<typeof handedOverEditLeaseSchema>

/** EDIT_LEASE_RESERVED 的详情（M3-P5 设计 §3.3）：编辑权刚交给了谁、留到何时 */
export const editLeaseReservedDetailsSchema = z.object(reservationShape)

export type EditLeaseReservedDetails = z.infer<typeof editLeaseReservedDetailsSchema>

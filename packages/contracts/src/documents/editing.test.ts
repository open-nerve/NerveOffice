import { describe, expect, it } from 'vitest'
import { ERROR_CODES, errorStatus } from '../errors/error-codes.ts'
import { errorResponseSchema } from '../errors/error-response.ts'
import { CSRF_TOKEN_HEADER } from '../http/headers.ts'
import {
  acquiredEditLeaseSchema,
  acquireEditLeaseRequestSchema,
  declineEditRequestSchema,
  documentEditorSchema,
  EDIT_ACQUIRE_IDLE_SECONDS_MAX,
  EDIT_HANDOVER_IDLE_SECONDS,
  EDIT_HANDOVER_RESERVE_SECONDS,
  EDIT_IDLE_RELEASE_SECONDS,
  EDIT_IDLE_SECONDS_MAX,
  EDIT_INTERRUPTION_NOTICE_SECONDS,
  EDIT_LEASE_HEADER,
  EDIT_LEASE_HEARTBEAT_SECONDS,
  EDIT_LEASE_IDLE_RECLAIM_SECONDS,
  EDIT_LEASE_LOST_REASONS,
  EDIT_LEASE_TTL_SECONDS,
  EDIT_PENDING_SAVE_WAIT_MS,
  EDIT_REQUEST_RENEW_SECONDS,
  EDIT_REQUEST_TTL_SECONDS,
  EDIT_TAB_HANDOVER_ACK_MS,
  EDIT_TAB_HANDOVER_DONE_MS,
  EDIT_TAKEOVER_MODES,
  editInterruptionSchema,
  editLeaseHeldDetailsSchema,
  editLeaseLostDetailsSchema,
  editLeaseReservedDetailsSchema,
  editLeaseTokenSchema,
  editRequestOutcomeSchema,
  editRequestViewSchema,
  editReservationSchema,
  editStatusSchema,
  handedOverEditLeaseSchema,
  handOverEditLeaseRequestSchema,
  pendingEditRequestSchema,
  renewedEditLeaseSchema,
  renewEditLeaseRequestSchema,
  requestEditRequestSchema,
} from './editing.ts'

const TOKEN = `${'a'.repeat(41)}-_`
const TAB = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c41'
const REQUEST_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c52'
const AMY = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c33', username: 'amy', displayName: '艾米' }
const BEN = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c34', username: 'ben', displayName: '本' }
const AT = '2026-10-04T08:00:00.000Z'
const LATER = '2026-10-04T08:02:00.000Z'

const acquired = { token: TOKEN, writeEpoch: 3, revision: 7, source: null, expiresAt: AT, interruption: null, formulasPending: false }
/** 客户端上报的构建与数据格式（M3-P3 设计 §3.5） */
const REPORTED = { clientBuild: '0.1.0+abc1234', univerVersion: '1.0.1', profile: 'sheet@1', formatVersion: 1 }
const editor = { holder: AMY, lastActiveAt: AT, sameUser: false, sameSession: false }
/** 编辑状态：没人在编辑，M3-P5 加的几项都是空的 */
const status = { revision: 7, editor: null, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }
const requestView = { requester: BEN, requestedAt: AT, mine: false }
const reservation = { reservedFor: BEN, reservedUntil: LATER, mine: true }
const interruption = { holder: AMY, endedAt: AT, sameUser: false }

describe('编辑租约的参数（P1 设计 §3.2，M3 总设计 §2.1）', () => {
  it('有效期 90 秒、心跳 10 秒（有效期内能重试好几次）、空闲 12 分钟兜底回收、异常结束的提醒 30 分钟', () => {
    expect([EDIT_LEASE_TTL_SECONDS, EDIT_LEASE_HEARTBEAT_SECONDS, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_INTERRUPTION_NOTICE_SECONDS]).toEqual([90, 10, 720, 1800])
    expect(EDIT_LEASE_TTL_SECONDS / EDIT_LEASE_HEARTBEAT_SECONDS).toBeGreaterThanOrEqual(3)
    // 上报的空闲时长的上限远大于兜底回收：到了上限的空闲一定已经被回收
    expect(EDIT_IDLE_SECONDS_MAX).toBe(86_400)
    expect(EDIT_IDLE_SECONDS_MAX).toBeGreaterThan(EDIT_LEASE_IDLE_RECLAIM_SECONDS)
  })

  it('令牌的请求头名写成小写，与 CSRF 令牌的请求头同样的写法（服务端按小写读）', () => {
    expect(EDIT_LEASE_HEADER).toBe('x-edit-lease')
    expect(EDIT_LEASE_HEADER).toBe(EDIT_LEASE_HEADER.toLowerCase())
    expect(CSRF_TOKEN_HEADER).toBe(CSRF_TOKEN_HEADER.toLowerCase())
  })

  it('令牌：43 个 base64url 字符（32 字节随机数，不带填充）；长度不对、带填充或别的字符都不合法', () => {
    expect(editLeaseTokenSchema.safeParse(TOKEN).success).toBe(true)
    for (const invalid of ['', TOKEN.slice(1), `${TOKEN}a`, `${TOKEN.slice(1)}=`, `${TOKEN.slice(1)}+`, `${TOKEN.slice(1)}/`, `${TOKEN.slice(1)} `, ` ${TOKEN.slice(1)}`])
      expect(editLeaseTokenSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
  })
})

describe('交接规则的参数（M3-P5 设计 §3.3，00 号计划书 §6.3）', () => {
  it('空闲释放 10 分钟、有请求时空闲 2 分钟自动交出、交出之后保留 2 分钟、请求方停止续期 10 分钟后请求失效、等待中每 5 秒续期', () => {
    expect([EDIT_IDLE_RELEASE_SECONDS, EDIT_HANDOVER_IDLE_SECONDS, EDIT_HANDOVER_RESERVE_SECONDS, EDIT_REQUEST_TTL_SECONDS, EDIT_REQUEST_RENEW_SECONDS]).toEqual([600, 120, 120, 600, 5])
  })

  it('同一个浏览器的交接：3 秒内要有回应、20 秒内要完成；刷新时在途的保存最多等 30 秒', () => {
    expect([EDIT_TAB_HANDOVER_ACK_MS, EDIT_TAB_HANDOVER_DONE_MS, EDIT_PENDING_SAVE_WAIT_MS]).toEqual([3000, 20_000, 30_000])
  })

  it('彼此的先后：页面的空闲释放早于服务端的兜底回收；自动交出早于空闲释放；续期的间隔远小于请求的有效期；回应的时限短于完成的时限', () => {
    expect(EDIT_HANDOVER_IDLE_SECONDS).toBeLessThan(EDIT_IDLE_RELEASE_SECONDS)
    expect(EDIT_IDLE_RELEASE_SECONDS).toBeLessThan(EDIT_LEASE_IDLE_RECLAIM_SECONDS)
    expect(EDIT_REQUEST_TTL_SECONDS / EDIT_REQUEST_RENEW_SECONDS).toBeGreaterThanOrEqual(3)
    expect(EDIT_TAB_HANDOVER_ACK_MS).toBeLessThan(EDIT_TAB_HANDOVER_DONE_MS)
  })
})

describe('申请编辑权', () => {
  it('请求是标签页的标识：UUID，统一转成小写；缺少、不是 UUID、多余的字段都拒绝（请求是严格结构）', () => {
    expect(acquireEditLeaseRequestSchema.parse({ clientInstanceId: TAB.toUpperCase() })).toEqual({ clientInstanceId: TAB })
    expect(acquireEditLeaseRequestSchema.safeParse({}).success).toBe(false)
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: 'tab-1' }).success).toBe(false)
    // 登录与持有者取自会话，不由请求给出
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, sessionId: TAB }).success).toBe(false)
  })

  it('M3-P3：另可带客户端的构建与数据格式，都可选（过旧的页面不让进入编辑，缺了由服务端按过旧处理）', () => {
    expect(acquireEditLeaseRequestSchema.parse({ clientInstanceId: TAB, ...REPORTED })).toEqual({ clientInstanceId: TAB, ...REPORTED })
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, ...REPORTED, formatVersion: '1' }).success).toBe(false)
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, clientBuild: 'abc' }).success).toBe(false)
  })

  it('M3-P5：接管方式可选，只有 self（本人接管）与 force（强制接管）两种写法；大小写不同、库里的写法（forced）、别的类型都拒绝', () => {
    expect(EDIT_TAKEOVER_MODES).toEqual(['self', 'force'])
    for (const takeover of EDIT_TAKEOVER_MODES)
      expect(acquireEditLeaseRequestSchema.parse({ clientInstanceId: TAB, takeover, ...REPORTED })).toEqual({ clientInstanceId: TAB, takeover, ...REPORTED })
    expect(acquireEditLeaseRequestSchema.parse({ clientInstanceId: TAB })).not.toHaveProperty('takeover')
    for (const takeover of ['forced', 'SELF', 'Force', '', null, true, ['self']])
      expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, takeover }).success, JSON.stringify(takeover)).toBe(false)
  })

  it('M3-P5：续上时可带本页已经空闲的秒数——0 到比回收阈值少一秒的整数（审查 A4：带到回收阈值的新一代一出生就按空闲失效）；不带也行', () => {
    expect(EDIT_ACQUIRE_IDLE_SECONDS_MAX).toBe(EDIT_LEASE_IDLE_RECLAIM_SECONDS - 1)
    for (const idleSeconds of [0, 1, EDIT_IDLE_RELEASE_SECONDS, EDIT_ACQUIRE_IDLE_SECONDS_MAX])
      expect(acquireEditLeaseRequestSchema.parse({ clientInstanceId: TAB, idleSeconds })).toEqual({ clientInstanceId: TAB, idleSeconds })
    for (const idleSeconds of [-1, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_IDLE_SECONDS_MAX, EDIT_IDLE_SECONDS_MAX + 1, 1.5, '5', null, Number.NaN])
      expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, idleSeconds }).success, String(idleSeconds)).toBe(false)
    // 时刻由数据库给出：浏览器的时间一律不收
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, idleSeconds: 3, lastActiveAt: AT }).success).toBe(false)
  })

  it('响应：令牌、这一代的代次、当前修订号与它的来源、到期时间；没有异常结束时 interruption 为 null；多出的字段被丢弃', () => {
    expect(acquiredEditLeaseSchema.parse({ ...acquired, holderId: AMY.id })).toEqual(acquired)
  })

  it('M3-P3：响应带文档的"公式待更新"（P4 据此在进入编辑时先全量重算），必填的布尔值', () => {
    expect(acquiredEditLeaseSchema.parse({ ...acquired, formulasPending: true }).formulasPending).toBe(true)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, formulasPending: undefined }).success).toBe(false)
  })

  it('当前修订的来源：保存产生的修订给出那次保存的标签页与本地序号，新建、复制出来的为 null；不能省略（与冲突详情的来源同一个结构）', () => {
    const source = { clientInstanceId: TAB, localSeq: 4 }
    expect(acquiredEditLeaseSchema.parse({ ...acquired, source }).source).toEqual(source)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, source: undefined }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, source: { clientInstanceId: TAB } }).success).toBe(false)
  })

  it('上一个租约异常结束时给出提醒：上一位持有者（"人"的结构）、结束的时间与是不是自己（M3-P5，必填）', () => {
    expect(acquiredEditLeaseSchema.parse({ ...acquired, interruption }).interruption).toEqual(interruption)
    expect(acquiredEditLeaseSchema.parse({ ...acquired, interruption: { ...interruption, sameUser: true } }).interruption?.sameUser).toBe(true)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, interruption: { ...interruption, holder: { id: AMY.id } } }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, interruption: { holder: AMY, endedAt: AT } }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, interruption: undefined }).success).toBe(false)
    expect(editInterruptionSchema.safeParse({ ...interruption, sameUser: 'false' }).success).toBe(false)
  })

  it('代次至少是 1（申请先给文档的代次加一）；令牌按格式校验；时间是 UTC 的 ISO 8601', () => {
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, writeEpoch: 0 }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, writeEpoch: 1.5 }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, revision: 0 }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, token: 'short' }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, expiresAt: '2026-10-04 08:00:00' }).success).toBe(false)
  })
})

describe('心跳续租', () => {
  it('请求只有"多久没有操作"：0 到一天之间的整数秒', () => {
    for (const idleSeconds of [0, 1, EDIT_LEASE_IDLE_RECLAIM_SECONDS, EDIT_IDLE_SECONDS_MAX])
      expect(renewEditLeaseRequestSchema.parse({ idleSeconds })).toEqual({ idleSeconds })
    for (const idleSeconds of [-1, EDIT_IDLE_SECONDS_MAX + 1, 1.5, '5', null, Number.NaN])
      expect(renewEditLeaseRequestSchema.safeParse({ idleSeconds }).success, String(idleSeconds)).toBe(false)
  })

  it('请求是严格结构：缺少空闲时长、带上浏览器的时间或令牌（令牌在请求头里）都拒绝', () => {
    expect(renewEditLeaseRequestSchema.safeParse({}).success).toBe(false)
    expect(renewEditLeaseRequestSchema.safeParse({ idleSeconds: 0, lastActiveAt: AT }).success).toBe(false)
    expect(renewEditLeaseRequestSchema.safeParse({ idleSeconds: 0, token: TOKEN }).success).toBe(false)
  })

  it('M3-P3：与申请相同，另可带客户端的构建与数据格式（服务端升级之后，正在编辑的页面在一次心跳之内就知道需要刷新）', () => {
    expect(renewEditLeaseRequestSchema.parse({ idleSeconds: 3, ...REPORTED })).toEqual({ idleSeconds: 3, ...REPORTED })
    expect(renewEditLeaseRequestSchema.safeParse({ idleSeconds: 3, profile: 'sheet 1' }).success).toBe(false)
  })

  it('响应：新的到期时间与待回应的请求编辑（M3-P5：没有时为 null，不能省略）', () => {
    expect(renewedEditLeaseSchema.parse({ expiresAt: AT, request: null, writeEpoch: 3 })).toEqual({ expiresAt: AT, request: null })
    expect(renewedEditLeaseSchema.safeParse({ expiresAt: AT }).success).toBe(false)
    expect(renewedEditLeaseSchema.safeParse({ request: null }).success).toBe(false)
  })

  it('M3-P5 待回应的请求：标识（交出、谢绝时带上）、请求方（"人"的结构）与发出的时刻；多出的字段被丢弃', () => {
    const request = { id: REQUEST_ID, requester: BEN, requestedAt: AT }
    expect(renewedEditLeaseSchema.parse({ expiresAt: AT, request: { ...request, sessionId: TAB } })).toEqual({ expiresAt: AT, request })
    expect(pendingEditRequestSchema.safeParse({ ...request, id: 'request-1' }).success).toBe(false)
    expect(pendingEditRequestSchema.safeParse({ ...request, requester: { id: BEN.id } }).success).toBe(false)
    expect(pendingEditRequestSchema.safeParse({ id: REQUEST_ID, requester: BEN }).success).toBe(false)
  })
})

describe('编辑状态与"别人正在编辑"', () => {
  it('编辑状态：当前修订号与正在编辑的人；没有有效的租约时 editor 为 null', () => {
    expect(editStatusSchema.parse(status)).toEqual(status)
    expect(editStatusSchema.parse({ ...status, editor })).toEqual({ ...status, editor })
    expect(editStatusSchema.safeParse({ ...status, editor: undefined }).success).toBe(false)
    expect(editStatusSchema.safeParse({ ...status, revision: 0 }).success).toBe(false)
  })

  it('M3-P3：带文档的"公式待更新"（阅读页据此说明公式结果可能还没更新），必填的布尔值', () => {
    expect(editStatusSchema.parse({ ...status, formulasPending: true }).formulasPending).toBe(true)
    expect(editStatusSchema.safeParse({ ...status, formulasPending: undefined }).success).toBe(false)
    expect(editStatusSchema.safeParse({ ...status, formulasPending: 1 }).success).toBe(false)
  })

  it('US-M3-05 编辑状态带上调用者现在能不能编辑（M3-P2 设计 §3.2）：必填的布尔值，阅读页据此显示或隐藏"编辑"', () => {
    expect(editStatusSchema.safeParse({ ...status, canEdit: undefined }).success).toBe(false)
    expect(editStatusSchema.safeParse({ ...status, canEdit: 'true' }).success).toBe(false)
    expect(editStatusSchema.safeParse({ ...status, canEdit: null }).success).toBe(false)
  })

  it('M3-P5：另带能不能强制接管、待回应的请求、交出之后的保留与异常中断的提醒——都不能省略，没有时为 null', () => {
    expect(editStatusSchema.parse({ ...status, canTakeOver: true }).canTakeOver).toBe(true)
    for (const field of ['canTakeOver', 'request', 'reservation', 'interruption'])
      expect(editStatusSchema.safeParse({ ...status, [field]: undefined }).success, field).toBe(false)
    expect(editStatusSchema.safeParse({ ...status, canTakeOver: null }).success).toBe(false)
    const full = { ...status, editor, request: requestView, reservation, interruption }
    expect(editStatusSchema.parse(full)).toEqual(full)
  })

  it('M3-P5 请求编辑的样子：请求方、发出的时刻与是不是调用者自己（mine）；不带请求的标识（交出、谢绝只由持有者经心跳拿到它）', () => {
    expect(editRequestViewSchema.parse({ ...requestView, id: REQUEST_ID })).toEqual(requestView)
    expect(editRequestViewSchema.safeParse({ ...requestView, mine: undefined }).success).toBe(false)
    expect(editRequestViewSchema.safeParse({ ...requestView, requestedAt: 'now' }).success).toBe(false)
  })

  it('M3-P5 交出之后的保留：留给谁、留到何时、是不是调用者自己', () => {
    expect(editReservationSchema.parse(reservation)).toEqual(reservation)
    for (const field of ['reservedFor', 'reservedUntil', 'mine'])
      expect(editReservationSchema.safeParse({ ...reservation, [field]: undefined }).success, field).toBe(false)
  })

  it('正在编辑的人：持有者是"人"的结构，带最后活动时间、是不是调用者自己、是不是调用者这次登录（M3-P5）；多出的字段（例如令牌）被丢弃', () => {
    expect(documentEditorSchema.parse({ ...editor, sameUser: true, sameSession: true, tokenDigest: 'x' })).toEqual({ ...editor, sameUser: true, sameSession: true })
    expect(documentEditorSchema.safeParse({ ...editor, holder: { id: AMY.id, username: 'amy' } }).success).toBe(false)
    expect(documentEditorSchema.safeParse({ ...editor, sameUser: undefined }).success).toBe(false)
    expect(documentEditorSchema.safeParse({ ...editor, sameSession: undefined }).success).toBe(false)
    expect(documentEditorSchema.safeParse({ ...editor, sameSession: 'yes' }).success).toBe(false)
  })

  it('EDIT_LEASE_HELD 的详情：与编辑状态里正在编辑的人同一个结构，另带能不能强制接管与待回应的请求（M3-P5，都不能省略）', () => {
    const details = { ...editor, canTakeOver: true, request: null }
    expect(editLeaseHeldDetailsSchema.parse(details)).toEqual(details)
    expect(editLeaseHeldDetailsSchema.parse({ ...details, request: requestView })).toEqual({ ...details, request: requestView })
    // 正在编辑的人的每一项照样必填
    expect(Object.keys(editLeaseHeldDetailsSchema.shape)).toEqual(expect.arrayContaining(Object.keys(documentEditorSchema.shape)))
    for (const field of [...Object.keys(documentEditorSchema.shape), 'canTakeOver', 'request'])
      expect(editLeaseHeldDetailsSchema.safeParse({ ...details, [field]: undefined }).success, field).toBe(false)
    const response = errorResponseSchema.parse({ error: { code: 'EDIT_LEASE_HELD', message: ERROR_CODES.EDIT_LEASE_HELD.message, requestId: 'req-1', details } })
    expect(editLeaseHeldDetailsSchema.parse(response.error.details)).toEqual(details)
  })
})

describe('编辑权失效的原因（EDIT_LEASE_LOST 的详情）', () => {
  it('十种原因，按有效条件的顺序（P1 设计 §3.4.1；M3-P5 加上被接管 taken_over 与已交出 handed_over）', () => {
    expect(EDIT_LEASE_LOST_REASONS).toEqual(['none', 'replaced', 'taken_over', 'released', 'revoked', 'handed_over', 'stale', 'expired', 'idle', 'session'])
    for (const reason of EDIT_LEASE_LOST_REASONS)
      expect(editLeaseLostDetailsSchema.parse({ reason })).toEqual({ reason })
  })

  it('M3-P5 被接管时另带 forced（空间管理员强制接管为真，本人在别处接手为假），可选；不是布尔值时当作没有', () => {
    for (const forced of [true, false])
      expect(editLeaseLostDetailsSchema.parse({ reason: 'taken_over', forced })).toEqual({ reason: 'taken_over', forced })
    expect(editLeaseLostDetailsSchema.parse({ reason: 'taken_over' }).forced).toBeUndefined()
    expect(editLeaseLostDetailsSchema.parse({ reason: 'taken_over', forced: 'yes' })).toEqual({ reason: 'taken_over', forced: undefined })
  })

  it('响应的结构宽松：以后加的、不认识的原因解析成 undefined，不让整个解析失败，页面按通用的"编辑权已失效"处理', () => {
    expect(editLeaseLostDetailsSchema.safeParse({ reason: 'moved_away' })).toEqual({ success: true, data: { reason: undefined } })
    expect(editLeaseLostDetailsSchema.parse({ reason: 3 }).reason).toBeUndefined()
    expect(editLeaseLostDetailsSchema.parse({}).reason).toBeUndefined()
    expect(editLeaseLostDetailsSchema.parse({ reason: 'expired', holder: AMY })).toEqual({ reason: 'expired' })
    // 整条错误响应照样认得出错误码与原因
    const response = errorResponseSchema.parse({ error: { code: 'EDIT_LEASE_LOST', message: ERROR_CODES.EDIT_LEASE_LOST.message, requestId: 'req-1', details: { reason: 'moved_away', forced: true } } })
    expect(response.error.code).toBe('EDIT_LEASE_LOST')
    expect(editLeaseLostDetailsSchema.parse(response.error.details)).toEqual({ reason: undefined, forced: true })
  })

  it('详情本身不是对象时仍然解析失败（与别的错误详情一样，由错误响应的结构先挡住）', () => {
    for (const details of [null, 'expired', ['expired']])
      expect(editLeaseLostDetailsSchema.safeParse(details).success, JSON.stringify(details)).toBe(false)
  })
})

describe('请求编辑与交出（M3-P5 设计 §3.3、§3.6）', () => {
  it('发出请求编辑：请求体只有页面上报的构建与数据格式，都可选；请求方、请求的标识与持有者都不由请求给出（严格结构）', () => {
    expect(requestEditRequestSchema.parse({})).toEqual({})
    expect(requestEditRequestSchema.parse(REPORTED)).toEqual(REPORTED)
    expect(requestEditRequestSchema.safeParse({ ...REPORTED, formatVersion: '1' }).success).toBe(false)
    for (const extra of [{ requestId: REQUEST_ID }, { requesterId: BEN.id }, { clientInstanceId: TAB }, { idleSeconds: 0 }])
      expect(requestEditRequestSchema.safeParse({ ...REPORTED, ...extra }).success, JSON.stringify(extra)).toBe(false)
  })

  it('交出与谢绝：请求体是要回应的那个请求的标识（UUID，统一成小写）；缺少、不是 UUID、多余的字段都拒绝（令牌在请求头里）', () => {
    for (const schema of [handOverEditLeaseRequestSchema, declineEditRequestSchema]) {
      expect(schema.parse({ requestId: REQUEST_ID.toUpperCase() })).toEqual({ requestId: REQUEST_ID })
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.safeParse({ requestId: 'request-1' }).success).toBe(false)
      expect(schema.safeParse({ requestId: REQUEST_ID, token: TOKEN }).success).toBe(false)
      expect(schema.safeParse({ requestId: REQUEST_ID, reservedFor: BEN.id }).success).toBe(false)
    }
  })

  it('交出成功：留给谁、留到何时；EDIT_LEASE_RESERVED 的详情同一个结构；多出的字段被丢弃', () => {
    const handed = { reservedFor: BEN, reservedUntil: LATER }
    for (const schema of [handedOverEditLeaseSchema, editLeaseReservedDetailsSchema]) {
      expect(schema.parse({ ...handed, mine: false })).toEqual(handed)
      expect(schema.safeParse({ reservedFor: BEN }).success).toBe(false)
      expect(schema.safeParse({ ...handed, reservedFor: BEN.id }).success).toBe(false)
    }
    const response = errorResponseSchema.parse({ error: { code: 'EDIT_LEASE_RESERVED', message: ERROR_CODES.EDIT_LEASE_RESERVED.message, requestId: 'req-1', details: handed } })
    expect(editLeaseReservedDetailsSchema.parse(response.error.details)).toEqual(handed)
  })

  /** 每一种结果的一个合法的样子 */
  const OUTCOMES = {
    pending: { kind: 'pending', id: REQUEST_ID, requestedAt: AT, expiresAt: LATER, holder: editor },
    declined: { kind: 'declined', id: REQUEST_ID, holder: editor },
    reserved: { kind: 'reserved', reservedUntil: LATER },
    free: { kind: 'free' },
    self: { kind: 'self', holder: { ...editor, sameUser: true } },
    occupied: { kind: 'occupied', requester: BEN, requestedAt: AT },
    reservedForOther: { kind: 'reservedForOther', reservedFor: BEN, reservedUntil: LATER },
    gone: { kind: 'gone', holder: null },
  } as const

  it('请求的结果按 kind 区分，八种：等待、被谢绝、留给你、没人在编辑、是你自己、别人先请求了、留给了别人、请求已不在', () => {
    expect(editRequestOutcomeSchema.options.map(option => option.shape.kind.value)).toEqual(['pending', 'declined', 'reserved', 'free', 'self', 'occupied', 'reservedForOther', 'gone'])
    for (const outcome of Object.values(OUTCOMES))
      expect(editRequestOutcomeSchema.parse(outcome), outcome.kind).toEqual(outcome)
    expect(editRequestOutcomeSchema.parse({ kind: 'gone', holder: editor })).toEqual({ kind: 'gone', holder: editor })
  })

  it('每一种的字段都必填（gone 的持有者可以是 null）；结构宽松，多出的字段被丢弃；不认识的 kind 整个解析失败', () => {
    for (const outcome of Object.values(OUTCOMES)) {
      for (const field of Object.keys(outcome).filter(key => key !== 'kind'))
        expect(editRequestOutcomeSchema.safeParse({ ...outcome, [field]: undefined }).success, `${outcome.kind}.${field}`).toBe(false)
      expect(editRequestOutcomeSchema.parse({ ...outcome, sessionId: TAB }), outcome.kind).toEqual(outcome)
    }
    expect(editRequestOutcomeSchema.safeParse({ kind: 'pending', id: 'request-1', requestedAt: AT, expiresAt: LATER, holder: editor }).success).toBe(false)
    expect(editRequestOutcomeSchema.safeParse({ kind: 'queued' }).success).toBe(false)
    expect(editRequestOutcomeSchema.safeParse({}).success).toBe(false)
  })
})

describe('编辑租约的错误码（ADR-006）', () => {
  it('都是 409；说明面向用户', () => {
    expect([errorStatus('EDIT_LEASE_HELD'), errorStatus('EDIT_LEASE_LOST')]).toEqual([409, 409])
    expect(ERROR_CODES.EDIT_LEASE_HELD.message).toBe('别人正在编辑这份文档')
    expect(ERROR_CODES.EDIT_LEASE_LOST.message).toBe('编辑权已失效，本次操作没有生效')
  })

  it('M3-P5：保留期内别人申请 EDIT_LEASE_RESERVED、交出时请求已不在 EDIT_REQUEST_GONE，都是 409（4xx：确定没有生效）', () => {
    expect([errorStatus('EDIT_LEASE_RESERVED'), errorStatus('EDIT_REQUEST_GONE')]).toEqual([409, 409])
    expect(ERROR_CODES.EDIT_LEASE_RESERVED.message).toBe('编辑权刚交给了别人，请稍后再试')
    expect(ERROR_CODES.EDIT_REQUEST_GONE.message).toBe('请求编辑已取消或失效，编辑权没有交出')
  })
})

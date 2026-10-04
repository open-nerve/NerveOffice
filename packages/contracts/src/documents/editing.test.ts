import { describe, expect, it } from 'vitest'
import { ERROR_CODES, errorStatus } from '../errors/error-codes.ts'
import { errorResponseSchema } from '../errors/error-response.ts'
import { CSRF_TOKEN_HEADER } from '../http/headers.ts'
import {
  acquiredEditLeaseSchema,
  acquireEditLeaseRequestSchema,
  documentEditorSchema,
  EDIT_IDLE_SECONDS_MAX,
  EDIT_INTERRUPTION_NOTICE_SECONDS,
  EDIT_LEASE_HEADER,
  EDIT_LEASE_HEARTBEAT_SECONDS,
  EDIT_LEASE_IDLE_RECLAIM_SECONDS,
  EDIT_LEASE_LOST_REASONS,
  EDIT_LEASE_TTL_SECONDS,
  editLeaseHeldDetailsSchema,
  editLeaseLostDetailsSchema,
  editLeaseTokenSchema,
  editStatusSchema,
  renewedEditLeaseSchema,
  renewEditLeaseRequestSchema,
} from './editing.ts'

const TOKEN = `${'a'.repeat(41)}-_`
const TAB = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c41'
const AMY = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c33', username: 'amy', displayName: '艾米' }
const AT = '2026-10-04T08:00:00.000Z'

const acquired = { token: TOKEN, writeEpoch: 3, revision: 7, source: null, expiresAt: AT, interruption: null }
const editor = { holder: AMY, lastActiveAt: AT, sameUser: false }

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

describe('申请编辑权', () => {
  it('请求只有标签页的标识：UUID，统一转成小写；缺少、不是 UUID、多余的字段都拒绝（请求是严格结构）', () => {
    expect(acquireEditLeaseRequestSchema.parse({ clientInstanceId: TAB.toUpperCase() })).toEqual({ clientInstanceId: TAB })
    expect(acquireEditLeaseRequestSchema.safeParse({}).success).toBe(false)
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: 'tab-1' }).success).toBe(false)
    // 登录与持有者取自会话，不由请求给出
    expect(acquireEditLeaseRequestSchema.safeParse({ clientInstanceId: TAB, sessionId: TAB }).success).toBe(false)
  })

  it('响应：令牌、这一代的代次、当前修订号与它的来源、到期时间；没有异常结束时 interruption 为 null；多出的字段被丢弃', () => {
    expect(acquiredEditLeaseSchema.parse({ ...acquired, holderId: AMY.id })).toEqual(acquired)
  })

  it('当前修订的来源：保存产生的修订给出那次保存的标签页与本地序号，新建、复制出来的为 null；不能省略（与冲突详情的来源同一个结构）', () => {
    const source = { clientInstanceId: TAB, localSeq: 4 }
    expect(acquiredEditLeaseSchema.parse({ ...acquired, source }).source).toEqual(source)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, source: undefined }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, source: { clientInstanceId: TAB } }).success).toBe(false)
  })

  it('上一个租约异常结束时给出提醒：上一位持有者（"人"的结构）与结束的时间', () => {
    const interruption = { holder: AMY, endedAt: AT }
    expect(acquiredEditLeaseSchema.parse({ ...acquired, interruption }).interruption).toEqual(interruption)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, interruption: { holder: { id: AMY.id }, endedAt: AT } }).success).toBe(false)
    expect(acquiredEditLeaseSchema.safeParse({ ...acquired, interruption: undefined }).success).toBe(false)
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

  it('响应：新的到期时间', () => {
    expect(renewedEditLeaseSchema.parse({ expiresAt: AT, writeEpoch: 3 })).toEqual({ expiresAt: AT })
    expect(renewedEditLeaseSchema.safeParse({}).success).toBe(false)
  })
})

describe('编辑状态与"别人正在编辑"', () => {
  it('编辑状态：当前修订号与正在编辑的人；没有有效的租约时 editor 为 null', () => {
    expect(editStatusSchema.parse({ revision: 7, editor: null })).toEqual({ revision: 7, editor: null })
    expect(editStatusSchema.parse({ revision: 7, editor })).toEqual({ revision: 7, editor })
    expect(editStatusSchema.safeParse({ revision: 7 }).success).toBe(false)
    expect(editStatusSchema.safeParse({ revision: 0, editor: null }).success).toBe(false)
  })

  it('正在编辑的人：持有者是"人"的结构，带最后活动时间与是不是调用者自己；多出的字段（例如令牌）被丢弃', () => {
    expect(documentEditorSchema.parse({ ...editor, sameUser: true, tokenDigest: 'x' })).toEqual({ ...editor, sameUser: true })
    expect(documentEditorSchema.safeParse({ ...editor, holder: { id: AMY.id, username: 'amy' } }).success).toBe(false)
    expect(documentEditorSchema.safeParse({ ...editor, sameUser: undefined }).success).toBe(false)
  })

  it('EDIT_LEASE_HELD 的详情与编辑状态里正在编辑的人同形', () => {
    expect(editLeaseHeldDetailsSchema).toBe(documentEditorSchema)
    const response = errorResponseSchema.parse({ error: { code: 'EDIT_LEASE_HELD', message: ERROR_CODES.EDIT_LEASE_HELD.message, requestId: 'req-1', details: editor } })
    expect(editLeaseHeldDetailsSchema.parse(response.error.details)).toEqual(editor)
  })
})

describe('编辑权失效的原因（EDIT_LEASE_LOST 的详情）', () => {
  it('八种原因，按有效条件的顺序（P1 设计 §3.4.1）', () => {
    expect(EDIT_LEASE_LOST_REASONS).toEqual(['none', 'replaced', 'released', 'revoked', 'stale', 'expired', 'idle', 'session'])
    for (const reason of EDIT_LEASE_LOST_REASONS)
      expect(editLeaseLostDetailsSchema.parse({ reason })).toEqual({ reason })
  })

  it('响应的结构宽松：以后加的、不认识的原因解析成 undefined，不让整个解析失败，页面按通用的"编辑权已失效"处理', () => {
    expect(editLeaseLostDetailsSchema.safeParse({ reason: 'taken_over' })).toEqual({ success: true, data: { reason: undefined } })
    expect(editLeaseLostDetailsSchema.parse({ reason: 3 }).reason).toBeUndefined()
    expect(editLeaseLostDetailsSchema.parse({}).reason).toBeUndefined()
    expect(editLeaseLostDetailsSchema.parse({ reason: 'expired', holder: AMY })).toEqual({ reason: 'expired' })
    // 整条错误响应照样认得出错误码与原因
    const response = errorResponseSchema.parse({ error: { code: 'EDIT_LEASE_LOST', message: ERROR_CODES.EDIT_LEASE_LOST.message, requestId: 'req-1', details: { reason: 'handed_over' } } })
    expect(response.error.code).toBe('EDIT_LEASE_LOST')
    expect(editLeaseLostDetailsSchema.parse(response.error.details).reason).toBeUndefined()
  })

  it('详情本身不是对象时仍然解析失败（与别的错误详情一样，由错误响应的结构先挡住）', () => {
    for (const details of [null, 'expired', ['expired']])
      expect(editLeaseLostDetailsSchema.safeParse(details).success, JSON.stringify(details)).toBe(false)
  })
})

describe('编辑租约的两个错误码（ADR-006）', () => {
  it('都是 409；说明面向用户', () => {
    expect([errorStatus('EDIT_LEASE_HELD'), errorStatus('EDIT_LEASE_LOST')]).toEqual([409, 409])
    expect(ERROR_CODES.EDIT_LEASE_HELD.message).toBe('别人正在编辑这份文档')
    expect(ERROR_CODES.EDIT_LEASE_LOST.message).toBe('编辑权已失效，本次操作没有生效')
  })
})

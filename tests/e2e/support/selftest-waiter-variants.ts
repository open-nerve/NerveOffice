import type { AcquiredEditLease, RenewedEditLease } from '@nerve-office/contracts'
import type { ApiPeer, RequestRun, WaiterOptions } from './selftest-request.ts'
import type { WaiterBoundaries, WaiterBoundary, WaiterVariant, WaiterVariantEvidence } from './selftest-waiter-evidence.ts'
import { withDatabase } from './database.ts'
import { serverRequestsOf, watchDocument } from './selftest-handover.ts'
import { loginPeer } from './selftest-request.ts'
import { requestStartedAt, WAITER_CANCEL_MS, waiterVariantJudgement } from './selftest-waiter-evidence.ts'

class WaiterVariantError extends Error {}

type BoundaryRow = Omit<WaiterBoundary, 'at' | 'serverNow' | 'endedAt' | 'renewedAt' | 'expiresAt' | 'requestExpiresAt' | 'reservedUntil'> & {
  serverNow: Date
  endedAt: Date | null
  renewedAt: Date
  expiresAt: Date
  requestExpiresAt: Date | null
  reservedUntil: Date | null
}

/** 仅查询本轮文档；服务端时间与租约列由同一条 SELECT 返回。 */
export async function waiterBoundary(documentId: string): Promise<WaiterBoundary> {
  return withDatabase(async (client) => {
    const row = (await client.query<BoundaryRow>(`SELECT clock_timestamp() AS "serverNow", write_epoch AS epoch, holder_id AS "holderId", end_reason AS "endReason", ended_at AS "endedAt",
      renewed_at AS "renewedAt", expires_at AS "expiresAt", request_id AS "requestId", requested_by AS "requestedBy", request_expires_at AS "requestExpiresAt",
      reserved_for AS "reservedFor", reserved_until AS "reservedUntil" FROM document_edit_leases WHERE document_id = $1`, [documentId])).rows[0]
    if (row === undefined)
      throw new WaiterVariantError('请求方变体缺少本轮文档的租约行')
    return { ...row, at: Date.now(), serverNow: row.serverNow.getTime(), endedAt: row.endedAt?.getTime() ?? null, renewedAt: row.renewedAt.getTime(), expiresAt: row.expiresAt.getTime(), requestExpiresAt: row.requestExpiresAt?.getTime() ?? null, reservedUntil: row.reservedUntil?.getTime() ?? null }
  })
}

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 独立心跳覆盖页面加载与结果收集；总是以 idleSeconds=0 表达协作者仍在操作。 */
function holderHeartbeat(peer: ApiPeer, documentId: string, token: string) {
  const state: { stopped: boolean, error?: string, pending?: RenewedEditLease['request'] } = { stopped: false }
  const loop = (async () => {
    while (!state.stopped) {
      const until = Date.now() + (state.pending == null ? 2000 : 10_000)
      while (!state.stopped && Date.now() < until)
        await sleep(200)
      if (state.stopped)
        break
      const beat = await peer.renew(documentId, token)
      if (beat.status !== 200) {
        state.error = `协作者心跳失败（HTTP ${String(beat.status)}）`
        break
      }
      state.pending = (beat.body as RenewedEditLease).request
    }
  })()
  return {
    state,
    stop: async () => {
      state.stopped = true
      await loop
    },
  }
}

type Calibration = { readonly mode: 'native' } | { readonly mode: 'clock-calibration', readonly advanceIdle: (ms: number) => Promise<void> }
export interface WaiterVariantRun extends RequestRun {
  readonly scenario: WaiterVariant
  readonly mode: Calibration['mode']
  readonly boundaries: WaiterBoundaries
}

/** 新变体与旧路 1 分开；只有调用者显式给出校准回调才能推进页面时钟，真实 Safari 固定 native。 */
export async function runWaiterVariant(options: WaiterOptions, scenario: WaiterVariant, calibration: Calibration = { mode: 'native' }): Promise<WaiterVariantRun> {
  if (scenario === 'request-waiter-expired' && calibration.mode !== 'native')
    throw new WaiterVariantError('保留期必须等待真实数据库时钟，不接受加速')
  const { documentId, holder, waiter, stage, deadline } = options
  const since = Date.now()
  const watch = await watchDocument(documentId)
  const marks: Record<string, number | undefined> = {}
  const boundaries: WaiterBoundaries = {}
  const notes: string[] = []
  let report: RequestRun['report']
  let peer: ApiPeer | undefined
  let token: string | undefined
  let beating: ReturnType<typeof holderHeartbeat> | undefined
  let hidden = false
  let handed = false
  const check = (): void => {
    if (stage.voided?.() !== undefined)
      throw new WaiterVariantError('本轮因桌面活动或外部中止作废')
    if (Date.now() >= deadline)
      throw new WaiterVariantError('请求方变体超过本轮时限')
    if (beating?.state.error !== undefined)
      throw new WaiterVariantError(beating.state.error)
  }
  const until = async <T>(read: () => Promise<T | undefined>, limit: number, reason: string): Promise<T> => {
    for (;;) {
      check()
      const value = await read()
      if (value !== undefined)
        return value
      if (Date.now() >= limit)
        throw new WaiterVariantError(reason)
      await sleep(250)
    }
  }
  const waitUntil = async (time: number): Promise<void> => {
    await until(async () => Date.now() >= time ? true : undefined, deadline, '等待超过时限')
  }
  try {
    peer = await loginPeer(options.origin, holder)
    const acquired = await peer.acquire(documentId)
    token = (acquired.body as Partial<AcquiredEditLease> | undefined)?.token
    if (acquired.status !== 201 || typeof token !== 'string')
      throw new WaiterVariantError(`协作者未取得编辑权（HTTP ${String(acquired.status)}）`)
    marks.peerAcquiredAt = acquired.at
    beating = holderHeartbeat(peer, documentId, token)
    await stage.open()
    const pending = await until(async () => {
      const pending = beating?.state.pending
      return pending?.requester.id === waiter.id ? pending : undefined
    }, Math.min(deadline, Date.now() + 120_000), '协作者心跳未在期限内带来本页请求')
    marks.requestSeenAt = Date.now()
    boundaries.pending = await waiterBoundary(documentId)
    hidden = true
    await stage.hide()
    marks.hiddenAt = Date.now()
    if (scenario === 'request-waiter-expired') {
      await waitUntil(Date.now() + 2000)
      await beating.stop()
      check()
      const handover = await peer.handOver(documentId, token, pending.id)
      if (handover.status !== 200)
        throw new WaiterVariantError(`协作者未交出（HTTP ${String(handover.status)}）`)
      handed = true
      marks.handedOverAt = handover.at
      boundaries.reserved = await waiterBoundary(documentId)
      const renewal = await until(async () => serverRequestsOf(documentId, since).find(r => r.userId === waiter.id && r.method === 'PUT' && r.route?.endsWith('/edit-lease/request') === true && r.statusCode === 200 && requestStartedAt(r) > handover.at), Math.min(deadline, Date.now() + 90_000), '后台请求方未得知交出')
      marks.renewedAt = renewal.time
      const reservedUntil = boundaries.reserved.reservedUntil
      if (reservedUntil === null)
        throw new WaiterVariantError('交出后缺少数据库保留期限')
      stage.say?.('请求方已经在后台获准；等待数据库原两分钟保留期实际结束')
      boundaries.hiddenEnd = await until(async () => {
        const boundary = await waiterBoundary(documentId)
        return boundary.serverNow >= reservedUntil ? boundary : undefined
      }, deadline, '数据库保留期没有结束')
    }
    else {
      stage.say?.(calibration.mode === 'native' ? '请求方隐藏，实际等待十分钟；协作者持续心跳' : '显式页面时钟校准十分钟；不计为真实 Safari 时长')
      if (calibration.mode === 'clock-calibration') {
        await calibration.advanceIdle(WAITER_CANCEL_MS)
        marks.clockAdvancedMs = WAITER_CANCEL_MS
      }
      else {
        await waitUntil(marks.hiddenAt + WAITER_CANCEL_MS)
      }
      boundaries.hiddenEnd = await waiterBoundary(documentId)
    }
    check()
    marks.shownAt = Date.now()
    await stage.show()
    hidden = false
    report = await stage.report(deadline)
    marks.reportedAt = report === undefined ? undefined : Date.now()
    if (scenario === 'request-waiter-cancelled') {
      boundaries.terminal = await until(async () => {
        const boundary = await waiterBoundary(documentId)
        return boundary.requestId === null && boundary.requestedBy === null ? boundary : undefined
      }, Math.min(deadline, Date.now() + 10_000), '空闲取消后数据库请求未清理')
    }
    else {
      boundaries.terminal = await waiterBoundary(documentId)
    }
    await waitUntil(Date.now() + 1000)
  }
  catch (error) {
    // loginPeer 的网络错误可能附带任意响应，不能把任意正文写入报告。
    notes.push(error instanceof WaiterVariantError ? error.message : '请求方变体准备、页面操作或接口失败')
  }
  finally {
    try {
      if (hidden)
        await stage.show()
    }
    catch { notes.push('收尾无法重新显示本轮请求页') }
    await beating?.stop()
    await watch.stop()
    if (!handed && peer !== undefined && token !== undefined) {
      const released = await peer.release(documentId, token)
      if (released.status !== 204)
        notes.push(`协作者清理未成功（HTTP ${String(released.status)}）`)
    }
  }
  const evidence: WaiterVariantEvidence = { scenario, mode: calibration.mode, documentId, holderId: holder.id, waiterId: waiter.id, report, marks, boundaries, states: watch.states(), requests: serverRequestsOf(documentId, since), voided: stage.voided?.() }
  const judgement = waiterVariantJudgement(evidence)
  return { ...evidence, voided: evidence.voided, calls: peer?.calls() ?? [], notes, judgement: { ...judgement, problems: [...judgement.problems, ...notes] } }
}

/** 只保存所需时序与状态，永不序列化协作者原始回答中的 token 或未知正文。 */
export function waiterVariantReceipt(run: WaiterVariantRun) {
  return { ...run, calls: run.calls.map(({ body: _body, ...call }) => call) }
}

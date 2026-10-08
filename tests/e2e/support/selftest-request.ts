// 请求编辑的两条路的编排与判定（M3-P6 设计 §3.10，DEF-062）：真实 Safari 的驱动脚本（safari/selftest.ts）与 Playwright 的校准
// （specs/editor/selftest.spec.ts）共用；页面上的场景在 apps/web/src/editor/testing/selftest-request.ts。被复核的一方在浏览器里，另一方（场景的协作者）
// 由这里经接口扮演（做法 C，探索 B §3.3：两条路要复核的都是浏览器里那一方的行为，另一方的界面已由 Playwright 三个浏览器覆盖；两个账户都在 Safari 时
// 盖屏会把两方一起暂停，回来时谁先醒是竞态）。浏览器一侧怎样打开、隐藏、回来、盖屏由调用方给出（stage：真实 Safari 另开标签页、osascript 的窗口；
// Playwright 模拟可见性、拦住心跳与交出）：
// - 接口扮演的另一方（loginPeer）：Node 的 fetch 登录（带与公开地址相同的 Origin），取会话的 Cookie 与 CSRF 令牌；之后的写请求都带 Origin、CSRF 令牌，
//   申请、心跳带页面上报的构建与数据格式。每次调用记下（发出与回答的时刻、方法、路径、状态码、回答）；
// - 路 1（runWaiter：请求方在后台停在"交给了我"，回到前台才进入）：协作者申请编辑权 → 打开请求方的页面（作者，阅读）→ 协作者每 2 秒心跳一次，
//   直到心跳带来请求 → 让请求方隐藏 → 2 秒之后协作者交出 → 等后端日志里请求方在交出之后续期（它这时得知 reserved）→ 再停 GRANTED_HOLD_MS
//   （这期间它应当停在 granted、不再续期、不申请）→ 让它回到前台 → 等它交回（进入编辑、写一格存上）；
// - 路 2（runPausedHolder：持有者被暂停时自动交出走到到期）：打开持有者的页面（作者，进入编辑）→ 库里有了第一格（修订号 2）→ 盖屏 → 库里有了隐藏的
//   那一刻上传的第二格（修订号 3）→ 协作者请求编辑、每 5 秒续期 → 得到 free（持有者那一代按时间到期）→ 申请、之后每 10 秒心跳（持有者回来续上时
//   被占着）→ 2 秒之后移走盖屏 → 等持有者交回（失去编辑权、另存为副本）→ 协作者释放。用户回来、按了 Esc 或点了盖屏的窗口（stage.voided）就中止：
//   随即移走盖屏、撤回请求，这一次作废；
// - 判定（纯函数，单元测试覆盖）：waiterJudgement、pausedHolderJudgement——库里的时间线（./selftest-handover.ts 的 watchDocument）、后端日志里这份
//   文档的请求（按认证出的用户分开两个人）与协作者自己的调用。
import type { AcquiredEditLease, EditRequestOutcome, RenewedEditLease } from '@nerve-office/contracts'
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from './database.ts'
import type { DocumentState, Judgement, ServerRequest } from './selftest-handover.ts'
import { randomUUID } from 'node:crypto'
import { EDIT_LEASE_HEADER, EDIT_LEASE_HEARTBEAT_SECONDS, EDIT_LEASE_TTL_SECONDS, EDIT_REQUEST_RENEW_SECONDS } from '@nerve-office/contracts'
import { CURRENT_CLIENT } from './client-format.ts'
import { revisionOf } from './database.ts'
import { serverRequestsOf, watchDocument } from './selftest-handover.ts'

/** 路 1：请求方得知交给了它之后，至少让它在后台停这么久（核对它停在 granted、不申请） */
export const GRANTED_HOLD_MS = 12_000

/** 路 1 的判定：停在 granted 的时间（请求方在交出之后第一次续期到回到前台）不短于它，才说明得了"不申请" */
export const GRANTED_HOLD_MIN_MS = 10_000

/** 路 2 的判定：最后一次续租到协作者申请之间不短于一个有效期（编辑权按时间到期，不是交出、释放） */
export const LEASE_TTL_MS = EDIT_LEASE_TTL_SECONDS * 1000

/** 路 2、真实 Safari：持有者的页面真的被暂停过——隐藏期间计时器最长的停顿不短于它（暂停之前 Safari 只把计时器压低到 1–13 秒） */
export const SUSPENDED_GAP_MIN_MS = 30_000

/** 路 1：等心跳带来请求时协作者心跳的间隔（比页面的 10 秒短：请求方一点"请求编辑"，驱动脚本两秒之内就让它隐藏） */
const REQUEST_POLL_MS = 2_000

/** 路 1：打开请求方的页面之后等心跳带来请求最多多久（登录、载入、到 steady、点"请求编辑"） */
const REQUEST_WAIT_MS = 120_000

/** 路 1：让请求方隐藏之后过多久再交出（Safari 另开的标签页成为当前的、请求方的页面收到 visibilitychange） */
const HIDE_SETTLE_MS = 2_000

/** 路 1：交出之后等请求方续期最多多久（后台的标签页计时器被压低） */
const RENEWAL_WAIT_MS = 90_000

/** 路 2：打开持有者的页面之后等第一格存上（修订号 2）最多多久 */
const FIRST_SAVE_WAIT_MS = 120_000

/** 路 2：盖屏之后等隐藏的那一刻上传的第二格（修订号 3）最多多久 */
const HIDDEN_SAVE_WAIT_MS = 60_000

/** 路 2：协作者请求之后等得到 free 最多多久（Safari 约 50 秒后暂停页面，再过一个有效期到期；Playwright 里一个有效期） */
const EXPIRY_WAIT_MS = 240_000

/** 路 2：协作者接手之后过多久移走盖屏 */
const UNCOVER_DELAY_MS = 2_000

/** 作废的一次：移走盖屏之后再等页面交回多久（交不回也不等了） */
const VOIDED_REPORT_GRACE_MS = 20_000

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

// ---- 接口扮演的另一方 ----

/** 协作者的一次调用：发出、回答的时刻（Date.now），方法、路径（文档 id 换成 :id）、状态码（网络错误时 undefined）与回答 */
export interface PeerCall {
  readonly sentAt: number
  readonly at: number
  readonly method: string
  readonly path: string
  readonly status: number | undefined
  readonly body: unknown
}

export interface ApiPeer {
  readonly user: TestUser
  /** 到现在的调用（拷贝） */
  readonly calls: () => PeerCall[]
  readonly acquire: (documentId: string) => Promise<PeerCall>
  readonly renew: (documentId: string, token: string) => Promise<PeerCall>
  readonly handOver: (documentId: string, token: string, requestId: string) => Promise<PeerCall>
  readonly release: (documentId: string, token: string) => Promise<PeerCall>
  readonly request: (documentId: string) => Promise<PeerCall>
  readonly renewRequest: (documentId: string) => Promise<PeerCall>
  readonly cancelRequest: (documentId: string) => Promise<PeerCall>
}

/** 登录：带与公开地址相同的 Origin（登录也是写请求）；交回之后的调用要带的 Cookie 与 CSRF 令牌 */
async function login(origin: string, user: TestUser): Promise<{ readonly cookie: string, readonly csrf: string }> {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json', origin },
    body: JSON.stringify({ username: user.username, password: user.password }),
  })
  const text = await response.text()
  if (response.status !== 200)
    throw new Error(`协作者没能登录：${response.status} ${text}`)
  const cookie = response.headers.getSetCookie().map(item => item.split(';')[0] ?? '').filter(item => item !== '').join('; ')
  const csrf = (JSON.parse(text) as { readonly csrfToken?: unknown }).csrfToken
  if (cookie === '' || typeof csrf !== 'string')
    throw new Error('协作者登录之后没有会话的 Cookie 或 CSRF 令牌')
  return { cookie, csrf }
}

/** 协作者（另一个账户）经接口登录，交回他的调用 */
export async function loginPeer(origin: string, user: TestUser): Promise<ApiPeer> {
  const session = await login(origin, user)
  const calls: PeerCall[] = []
  const call = async (method: string, documentId: string, suffix: string, options: { readonly body?: unknown, readonly lease?: string } = {}): Promise<PeerCall> => {
    const headers: Record<string, string> = { 'accept': 'application/json', 'cookie': session.cookie, origin, 'x-csrf-token': session.csrf }
    if (options.body !== undefined)
      headers['content-type'] = 'application/json'
    if (options.lease !== undefined)
      headers[EDIT_LEASE_HEADER] = options.lease
    const sentAt = Date.now()
    let status: number | undefined
    let body: unknown
    try {
      const response = await fetch(`${origin}/api/documents/${documentId}/edit-lease${suffix}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
      status = response.status
      const text = await response.text()
      try {
        body = text === '' ? undefined : JSON.parse(text) as unknown
      }
      catch {
        body = text
      }
    }
    catch (error) {
      body = error instanceof Error ? error.message : String(error)
    }
    const entry: PeerCall = { sentAt, at: Date.now(), method, path: `/api/documents/:id/edit-lease${suffix}`, status, body }
    calls.push(entry)
    return entry
  }
  return {
    user,
    calls: () => [...calls],
    acquire: async documentId => call('POST', documentId, '', { body: { clientInstanceId: randomUUID(), ...CURRENT_CLIENT } }),
    renew: async (documentId, token) => call('PUT', documentId, '', { body: { idleSeconds: 0, ...CURRENT_CLIENT }, lease: token }),
    handOver: async (documentId, token, requestId) => call('POST', documentId, '/handover', { body: { requestId }, lease: token }),
    release: async (documentId, token) => call('DELETE', documentId, '', { lease: token }),
    request: async documentId => call('POST', documentId, '/request', { body: { ...CURRENT_CLIENT } }),
    renewRequest: async documentId => call('PUT', documentId, '/request'),
    cancelRequest: async documentId => call('DELETE', documentId, '/request'),
  }
}

/** 一次调用的回答里的一个字段（回答不是对象时 undefined） */
function field(call: PeerCall | undefined, key: string): unknown {
  const body = call?.body
  return typeof body === 'object' && body !== null ? (body as Readonly<Record<string, unknown>>)[key] : undefined
}

/** 协作者在一份文档上持有编辑权时每 10 秒心跳一次（页面的节奏）：持有者回来续上时被占着 */
function keepBeating(peer: ApiPeer, documentId: string, token: string): { readonly stop: () => Promise<void> } {
  const state = { stopped: false }
  const loop = (async () => {
    while (!state.stopped) {
      const deadline = Date.now() + EDIT_LEASE_HEARTBEAT_SECONDS * 1000
      while (!state.stopped && Date.now() < deadline)
        await sleep(200)
      if (!state.stopped)
        await peer.renew(documentId, token)
    }
  })()
  return {
    stop: async () => {
      state.stopped = true
      await loop
    },
  }
}

/** 等这份文档的修订号到 revision（每 100 毫秒查一次库）：到了交回那一刻（Date.now），到 deadline 还没到交回 undefined */
async function untilRevision(documentId: string, revision: number, deadline: number, voided: () => string | undefined): Promise<number | undefined> {
  while (Date.now() < deadline && voided() === undefined) {
    if (((await revisionOf(documentId)) ?? 0) >= revision)
      return Date.now()
    await sleep(100)
  }
  return undefined
}

// ---- 编排 ----

/** 浏览器那一方怎样打开、隐藏、回来、盖屏，怎样等它交回（真实 Safari 与 Playwright 各给一份） */
export interface RequestStage {
  /** 打开被复核的那一页（入口页登录之后跳到编辑器页） */
  readonly open: () => Promise<void>
  /** 路 1：让请求方的那一页隐藏（Safari：另开遮住它的标签页；Playwright：模拟可见性）。路 2：盖屏（Safari：osascript 的窗口；Playwright：模拟隐藏、拦住心跳与交出） */
  readonly hide: () => Promise<void>
  /** 让它回到前台（Safari：遮住它的标签页关掉自己、移走盖屏；Playwright：模拟可见性、放开心跳与交出） */
  readonly show: () => Promise<void>
  /** 等它交回结果（到 deadline），交回解开的结果；交不回时 undefined */
  readonly report: (deadline: number) => Promise<SelftestReport | undefined>
  /** 这一次要不要作废（真实 Safari：用户回来了、按了 Esc 或点了盖屏的窗口）：原因；没有时 undefined */
  readonly voided?: () => string | undefined
  readonly say?: (message: string) => void
}

/** 一条路编排完的样子：判定、库里的时间线、后端日志里这份文档的请求、协作者的调用、各步的时刻、说明与页面交回的结果 */
export interface RequestRun {
  readonly judgement: Judgement
  readonly states: readonly DocumentState[]
  readonly requests: readonly ServerRequest[]
  readonly calls: readonly PeerCall[]
  readonly marks: Readonly<Record<string, number | undefined>>
  readonly notes: readonly string[]
  readonly report: SelftestReport | undefined
  /** 作废的原因（用户回来了、中止了）；没有时 undefined */
  readonly voided: string | undefined
}

export interface WaiterOptions {
  readonly origin: string
  readonly documentId: string
  /** 正在编辑的另一方（协作者，经接口） */
  readonly holder: TestUser
  /** 请求方（作者，浏览器里） */
  readonly waiter: TestUser
  readonly stage: RequestStage
  readonly deadline: number
}

/** 后端日志里第一条满足 match 的这份文档的请求（每半秒读一次日志：日志是异步写进文件的），到 deadline 还没有时 undefined */
async function untilLogged(documentId: string, since: number, match: (request: ServerRequest) => boolean, deadline: number): Promise<ServerRequest | undefined> {
  while (Date.now() < deadline) {
    const found = serverRequestsOf(documentId, since).find(match)
    if (found !== undefined)
      return found
    await sleep(500)
  }
  return undefined
}

function isRequestRenewal(request: ServerRequest, userId: string): boolean {
  return request.method === 'PUT' && (request.route ?? '').endsWith('/edit-lease/request') && request.userId === userId && request.statusCode === 200
}

function isAcquisition(request: ServerRequest, userId: string): boolean {
  return request.method === 'POST' && (request.route ?? '').endsWith('/edit-lease') && request.userId === userId
}

/** 路 1（见文件头） */
export async function runWaiter(options: WaiterOptions): Promise<RequestRun> {
  const { origin, documentId, holder, waiter, stage, deadline } = options
  const say = stage.say ?? (() => {})
  const voided = stage.voided ?? (() => undefined)
  const since = Date.now()
  const watch = await watchDocument(documentId)
  const marks: Record<string, number | undefined> = {}
  const notes: string[] = []
  let report: SelftestReport | undefined
  let peer: ApiPeer | undefined
  try {
    peer = await loginPeer(origin, holder)
    const acquired = await peer.acquire(documentId)
    const token = (acquired.body as Partial<AcquiredEditLease> | undefined)?.token
    if (acquired.status !== 201 || token === undefined)
      throw new Error(`协作者没能申请编辑权：${String(acquired.status)} ${JSON.stringify(acquired.body)}`)
    marks.peerAcquiredAt = acquired.at
    say('路 1：协作者经接口取得编辑权，打开请求方（作者）的页面')
    await stage.open()
    // 心跳（2 秒一次）直到带来请求方的请求
    let requestId: string | undefined
    const waitUntil = Math.min(deadline, Date.now() + REQUEST_WAIT_MS)
    while (requestId === undefined && Date.now() < waitUntil) {
      await sleep(REQUEST_POLL_MS)
      const beat = await peer.renew(documentId, token)
      const pending = (beat.body as Partial<RenewedEditLease> | undefined)?.request
      if (beat.status !== 200)
        throw new Error(`协作者的心跳失败：${String(beat.status)} ${JSON.stringify(beat.body)}`)
      if (pending !== null && pending !== undefined && pending.requester.id === waiter.id) {
        requestId = pending.id
        marks.requestSeenAt = beat.at
      }
    }
    if (requestId === undefined) {
      notes.push(`${REQUEST_WAIT_MS / 1000} 秒内协作者的心跳没有带来请求方的请求`)
    }
    else {
      say('路 1：协作者的心跳带来了请求，让请求方的页面隐藏，之后协作者交出')
      await stage.hide()
      marks.hiddenAt = Date.now()
      await sleep(HIDE_SETTLE_MS)
      const handed = await peer.handOver(documentId, token, requestId)
      if (handed.status === 200)
        marks.handedOverAt = handed.at
      else
        notes.push(`协作者交出没有成功：${String(handed.status)} ${JSON.stringify(handed.body)}`)
      const handedAt = marks.handedOverAt ?? Date.now()
      const renewal = await untilLogged(documentId, handedAt, request => isRequestRenewal(request, waiter.id) && request.time > handedAt, Math.min(deadline, handedAt + RENEWAL_WAIT_MS))
      if (renewal === undefined)
        notes.push(`交出之后 ${RENEWAL_WAIT_MS / 1000} 秒内后端日志里没有请求方的续期`)
      else
        marks.renewedAt = renewal.time
      // 请求方得知交给了它：在后台停在 granted、不再续期、不申请——停够了再让它回来
      await sleep((renewal?.time ?? Date.now()) + GRANTED_HOLD_MS - Date.now())
      say('路 1：请求方在后台停够了，让它回到前台')
      marks.shownAt = Date.now()
      await stage.show()
      report = await stage.report(deadline)
      marks.reportedAt = report === undefined ? undefined : Date.now()
    }
    // 后端的日志是异步写进文件的：等一会儿再读
    await sleep(1_000)
  }
  finally {
    await watch.stop()
  }
  const states = watch.states()
  const requests = serverRequestsOf(documentId, since)
  const judgement = waiterJudgement({ report, states, requests, holderId: holder.id, waiterId: waiter.id, marks })
  return { judgement: { problems: judgement.problems, evidence: [judgement.evidence, ...notes].join('；') }, states, requests, calls: peer?.calls() ?? [], marks, notes, report, voided: voided() }
}

export interface PausedHolderOptions {
  readonly origin: string
  readonly documentId: string
  /** 持有者（作者，浏览器里） */
  readonly holder: TestUser
  /** 请求方（协作者，经接口） */
  readonly requester: TestUser
  readonly stage: RequestStage
  readonly deadline: number
  /** 真实 Safari：持有者的页面真的被暂停（判定要求隐藏期间计时器停过 SUSPENDED_GAP_MIN_MS 以上）；Playwright 里不暂停页面 */
  readonly expectSuspended: boolean
}

/** 路 2（见文件头） */
export async function runPausedHolder(options: PausedHolderOptions): Promise<RequestRun> {
  const { origin, documentId, holder, requester, stage, deadline } = options
  const say = stage.say ?? (() => {})
  const voided = stage.voided ?? (() => undefined)
  const since = Date.now()
  const watch = await watchDocument(documentId)
  const marks: Record<string, number | undefined> = {}
  const notes: string[] = []
  let report: SelftestReport | undefined
  let peer: ApiPeer | undefined
  let token: string | undefined
  let beating: { readonly stop: () => Promise<void> } | undefined
  try {
    peer = await loginPeer(origin, requester)
    say('路 2：打开持有者（作者）的页面，等它进入编辑、存上第一格')
    await stage.open()
    const first = await untilRevision(documentId, 2, Math.min(deadline, Date.now() + FIRST_SAVE_WAIT_MS), voided)
    if (first === undefined) {
      notes.push(`${FIRST_SAVE_WAIT_MS / 1000} 秒内持有者没有存上第一格（修订号 2），没有盖屏`)
    }
    else {
      say('路 2：库里有了第一格，盖屏')
      let covered = false
      try {
        await stage.hide()
        covered = true
        marks.coveredAt = Date.now()
        const second = await untilRevision(documentId, 3, Math.min(deadline, marks.coveredAt + HIDDEN_SAVE_WAIT_MS), voided)
        if (second === undefined)
          notes.push(`盖屏之后 ${HIDDEN_SAVE_WAIT_MS / 1000} 秒内库里没有隐藏的那一刻上传的第二格（修订号 3）`)
        else
          marks.hiddenSavedAt = second
        const sent = await peer.request(documentId)
        marks.requestedAt = sent.at
        if (sent.status !== 200 || field(sent, 'kind') !== 'pending')
          notes.push(`协作者请求编辑的回答是 ${String(sent.status)} ${JSON.stringify(sent.body)}（应当在等 pending）`)
        say('路 2：协作者请求编辑，每 5 秒续期，等持有者那一代按时间到期')
        const until = Math.min(deadline, sent.at + EXPIRY_WAIT_MS)
        while (token === undefined && Date.now() < until && voided() === undefined) {
          await sleep(EDIT_REQUEST_RENEW_SECONDS * 1000)
          if (voided() !== undefined)
            break
          const renewed = await peer.renewRequest(documentId)
          const kind = (renewed.body as Partial<EditRequestOutcome> | undefined)?.kind
          if (kind === 'pending')
            continue
          if (kind === 'free' || kind === 'reserved') {
            marks.grantedAt = renewed.at
            const acquired = await peer.acquire(documentId)
            const next = (acquired.body as Partial<AcquiredEditLease> | undefined)?.token
            if (acquired.status === 201 && next !== undefined) {
              token = next
              marks.acquiredAt = acquired.at
              beating = keepBeating(peer, documentId, next)
            }
            else {
              notes.push(`续期得到 ${kind} 之后协作者申请没有成功：${String(acquired.status)} ${JSON.stringify(acquired.body)}`)
            }
            break
          }
          notes.push(`协作者续期得到 ${String(kind ?? renewed.status)}（${JSON.stringify(renewed.body)}），不再等`)
          break
        }
        if (token === undefined && voided() === undefined && notes.length === 0)
          notes.push(`协作者请求之后 ${EXPIRY_WAIT_MS / 1000} 秒内没有等到 free（持有者那一代没有到期）`)
        if (token !== undefined)
          await sleep(UNCOVER_DELAY_MS)
      }
      finally {
        if (covered) {
          say(voided() === undefined ? '路 2：移走盖屏，等持有者回来' : `路 2：作废（${voided() ?? ''}），移走盖屏`)
          marks.uncoveredAt = Date.now()
          await stage.show()
        }
      }
      if (token === undefined)
        await peer.cancelRequest(documentId)
      const reportDeadline = voided() === undefined ? deadline : Math.min(deadline, Date.now() + VOIDED_REPORT_GRACE_MS)
      report = await stage.report(reportDeadline)
      marks.reportedAt = report === undefined ? undefined : Date.now()
    }
    // 后端的日志是异步写进文件的：等一会儿再读
    await sleep(1_000)
  }
  finally {
    await beating?.stop()
    if (peer !== undefined && token !== undefined)
      await peer.release(documentId, token)
    await watch.stop()
  }
  const states = watch.states()
  const requests = serverRequestsOf(documentId, since)
  const calls = peer?.calls() ?? []
  const judgement = pausedHolderJudgement({ report, states, requests, calls, holderId: holder.id, requesterId: requester.id, marks, expectSuspended: options.expectSuspended })
  return { judgement: { problems: judgement.problems, evidence: [judgement.evidence, ...notes].join('；') }, states, requests, calls, marks, notes, report, voided: voided() }
}

// ---- 判定 ----

/** 相对某一刻的毫秒数（之前的是负数） */
function relative(at: number | undefined, origin: number): string {
  if (at === undefined)
    return '—'
  const ms = at - origin
  return `${ms >= 0 ? '+' : ''}${ms} ms`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`
}

/** 时间线里第一次出现的代次（打开时已有的租约，或者第一次申请的那一代）；没有时 undefined */
function firstEpoch(states: readonly DocumentState[]): number | undefined {
  return states.find(state => state.epoch !== null)?.epoch ?? undefined
}

/** 路 1 的证据：请求方交回的结果、库里的时间线、后端日志里这份文档的请求、两个人的 id 与各步的时刻 */
export interface WaiterEvidence {
  readonly report: SelftestReport | undefined
  readonly states: readonly DocumentState[]
  readonly requests: readonly ServerRequest[]
  readonly holderId: string
  readonly waiterId: string
  readonly marks: Readonly<Record<string, number | undefined>>
}

/**
 * 路 1（纯函数）：协作者交出了（库里那一代明确结束为 handed_over、留给请求方）；交出之后、回到前台之前请求方续期过（它由此得知 reserved），
 * 而且这期间没有申请编辑权；请求方停在 granted 的时间（交出之后第一次续期到回到前台）不短于 GRANTED_HOLD_MIN_MS；回到前台之后请求方取得编辑权
 * （201），库里的新一代是请求方的、普通申请（不带接管方式）、在回到前台之后才有
 */
export function waiterJudgement(evidence: WaiterEvidence): Judgement {
  const { report, states, requests, holderId, waiterId, marks } = evidence
  const origin = marks.hiddenAt ?? states[0]?.at ?? 0
  const problems: string[] = []
  if (report === undefined)
    problems.push('请求方没有交回结果')
  const { handedOverAt, shownAt } = marks
  const epochA = firstEpoch(states)
  const handed = states.find(state => state.epoch === epochA && state.endReason === 'handed_over')
  const reserved = states.find(state => state.reservedFor === waiterId)
  if (handedOverAt === undefined)
    problems.push('协作者没有交出（心跳没有带来请求，或者交出没有成功）')
  else if (handed === undefined || reserved === undefined)
    problems.push(`库里没有看到交出：协作者那一代${handed === undefined ? '没有明确结束为 handed_over' : '结束为 handed_over'}，${reserved === undefined ? '没有' : '有'}留给请求方的保留`)
  const until = shownAt ?? Number.POSITIVE_INFINITY
  const renewals = handedOverAt === undefined ? [] : requests.filter(request => isRequestRenewal(request, waiterId) && request.time > handedOverAt && request.time < until)
  if (handedOverAt !== undefined && renewals.length === 0)
    problems.push('交出之后、回到前台之前请求方没有续期（它没能得知交给了它）')
  const early = requests.filter(request => isAcquisition(request, waiterId) && request.time < until)
  if (early.length > 0)
    problems.push(`回到前台之前请求方申请了编辑权 ${early.length} 次（${early.map(request => `${request.statusCode ?? '中断'}，${relative(request.time, origin)}`).join('、')}）：应当停在交给了我`)
  const acquired = shownAt === undefined ? undefined : requests.find(request => isAcquisition(request, waiterId) && request.time >= shownAt)
  if (shownAt !== undefined && acquired?.statusCode !== 201)
    problems.push(`回到前台之后请求方没有取得编辑权（${acquired === undefined ? '没有申请' : String(acquired.statusCode ?? '中断')}）`)
  const held = renewals[0] === undefined || shownAt === undefined ? undefined : shownAt - renewals[0].time
  if (held !== undefined && held < GRANTED_HOLD_MIN_MS)
    problems.push(`请求方停在交给了我的时间只有 ${seconds(held)}（不短于 ${GRANTED_HOLD_MIN_MS / 1000} 秒才说明得了它不申请）`)
  const next = epochA === undefined ? undefined : states.find(state => state.epoch !== null && state.epoch > epochA)
  if (shownAt !== undefined) {
    if (next === undefined)
      problems.push('库里没有看到请求方的新一代')
    else if (next.holderId !== waiterId || next.takeover !== null || next.at < shownAt)
      problems.push(`库里的新一代：持有者${next.holderId === waiterId ? '是请求方' : `是 ${next.holderId ?? '空'}`}、接管方式 ${next.takeover ?? '空'}、${relative(next.at, origin)}（应当是请求方的普通申请，在回到前台之后）`)
  }
  const holderBeats = requests.filter(request => request.method === 'PUT' && (request.route ?? '').endsWith('/edit-lease') && request.userId === holderId).length
  const evidenceText = [
    `（相对请求方隐藏）协作者第 ${epochA ?? '?'} 代，心跳 ${holderBeats} 次`,
    `心跳带来请求 ${relative(marks.requestSeenAt, origin)}`,
    `交出 ${relative(handedOverAt, origin)}（库里 ${handed === undefined ? '没有 handed_over' : `handed_over ${relative(handed.at, origin)}`}，${reserved === undefined ? '没有保留' : '留给请求方'}）`,
    `交出之后、回到前台之前请求方续期 ${renewals.length} 次${renewals[0] === undefined ? '' : `（第一次 ${relative(renewals[0].time, origin)}）`}、申请 ${early.length} 次`,
    `停在交给了我 ${held === undefined ? '—' : seconds(held)}`,
    `回到前台 ${relative(shownAt, origin)}，之后请求方申请 ${acquired === undefined ? '没有' : `${acquired.statusCode ?? '中断'} ${relative(acquired.time, origin)}`}`,
    next === undefined ? '没有新一代' : `第 ${next.epoch ?? '?'} 代 ${relative(next.at, origin)}，接管方式 ${next.takeover ?? '空（普通申请）'}`,
    `页面交回的路 ${report?.path ?? '没有'}`,
  ]
  return { problems, evidence: evidenceText.join('；') }
}

/** 路 2 的证据：持有者交回的结果、库里的时间线、后端日志里这份文档的请求、协作者的调用、两个人的 id、各步的时刻，与要不要求页面真的被暂停过 */
export interface PausedHolderEvidence {
  readonly report: SelftestReport | undefined
  readonly states: readonly DocumentState[]
  readonly requests: readonly ServerRequest[]
  readonly calls: readonly PeerCall[]
  readonly holderId: string
  readonly requesterId: string
  readonly marks: Readonly<Record<string, number | undefined>>
  readonly expectSuspended: boolean
}

/**
 * 路 2（纯函数）：协作者续期得到 free（不是 reserved：持有者没有交出）之后申请成功，申请的回答里带着持有者那一代异常中断的提醒（按时间到期）；
 * 库里持有者那一代从没明确结束（没有交出、没有释放），之后的一代是协作者的普通申请；持有者那一代最后一次续租到协作者那一代取得不短于一个有效期
 * （数据库的时间）；后端日志里盖屏到协作者申请之间没有持有者的交出与释放。expectSuspended（真实 Safari）时另要求持有者的页面隐藏期间计时器停过
 * SUSPENDED_GAP_MIN_MS 以上（页面交回的 request.holder 计时里的 longestGap）
 */
export function pausedHolderJudgement(evidence: PausedHolderEvidence): Judgement {
  const { report, states, requests, calls, holderId, requesterId, marks } = evidence
  const origin = marks.coveredAt ?? states[0]?.at ?? 0
  const problems: string[] = []
  if (report === undefined)
    problems.push('持有者没有交回结果')
  const { acquiredAt } = marks
  const acquisition = calls.find(call => call.method === 'POST' && call.path.endsWith('/edit-lease') && call.status === 201)
  const granting = acquisition === undefined ? undefined : calls.filter(call => call.method === 'PUT' && call.path.endsWith('/edit-lease/request') && call.at <= acquisition.sentAt).at(-1)
  const grantedKind = field(granting, 'kind')
  if (acquiredAt === undefined || acquisition === undefined)
    problems.push('协作者没有接手（持有者那一代没有按时间到期？）')
  else if (grantedKind !== 'free')
    problems.push(`协作者接手之前那次续期的结果是 ${String(grantedKind)}（应当是 free：持有者那一代按时间到期${grantedKind === 'reserved' ? '；reserved 说明持有者交出了，没有被暂停' : ''}）`)
  const interruption = field(acquisition, 'interruption') as { readonly holder?: { readonly id?: unknown }, readonly sameUser?: unknown } | null | undefined
  if (acquisition !== undefined && (interruption?.holder?.id !== holderId || interruption.sameUser !== false))
    problems.push(`协作者申请的回答里${interruption === null || interruption === undefined ? '没有' : '不是持有者那一代的'}异常中断提醒（持有者那一代按时间到期时应当有）`)
  const epochA = firstEpoch(states)
  const ofA = states.filter(state => state.epoch === epochA)
  const ended = ofA.find(state => state.endReason !== null)
  const next = epochA === undefined ? undefined : states.find(state => state.epoch !== null && state.epoch > epochA)
  if (epochA === undefined || ofA[0]?.holderId !== holderId)
    problems.push(`库里没有看到持有者那一代的编辑租约（第一代的持有者是 ${ofA[0]?.holderId ?? '空'}）`)
  if (ended !== undefined)
    problems.push(`持有者那一代明确结束了（${ended.endReason ?? ''}，${relative(ended.at, origin)}）：应当没有交出、没有释放，按时间到期`)
  if (next === undefined)
    problems.push('库里没有看到持有者那一代之后的新一代')
  else if (next.holderId !== requesterId || next.takeover !== null)
    problems.push(`库里的新一代：持有者 ${next.holderId ?? '空'}、接管方式 ${next.takeover ?? '空'}（应当是协作者的普通申请）`)
  const lastRenewal = ofA.reduce<number | undefined>((latest, state) => (state.renewedAt === null || state.renewedAt === undefined ? latest : Math.max(latest ?? state.renewedAt, state.renewedAt)), undefined)
  const gap = lastRenewal === undefined || next?.acquiredAt === null || next?.acquiredAt === undefined ? undefined : next.acquiredAt - lastRenewal
  if (next !== undefined && (gap === undefined || gap < LEASE_TTL_MS))
    problems.push(`持有者那一代最后一次续租到协作者那一代取得${gap === undefined ? '说不出隔了多久' : `只隔了 ${seconds(gap)}`}（应当不短于 ${EDIT_LEASE_TTL_SECONDS} 秒：按时间到期）`)
  const window = (request: ServerRequest): boolean => request.time >= (marks.coveredAt ?? 0) && request.time <= (acquiredAt ?? Number.POSITIVE_INFINITY)
  const handovers = requests.filter(request => window(request) && request.userId === holderId && request.method === 'POST' && (request.route ?? '').endsWith('/edit-lease/handover'))
  const releases = requests.filter(request => window(request) && request.userId === holderId && request.method === 'DELETE' && (request.route ?? '').endsWith('/edit-lease'))
  if (handovers.length > 0 || releases.length > 0)
    problems.push(`盖屏到协作者申请之间后端收到持有者的交出 ${handovers.length} 个、释放 ${releases.length} 个（应当一个也没有）`)
  const longestGap = report?.timings?.find(timing => timing.id === 'request.holder')?.ms.longestGap ?? null
  if (evidence.expectSuspended && (longestGap === null || longestGap < SUSPENDED_GAP_MIN_MS))
    problems.push(`持有者的页面隐藏期间计时器最长只停了 ${longestGap === null ? '—' : seconds(longestGap)}（真实 Safari 里被暂停时应当不短于 ${SUSPENDED_GAP_MIN_MS / 1000} 秒）`)
  const beats = requests.filter(request => request.userId === holderId && request.method === 'PUT' && (request.route ?? '').endsWith('/edit-lease') && request.time >= origin && request.time <= (acquiredAt ?? Number.POSITIVE_INFINITY))
  const uncoveredAt = marks.uncoveredAt
  const after = uncoveredAt === undefined ? [] : requests.filter(request => request.userId === holderId && request.time >= uncoveredAt && ((request.route ?? '').includes('/edit-lease') || (request.route ?? '').endsWith('/content')))
  const renewals = calls.filter(call => call.method === 'PUT' && call.path.endsWith('/edit-lease/request'))
  const evidenceText = [
    `（相对盖屏）第二格（隐藏的那一刻）${relative(marks.hiddenSavedAt, origin)}`,
    `协作者请求 ${relative(marks.requestedAt, origin)}，续期 ${renewals.length} 次，${relative(granting?.at, origin)} 得到 ${String(grantedKind ?? '—')}、${relative(acquiredAt, origin)} 申请 ${acquisition === undefined ? '没有成功' : '201'}（异常中断的提醒：${interruption?.holder?.id === holderId ? '持有者那一代' : '没有'}）`,
    `盖屏之后持有者心跳 ${beats.length} 次${beats.at(-1) === undefined ? '' : `、最后一次 ${relative(beats.at(-1)?.time, origin)}`}，库里最后一次续租 ${relative(lastRenewal, origin)}`,
    `最后一次续租到协作者取得 ${gap === undefined ? '—' : seconds(gap)}`,
    `持有者那一代${ended === undefined ? '没有明确结束' : `明确结束（${ended.endReason ?? ''}）`}；${next === undefined ? '没有新一代' : `第 ${next.epoch ?? '?'} 代 ${relative(next.at, origin)}，接管方式 ${next.takeover ?? '空（普通申请）'}`}`,
    `移走盖屏 ${relative(marks.uncoveredAt, origin)}，之后持有者的请求：${after.length === 0 ? '没有' : after.map(request => `${request.method} ${(request.route ?? '?').replace('/api/documents/:id', '')} ${request.statusCode ?? '中断'}`).join('、')}`,
    `隐藏期间计时器最长停了 ${longestGap === null ? '—' : seconds(longestGap)}`,
    `页面交回的路 ${report?.path ?? '没有'}`,
  ]
  return { problems, evidence: evidenceText.join('；') }
}

// 交接的页面自检的编排（M3-P5 设计 §3.14，S8 后半）：真实 Safari 的驱动脚本（safari/selftest.ts）与 Playwright 的校准（specs/editor/selftest.spec.ts）
// 共用。页面上的场景在 apps/web/src/editor/testing/selftest-handover.ts。
// - 让保存停在服务端（slowDownSave）：这次运行的测试库里装一个触发器（第一次用时装，之后不撤：测试库随运行删掉），改写内容行时查一张登记表，
//   登记了的文档先 pg_sleep 一会儿再改写；用时登记这份文档，停完撤掉登记（只是 INSERT、DELETE，不再动表结构——每次装、撤触发器要表上的
//   排他锁，排在它后面的读写跟着等，等过后端的 lock_timeout 就是 503，Playwright 里三个浏览器同时跑时实测过）。保存先锁文档行、核对编辑权与
//   基准修订号、写修订记录、推进修订号，最后改写内容行——停在这里（这时它拿着文档行的锁）；读编辑状态、读内容、续租都不碰内容行。停够了那次保存
//   照常提交：客户端早已断开（刷新），服务端不因为连接断了而放弃（Express：处理照常进行，只是回应写不出去）。不用锁住内容行的办法：后端等锁至多
//   lock_timeout（5 秒）就放弃那次保存（55P03，回 503），而 pg_sleep 不是等锁，只受 statement_timeout（15 秒）约束。停着的时候那个连接的
//   application_name 换成这份文档的标记（事务内有效），blockedSince、finishedSince 按 pg_stat_activity 看；
// - 库里的时间线（watchDocument）：每 100 毫秒读一次修订号与编辑租约那一行（代次、明确结束的原因、接管的方式、绑定的标签页），记下变化；
// - 服务端的请求日志（serverRequestsOf）：test-results/e2e-server.log 里这份文档的请求（方法、路由、状态码或者中断、用时、记下的时刻）；
// - 判定（纯函数，单元测试覆盖）：takeoverJudgement、refreshJudgement——问题与证据的说明。
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { e2eDatabaseUrl } from './environment.ts'

/** 服务脚本写的后端日志（support/serve.ts 的 LOG_FILE） */
const SERVER_LOG = fileURLToPath(new URL('../test-results/e2e-server.log', import.meta.url))

/** 看库的间隔 */
const POLL_MS = 100

/**
 * refresh-save：保存在服务端停多久（改写内容行之前 pg_sleep）。页面发出保存 1.5 秒之后刷新，刷新之后的那一次到阅读的 steady（渲染完成之后
 * 3 秒）才点"在此编辑"——那次保存提交时它已经在等（waiting-save），远早于记号的 30 秒；不超过后端的 statement_timeout（15 秒）
 */
export const REFRESH_SLOW_SAVE_SECONDS = 10

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function connected(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl(), connectionTimeoutMillis: 5_000 })
  await client.connect()
  return client
}

// ---- 让保存停在服务端 ----

export interface SlowSave {
  /** 等到这份文档的保存停在服务端（触发器里的 pg_sleep）：交回看到的时刻（Date.now）；到 deadline 还没有时 undefined */
  readonly blockedSince: (deadline: number) => Promise<number | undefined>
  /** 等停着的那次保存做完（不再停着）：交回看到的时刻；到 deadline 还在停着时 undefined */
  readonly finishedSince: (deadline: number) => Promise<number | undefined>
  /** 撤掉这份文档的登记（之后的保存不再停） */
  readonly dispose: () => Promise<void>
}

/** 停着时的 application_name：文档 id 去掉连字符（每份文档一个，同时跑的几条用例互不混淆） */
function slowTagOf(documentId: string): string {
  const hex = documentId.replaceAll('-', '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex))
    throw new Error(`不是文档 id：${documentId}`)
  return `selftest_slow_${hex}`
}

/** 装触发器时持有的咨询锁（同时开始的几条用例只让一条装） */
const INSTALL_LOCK = 47_031_011

/** 这次运行的测试库里装上登记表、函数与触发器（已经装了就什么也不做）。函数与触发器只认登记表里的文档 */
async function installSlowSave(client: pg.Client): Promise<void> {
  await client.query('SELECT pg_advisory_lock($1)', [INSTALL_LOCK])
  try {
    const installed = await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'selftest_slow_save' AND tgrelid = 'document_contents'::regclass`)
    if (installed.rowCount === 1)
      return
    await client.query('CREATE TABLE IF NOT EXISTS selftest_slow_saves (document_id uuid PRIMARY KEY, seconds integer NOT NULL, tag text NOT NULL)')
    await client.query(`CREATE OR REPLACE FUNCTION selftest_slow_save() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE
        slow record;
      BEGIN
        SELECT seconds, tag INTO slow FROM selftest_slow_saves WHERE document_id = NEW.document_id;
        IF FOUND THEN
          PERFORM set_config('application_name', slow.tag, true);
          PERFORM pg_sleep(slow.seconds);
        END IF;
        RETURN NEW;
      END
    $body$`)
    await client.query('CREATE TRIGGER selftest_slow_save BEFORE UPDATE ON document_contents FOR EACH ROW EXECUTE FUNCTION selftest_slow_save()')
  }
  finally {
    await client.query('SELECT pg_advisory_unlock($1)', [INSTALL_LOCK])
  }
}

/** 让这份文档的保存在服务端停 seconds 秒（见文件头）：登记它，交回看停着、做完与撤掉登记的办法 */
export async function slowDownSave(documentId: string, seconds: number): Promise<SlowSave> {
  const tag = slowTagOf(documentId)
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds >= 15)
    throw new Error(`停的秒数要在 1 到 14 之间（statement_timeout 是 15 秒）：${seconds}`)
  const client = await connected()
  try {
    await installSlowSave(client)
    await client.query('INSERT INTO selftest_slow_saves (document_id, seconds, tag) VALUES ($1, $2, $3) ON CONFLICT (document_id) DO UPDATE SET seconds = EXCLUDED.seconds, tag = EXCLUDED.tag', [documentId, seconds, tag])
  }
  finally {
    await client.end()
  }
  const sleeping = async (watcher: pg.Client): Promise<boolean> => {
    const { rows } = await watcher.query<{ sleeping: number }>(`SELECT count(*)::int AS sleeping FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'PgSleep'`, [tag])
    return (rows[0]?.sleeping ?? 0) > 0
  }
  const until = async (wanted: boolean, deadline: number): Promise<number | undefined> => {
    const watcher = await connected()
    try {
      for (;;) {
        if (await sleeping(watcher) === wanted)
          return Date.now()
        if (Date.now() >= deadline)
          return undefined
        await sleep(POLL_MS)
      }
    }
    finally {
      await watcher.end()
    }
  }
  const state = { disposed: false }
  return {
    blockedSince: async deadline => until(true, deadline),
    finishedSince: async deadline => until(false, deadline),
    dispose: async () => {
      if (state.disposed)
        return
      state.disposed = true
      const remover = await connected()
      try {
        await remover.query('DELETE FROM selftest_slow_saves WHERE document_id = $1', [documentId])
      }
      finally {
        await remover.end()
      }
    },
  }
}

// ---- 库里的时间线 ----

/** 某一刻库里的样子：修订号，编辑租约那一行的代次、明确结束的原因、接管的方式与绑定的标签页（没有租约时是 null） */
export interface DocumentState {
  /** 读到的时刻（Date.now） */
  readonly at: number
  readonly revision: number | null
  readonly epoch: number | null
  readonly endReason: string | null
  readonly takeover: string | null
  readonly clientInstanceId: string | null
}

export interface DocumentWatch {
  readonly states: () => readonly DocumentState[]
  /** 停下，交回记下的变化（第一条是开始时的样子） */
  readonly stop: () => Promise<readonly DocumentState[]>
}

function sameState(a: DocumentState, b: DocumentState): boolean {
  return a.revision === b.revision && a.epoch === b.epoch && a.endReason === b.endReason && a.takeover === b.takeover && a.clientInstanceId === b.clientInstanceId
}

/** 每 100 毫秒读一次这份文档的修订号与编辑租约，记下变化 */
export async function watchDocument(documentId: string): Promise<DocumentWatch> {
  const client = await connected()
  const states: DocumentState[] = []
  const control = { stopped: false }
  const read = async (): Promise<DocumentState> => {
    const { rows } = await client.query<{ revision: number | null, write_epoch: number | null, end_reason: string | null, takeover: string | null, client_instance_id: string | null }>(
      `SELECT d.revision, l.write_epoch, l.end_reason, l.takeover, l.client_instance_id
       FROM documents d LEFT JOIN document_edit_leases l ON l.document_id = d.id WHERE d.id = $1`,
      [documentId],
    )
    const row = rows[0]
    return { at: Date.now(), revision: row?.revision ?? null, epoch: row?.write_epoch ?? null, endReason: row?.end_reason ?? null, takeover: row?.takeover ?? null, clientInstanceId: row?.client_instance_id ?? null }
  }
  const loop = (async () => {
    while (!control.stopped) {
      const state = await read()
      const last = states.at(-1)
      if (last === undefined || !sameState(last, state))
        states.push(state)
      await sleep(POLL_MS)
    }
  })()
  return {
    states: () => [...states],
    stop: async () => {
      control.stopped = true
      try {
        await loop
      }
      finally {
        await client.end()
      }
      return [...states]
    },
  }
}

// ---- 服务端的请求日志 ----

/** 后端记下的一个请求（请求结束时记一条：完成、失败或者中断） */
export interface ServerRequest {
  /** 记下的时刻（请求结束的时刻，Date.parse 之后） */
  readonly time: number
  readonly method: string
  readonly route: string | undefined
  readonly statusCode: number | undefined
  readonly aborted: boolean
  readonly durationMs: number | undefined
}

/** 日志的原文里这份文档的请求（路径里有它的 id），记下的时刻在 [since, until] 里，按时刻排好（纯函数） */
export function parseServerRequests(text: string, documentId: string, since: number, until = Number.POSITIVE_INFINITY): ServerRequest[] {
  const requests: ServerRequest[] = []
  for (const line of text.split('\n')) {
    if (!line.includes(documentId))
      continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    }
    catch {
      continue
    }
    const time = typeof entry.time === 'string' ? Date.parse(entry.time) : Number.NaN
    if (typeof entry.method !== 'string' || typeof entry.path !== 'string' || !entry.path.includes(documentId) || !(time >= since && time <= until))
      continue
    requests.push({
      time,
      method: entry.method,
      route: typeof entry.route === 'string' ? entry.route : undefined,
      statusCode: typeof entry.statusCode === 'number' ? entry.statusCode : undefined,
      aborted: entry.aborted === true,
      durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : undefined,
    })
  }
  return requests.sort((a, b) => a.time - b.time)
}

/** 服务脚本的后端日志里这份文档的请求（见 parseServerRequests）；日志读不到时是空的 */
export function serverRequestsOf(documentId: string, since: number, until?: number): ServerRequest[] {
  let text: string
  try {
    text = readFileSync(SERVER_LOG, 'utf8')
  }
  catch {
    return []
  }
  return parseServerRequests(text, documentId, since, until)
}

/** 相对某一刻的毫秒数（之前的是负数） */
function relative(at: number, origin: number): string {
  const ms = at - origin
  return `${ms >= 0 ? '+' : ''}${ms} ms`
}

function describeRequest(request: ServerRequest, origin: number): string {
  const outcome = request.aborted ? '中断' : String(request.statusCode ?? '?')
  return `${request.method} ${request.route ?? '?'} ${outcome}（结束于 ${relative(request.time, origin)}，用时 ${request.durationMs ?? '?'} ms）`
}

// ---- 判定 ----

export interface Judgement {
  readonly problems: readonly string[]
  readonly evidence: string
}

/** 时间线里第一次出现的代次（之前没有租约时是第一次申请的那一代）；没有时 undefined */
function firstEpoch(states: readonly DocumentState[]): number | undefined {
  return states.find(state => state.epoch !== null)?.epoch ?? undefined
}

/** 修订号每次变化的时刻（相对 origin） */
function revisionSteps(states: readonly DocumentState[], origin: number): string {
  const steps: string[] = []
  let last: number | null | undefined
  for (const state of states) {
    if (state.revision !== last) {
      steps.push(`${state.revision ?? '—'}（${last === undefined ? '开始时' : relative(state.at, origin)}）`)
      last = state.revision
    }
  }
  return steps.join(' → ')
}

/** 本人接管的证据：B 的结果（必须交回）、A 的结果（Safari 里 A 在后台、可能交不回）、库里的时间线、后端日志里这份文档的请求、另开 B 的时刻 */
export interface TakeoverEvidence {
  readonly taker: SelftestReport | undefined
  readonly holder: SelftestReport | undefined
  readonly states: readonly DocumentState[]
  readonly requests: readonly ServerRequest[]
  readonly openedTakerAt: number | undefined
}

/** 释放编辑权的请求（DELETE …/edit-lease，204） */
function isRelease(request: ServerRequest): boolean {
  return request.method === 'DELETE' && (request.route ?? '').endsWith('/edit-lease') && request.statusCode === 204
}

/** 申请编辑权的请求（POST …/edit-lease，取得是 201） */
function isAcquire(request: ServerRequest): boolean {
  return request.method === 'POST' && (request.route ?? '').endsWith('/edit-lease') && request.statusCode === 201
}

/**
 * 两个标签页的本人接管（纯函数）：B 交回了一条路（answered：A 回应了、交出之后普通申请；silent：A 没有回应、本人接管并抢锁）；A 交回的路与它一致
 * （answered ⇔ handed-over，silent ⇔ lost），A 没交回只记下；库里 A 那一代之后是 B 的新一代——answered 时 B 的一代是普通申请（接管方式为空：
 * 那时 A 那一代已经不在了，不然普通申请会被自己占着），后端日志里另开 B 之后、B 取得之前有 A 的释放；silent 时 B 的一代记着本人接管（self），
 * A 那一代没有明确结束、那期间没有释放。A 那一代释放与 B 取得之间往往只有几毫秒，每 100 毫秒看一次库看不到"已释放"的那一刻，所以释放看后端日志
 */
export function takeoverJudgement(evidence: TakeoverEvidence): Judgement {
  const { taker, holder, states, requests } = evidence
  const origin = evidence.openedTakerAt ?? states[0]?.at ?? 0
  const problems: string[] = []
  const path = taker?.path
  if (taker === undefined)
    problems.push('另开的 B 没有交回结果')
  const holderPath = holder?.path
  const expectedHolder = path === 'answered' ? 'handed-over' : path === 'silent' ? 'lost' : undefined
  if (holder !== undefined && expectedHolder !== undefined && holderPath !== expectedHolder)
    problems.push(`A 交回的路是 ${holderPath ?? '没有'}（B 走的是 ${path ?? '?'}，A 应当是 ${expectedHolder}）`)
  const epochA = firstEpoch(states)
  const firstOfB = states.find(state => epochA !== undefined && state.epoch !== null && state.epoch > epochA)
  const releasedA = states.find(state => state.epoch === epochA && state.endReason !== null)
  const acquiredB = requests.find(request => isAcquire(request) && request.time >= origin)
  const releasesBetween = requests.filter(request => isRelease(request) && request.time >= origin && request.time <= (acquiredB?.time ?? Number.POSITIVE_INFINITY))
  if (epochA === undefined) {
    problems.push('库里没有看到 A 那一代的编辑租约')
  }
  else if (firstOfB === undefined) {
    problems.push(`库里没有看到 A 那一代（第 ${epochA} 代）之后的新一代`)
  }
  else if (path === 'silent' && (firstOfB.takeover !== 'self' || releasedA !== undefined || releasesBetween.length > 0)) {
    problems.push(`B 没有回应就接手：新一代应当记着本人接管、A 那一代不释放；库里新一代的接管方式是 ${firstOfB.takeover ?? '空'}，A 那一代${releasedA === undefined ? '没有明确结束' : `明确结束了（${releasedA.endReason ?? ''}）`}，另开 B 之后、B 取得之前的释放 ${releasesBetween.length} 个`)
  }
  else if (path === 'answered' && (firstOfB.takeover !== null || releasesBetween.length === 0)) {
    problems.push(`A 交出之后 B 普通申请：A 那一代应当先释放、新一代不记接管；库里新一代的接管方式是 ${firstOfB.takeover ?? '空'}，另开 B 之后、B 取得之前的释放 ${releasesBetween.length} 个`)
  }
  const lease = epochA === undefined
    ? '没有租约'
    : `A 第 ${epochA} 代${releasedA === undefined ? '' : `（${relative(releasedA.at, origin)} ${releasedA.endReason ?? ''}）`}；${firstOfB === undefined ? '没有新一代' : `${relative(firstOfB.at, origin)} 第 ${firstOfB.epoch ?? '?'} 代，接管方式 ${firstOfB.takeover ?? '空（普通申请）'}`}`
  const server = `后端：${releasesBetween.length === 0 ? '这期间没有释放' : `释放 ${releasesBetween.map(request => relative(request.time, origin)).join('、')}`}，${acquiredB === undefined ? '没有看到 B 取得' : `B 取得 ${relative(acquiredB.time, origin)}`}`
  return { problems, evidence: `B 走的路 ${path ?? '没有交回'}、A ${holder === undefined ? '没有交回结果' : `交回的路 ${holderPath ?? '没有'}`}；库里（相对另开 B）：${lease}；${server}；修订号 ${revisionSteps(states, origin)}` }
}

/** 刷新时在途的保存的证据：页面（刷新之后那一次）交回的结果、库里的时间线、服务端的请求日志、保存停在服务端与停完（做完）的时刻 */
export interface RefreshEvidence {
  readonly report: SelftestReport | undefined
  readonly states: readonly DocumentState[]
  readonly requests: readonly ServerRequest[]
  readonly blockedAt: number | undefined
  readonly finishedAt: number | undefined
}

/**
 * 刷新时在途的保存（纯函数）：保存停在了服务端；页面交回 committed（那次保存提交了才接手），而且库里修订号前进在接手之前；刷新之前那一代
 * 从没被释放（没有明确结束），下一代记着本人接管（self：接手时那一代还有效）；服务端日志里接手之前没有这份文档的释放（DELETE …/edit-lease）。
 * 证据另说那次保存的请求在服务端是完成还是中断（刷新时浏览器取消了它）、修订号什么时候前进
 */
export function refreshJudgement(evidence: RefreshEvidence): Judgement {
  const { report, states, requests, blockedAt, finishedAt } = evidence
  const origin = blockedAt ?? states[0]?.at ?? 0
  const problems: string[] = []
  if (blockedAt === undefined)
    problems.push('保存没有停在服务端（没有看到它在改写内容行时停着）')
  if (report === undefined)
    problems.push('刷新之后的那一次没有交回结果')
  else if (report.path === 'expired')
    problems.push('页面等满了 30 秒才接手：停在服务端的那次保存没有提交？')
  const epoch = firstEpoch(states)
  const ofEpoch = states.filter(state => state.epoch === epoch)
  const released = ofEpoch.find(state => state.endReason !== null)
  const next = states.find(state => epoch !== undefined && state.epoch !== null && state.epoch > epoch)
  if (epoch === undefined)
    problems.push('库里没有看到刷新之前那一代的编辑租约')
  else if (released !== undefined)
    problems.push(`刷新之前那一代（第 ${epoch} 代）明确结束了（${released.endReason ?? ''}，${relative(released.at, origin)}）：页面关闭时不应释放`)
  else if (next === undefined)
    problems.push(`库里没有看到第 ${epoch} 代之后的新一代（没有接手）`)
  else if (next.takeover !== 'self')
    problems.push(`新一代的接管方式是 ${next.takeover ?? '空'}（应当是本人接管：接手时刷新之前那一代还有效）`)
  const takeoverAt = next?.at ?? Number.POSITIVE_INFINITY
  const advanced = states.find(item => item.revision !== null && item.revision > (states[0]?.revision ?? 0))
  if (report?.path === 'committed' && next !== undefined && (advanced === undefined || advanced.at > takeoverAt))
    problems.push(`页面说那次保存提交了才接手，库里修订号却${advanced === undefined ? '没有前进' : `在接手之后（${relative(advanced.at, origin)}）才前进`}`)
  const releases = requests.filter(request => request.method === 'DELETE' && (request.route ?? '').endsWith('/edit-lease') && request.time < takeoverAt)
  if (releases.length > 0)
    problems.push(`接手之前服务端收到了释放：${releases.map(request => describeRequest(request, origin)).join('、')}`)
  const saves = requests.filter(request => request.method === 'PUT' && (request.route ?? '').endsWith('/content'))
  const parts = [
    `保存停在服务端${blockedAt === undefined ? '：没有' : ''}，${finishedAt === undefined ? '没有停完' : `${relative(finishedAt, origin)} 停完`}`,
    `保存的请求在服务端：${saves.length === 0 ? '日志里没有' : saves.map(request => describeRequest(request, origin)).join('、')}`,
    `修订号 ${revisionSteps(states, origin)}`,
    `第 ${epoch ?? '?'} 代${released === undefined ? '没有明确结束' : `明确结束（${released.endReason ?? ''}）`}；${next === undefined ? '没有新一代' : `${relative(next.at, origin)} 第 ${next.epoch ?? '?'} 代，接管方式 ${next.takeover ?? '空'}`}`,
    `接手之前的释放 ${releases.length} 个；页面交回的路 ${report?.path ?? '没有'}`,
  ]
  return { problems, evidence: `（相对保存停在服务端）${parts.join('；')}` }
}

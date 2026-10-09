// 真实浏览器的前置复核（M4-P1 设计 §3.6，S1 第一轮）的判定：页面（apps/web/src/editor/testing/selftest-storage.ts、selftest-stall.ts、
// selftest-cost.ts）只核对"跑完、数据齐"，交回事实（facts）与计时（timings）；每一项是否符合预期在这里判定（纯函数，单元测试覆盖）。
// 真实 Safari 的驱动脚本（safari/selftest.ts）、Playwright 的校准（specs/editor/selftest.spec.ts：只断言与时间无关的几项）与本机持久上下文里的实测
// （measure/probe.spec.ts）共用。结论：
// - pass、fail：有判定标准的项（设计 §3.6 的"判定"一列）；
// - record：只记录事实的项（第 1、3、12 项）；
// - unavailable：这次运行做不了（第 4 项写满只在配额被覆盖时做：真实 Safari 没有覆盖配额的接口）；
// - missing：数据不齐（那一步没交回、缺了事实或计时），列出缺了什么。
// 计时的分布用最近秩法（./measure-stats.ts），次数少时 p95 就是最大值或次大值，偏保守
import type { SelftestFact, SelftestReport, SelftestTiming } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { Distribution } from './measure-stats.ts'
import { distribution } from './measure-stats.ts'

/** 一步交回的结果：cold 是这一页是不是这次运行里第一次打开编辑器页（首屏的冷与热，第 12 项用） */
export interface ProbeReport {
  readonly stepId: string
  readonly report: SelftestReport
  readonly cold: boolean
}

export type VerdictStatus = 'pass' | 'fail' | 'record' | 'unavailable' | 'missing'

/** 一项的结论 */
export interface ItemVerdict {
  /** 设计 §3.6 的第几项 */
  readonly item: number
  readonly title: string
  readonly status: VerdictStatus
  /** 给人看的说明（数字与原因） */
  readonly lines: readonly string[]
  /** 缺了的事实或计时 */
  readonly missing: readonly string[]
}

const STATUS_TEXT: Readonly<Record<VerdictStatus, string>> = { pass: '通过', fail: '不通过', record: '记录', unavailable: '这次做不了', missing: '数据不齐' }

/** 停顿：一次比同条件的中位数多出这么多（毫秒）算一次（M0-P6 的口径） */
export const STALL_EXCESS_MS = 500

/** 小延迟：多出这么多但不到停顿（空定时器若只是让事件循环醒得早，能把它压到 100 ms 以内而不是 0），另记 */
const MINOR_EXCESS_MS = 30

/** 保留 Worker 放置的条件之一：有空定时器、空闲 ≥ 1 秒的各组 Worker 段的 p95 不超过这么多（设计 §3.6 第 9 项；M0 约 140–170 ms） */
export const WORKER_SEGMENT_P95_MS = 300

/** 计划书 §12.2：1 MiB 的捕获在主线程上的同步段 p95 */
export const CAPTURE_SYNC_P95_MS = 100

/** Worker 放置时异步段主线程的最长阻塞（每一次的最长阻塞取中位数）：设计 §3.6 第 10 项"约 10 ms 以内" */
export const WORKER_ASYNC_LAG_MS = 10

/** WebKit 改在主线程放置的前提：主线程 gzip 的最长阻塞（p95）不超过这么多（M4 总设计 §6.1） */
export const MAIN_GZIP_LAG_MS = 100

/** 第 1 MiB 那一档的样本：快照不到这么多字节（真实的两档约 1 MiB 与约 5 MiB） */
const SMALL_CAPTURE_MAX_BYTES = 2 * 1024 * 1024

type Rule = readonly [key: string, ok: (value: SelftestFact) => boolean, want: string]

function is(expected: SelftestFact): Rule[1] {
  return value => value === expected
}

function oneOf(...expected: SelftestFact[]): Rule[1] {
  return value => expected.includes(value)
}

/** 按规则核对事实：缺了的（没有这个键）与不对的（说明看到了什么、应当是什么） */
function judge(facts: Readonly<Record<string, SelftestFact>>, rules: readonly Rule[]): { readonly missing: string[], readonly wrong: string[] } {
  const missing: string[] = []
  const wrong: string[] = []
  for (const [key, ok, want] of rules) {
    if (!(key in facts)) {
      missing.push(key)
      continue
    }
    const value = facts[key] ?? null
    if (!ok(value))
      wrong.push(`${key} 是 ${JSON.stringify(value)}（应当是 ${want}）`)
  }
  return { missing, wrong }
}

function factsOf(reports: readonly ProbeReport[], scenario: string): Readonly<Record<string, SelftestFact>> | undefined {
  return reports.find(entry => entry.report.scenario === scenario)?.report.facts
}

function reportOf(reports: readonly ProbeReport[], scenario: string): ProbeReport | undefined {
  return reports.find(entry => entry.report.scenario === scenario)
}

function text(value: SelftestFact | undefined): string {
  return value === undefined ? '—' : String(value)
}

function number(value: SelftestFact | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function noStep(item: number, title: string, step: string): ItemVerdict {
  return { item, title, status: 'missing', lines: [`没有 ${step} 这一步的结果`], missing: [step] }
}

/** 规则核对的结论：缺了就是 missing，有不对的就是 fail，否则 pass */
function ruled(item: number, title: string, facts: Readonly<Record<string, SelftestFact>>, rules: readonly Rule[], lines: readonly string[]): ItemVerdict {
  const { missing, wrong } = judge(facts, rules)
  if (missing.length > 0)
    return { item, title, status: 'missing', lines, missing }
  return { item, title, status: wrong.length === 0 ? 'pass' : 'fail', lines: [...lines, ...wrong.map(line => `不对：${line}`)], missing: [] }
}

/** 一项计时里各次的值（按次序：键是 1、2、3……） */
function samplesOf(timing: SelftestTiming | undefined): number[] {
  return Object.values(timing?.ms ?? {}).filter((value): value is number => typeof value === 'number')
}

/** id 以 prefix# 开头的各项计时里 field 的值 */
function fieldOf(timings: readonly SelftestTiming[], prefix: string, field: string): number[] {
  return timings.filter(timing => timing.id.startsWith(`${prefix}#`)).map(timing => timing.ms[field]).filter((value): value is number => typeof value === 'number')
}

function ms(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? '—' : `${Math.round(value * 10) / 10} ms`
}

function spread(values: Distribution | null): string {
  return values === null ? '—' : `p50 ${ms(values.p50)}、p95 ${ms(values.p95)}、最长 ${ms(values.max)}`
}

// ---- 各项 ----

function persistence(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '持久保存'
  const facts = factsOf(reports, 'storage')
  if (facts === undefined)
    return noStep(1, title, 'storage')
  if (facts['persist.supported'] === false)
    return { item: 1, title, status: 'record', lines: ['没有 navigator.storage.persist 与 persisted'], missing: [] }
  const keys = ['persist.supported', 'persist.before', 'persist.result', 'persist.after']
  const missing = keys.filter(key => !(key in facts))
  const lines = [`persisted ${text(facts['persist.before'])} → persist() ${text(facts['persist.result'])} → persisted ${text(facts['persist.after'])}（新的源、没有用户激活；常用站点的实际授予以本机草稿页显示的为准）`]
  return { item: 1, title, status: missing.length > 0 ? 'missing' : 'record', lines, missing }
}

function quotaAndUsage(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '配额与用量'
  const facts = factsOf(reports, 'storage')
  if (facts === undefined)
    return noStep(2, title, 'storage')
  if (facts['estimate.supported'] === false)
    return { item: 2, title, status: 'fail', lines: ['没有 navigator.storage.estimate（本机草稿页要显示用量与配额，US-M4-07）'], missing: [] }
  const keys = ['estimate.supported', 'estimate.quota-before', 'estimate.usage-before', 'estimate.usage-after', 'estimate.written']
  const missing = keys.filter(key => !(key in facts))
  if (missing.length > 0)
    return { item: 2, title, status: 'missing', lines: [], missing }
  const quota = number(facts['estimate.quota-before'])
  const before = number(facts['estimate.usage-before'])
  const after = number(facts['estimate.usage-after'])
  const written = number(facts['estimate.written'])
  if (quota === undefined || before === undefined || after === undefined || written === undefined)
    return { item: 2, title, status: 'fail', lines: [`estimate() 给出的不是数：配额 ${text(facts['estimate.quota-before'])}、用量 ${text(facts['estimate.usage-before'])} → ${text(facts['estimate.usage-after'])}`], missing: [] }
  const growth = after - before
  const ratio = growth / written
  const idb = number(facts['estimate.idb-before']) === undefined ? '' : `；IndexedDB 的用量 ${text(facts['estimate.idb-before'])} → ${text(facts['estimate.idb-after'])}`
  const lines = [`配额 ${quota} 字节（${(quota / 1024 ** 3).toFixed(2)} GiB）；写 ${written} 字节前后用量 ${before} → ${after}，增长 ${growth} 字节（写入量的 ${ratio.toFixed(2)} 倍）${idb}`]
  if (number(facts['estimate.usage-deleted']) !== undefined)
    lines.push(`删掉这个库之后用量 ${text(facts['estimate.usage-deleted'])} 字节`)
  const pass = quota > 0 && ratio >= 0.1 && ratio <= 10
  return { item: 2, title, status: pass ? 'pass' : 'fail', lines: pass ? lines : [...lines, '不对：配额要大于 0，用量的增长要与写入量同一量级（0.1–10 倍）'], missing: [] }
}

function durability(reports: readonly ProbeReport[]): ItemVerdict {
  const title = 'durability'
  const entry = reportOf(reports, 'storage')
  const facts = entry?.report.facts
  if (entry === undefined || facts === undefined)
    return noStep(3, title, 'storage')
  const timings = entry.report.timings ?? []
  const defaults = timings.find(timing => timing.id === 'durability.default')
  const stricts = timings.find(timing => timing.id === 'durability.strict')
  const missing = [
    ...['durability.supported', 'durability.strict-attribute', 'durability.default-attribute', 'durability.bytes'].filter(key => !(key in facts)),
    ...(defaults === undefined ? ['durability.default'] : []),
    ...(stricts === undefined ? ['durability.strict'] : []),
  ]
  if (missing.length > 0)
    return { item: 3, title, status: 'missing', lines: [], missing }
  const plain = distribution(samplesOf(defaults))
  const strict = distribution(samplesOf(stricts))
  const overhead = plain === null || strict === null ? undefined : strict.p50 - plain.p50
  return {
    item: 3,
    title,
    status: 'record',
    lines: [
      `durability ${facts['durability.supported'] === true ? '在' : '不在'} IDBTransaction 上；请求 strict 时事务的 durability 属性是 ${text(facts['durability.strict-attribute'])}，请求 default 时是 ${text(facts['durability.default-attribute'])}`,
      // 落不落盘看这次的上下文：真实 Safari 的普通窗口与持久上下文在磁盘上，Playwright 默认的上下文在内存里（设计 §1 偏差 7），由报告写明
      `${text(facts['durability.bytes'])} 字节交替各写 ${plain?.n ?? 0} 次：default ${spread(plain)}；strict ${spread(strict)}；strict 比 default 多 ${ms(overhead)}（中位数）`,
    ],
    missing: [],
  }
}

function quotaFill(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '写满'
  const facts = factsOf(reports, 'storage-quota')
  if (facts === undefined)
    return { item: 4, title, status: 'unavailable', lines: ['这次没有写满的一步（真实 Safari 没有覆盖配额的接口，写满由第 5 项的回滚作有界的替代；Chromium 系经 CDP 覆盖配额，在 Playwright 里做）'], missing: [] }
  if (facts['quota.fill'] === 'not-full')
    return { item: 4, title, status: 'unavailable', lines: [`加了 ${text(facts['quota.records'])} 条 1 MiB（上限 ${text(facts['quota.limit'])} 字节）都没有写满：配额没有被覆盖（estimate() 说 ${text(facts['quota.estimate'])} 字节），写到上限就停`], missing: [] }
  const lines = [`加了 ${text(facts['quota.records'])} 条 1 MiB 之后 ${text(facts['quota.new-error'])}（在${facts['quota.new-error-at'] === 'request' ? '请求' : '事务'}上；estimate() 照旧说配额 ${text(facts['quota.estimate'])} 字节）；覆盖已有的一条：${text(facts['quota.overwrite-error'])}`]
  return ruled(4, title, facts, [
    ['quota.fill', is('filled'), 'filled'],
    ['quota.new-error', is('QuotaExceededError'), 'QuotaExceededError'],
    ['quota.new-absent', is(true), 'true（失败的那一条不在）'],
    ['quota.overwrite-error', is('QuotaExceededError'), 'QuotaExceededError'],
    ['quota.original-kept', is(true), 'true（原记录逐字节不变）'],
    ['quota.original-opens', is(true), 'true（原记录能解开）'],
  ], lines)
}

function rollback(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '回滚（写满的有界替代）'
  const facts = factsOf(reports, 'storage')
  if (facts === undefined)
    return noStep(5, title, 'storage')
  return ruled(5, title, facts, [
    ['rollback.abort-error', is('AbortError'), 'AbortError'],
    ['rollback.abort-kept', is(true), 'true'],
    ['rollback.abort-new-absent', is(true), 'true'],
    ['rollback.abort-writer-kept', is(true), 'true'],
    ['rollback.constraint-error', is('ConstraintError'), 'ConstraintError'],
    ['rollback.constraint-kept', is(true), 'true'],
    ['rollback.constraint-new-absent', is(true), 'true'],
    ['rollback.constraint-writer-kept', is(true), 'true'],
  ], ['两个仓库的事务：put 之后 abort、put 之后违反约束——已有的记录逐字节不变、新的不在、写入者不变'])
}

function indexedDbBasics(reports: readonly ProbeReport[]): ItemVerdict {
  const title = 'IndexedDB 的基本行为'
  const facts = factsOf(reports, 'storage')
  if (facts === undefined)
    return noStep(6, title, 'storage')
  const lines = [`两个对象仓库（${text(facts['idb.stores'])}）；${text(facts['idb.large-bytes'])} 字节写进去 ${ms(number(facts['idb.large-write-ms']))}（strict）；Worker 里打开 v${text(facts['idb.worker-version'])}；versionchange 时 Worker 的升级${facts['idb.versionchange-blocked'] === true ? '先被 blocked' : '没有被 blocked'}；indexedDB.databases()：${text(facts['idb.databases'])}，删掉之后 ${text(facts['idb.databases-after-delete'])}`]
  return ruled(6, title, facts, [
    ['idb.stores', is('drafts,writers'), 'drafts,writers'],
    ['idb.large-digest-match', is(true), 'true（5 MiB 的字节读回来摘要一致）'],
    ['idb.upgrade-kept', is(true), 'true（升级之后数据还在）'],
    ['idb.worker-read-match', is(true), 'true（Worker 读到页面写的）'],
    ['idb.worker-wrote-match', is(true), 'true（页面读到 Worker 写的）'],
    ['idb.versionchange', is(true), 'true（页面收到 versionchange）'],
    ['idb.versionchange-version', is(3), '3（Worker 的升级做完）'],
    ['idb.databases', oneOf('listed', 'unsupported'), 'listed'],
    ['idb.deleted', is(true), 'true'],
    ['idb.databases-after-delete', oneOf('absent', 'unsupported'), 'absent'],
  ], lines)
}

const RAW_RULES: readonly Rule[] = [
  ['crypto.page-raw-zeroed', is(true), 'true（页面这一份原始字节导入之后清零）'],
  ['crypto.raw-extractable', is(false), 'false'],
  ['crypto.raw-zeroed', is(true), 'true（Worker 导入之后清零）'],
  ['crypto.raw-opened-page-seal', is(true), 'true'],
  ['crypto.raw-tampered', is('OperationError'), 'OperationError'],
  ['crypto.raw-page-opens-worker-seal', is(true), 'true'],
  ['crypto.raw-gzip', is(true), 'true'],
  ['crypto.raw-digest', is(true), 'true'],
]

function keyTransfer(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '不可导出的 CryptoKey 交给 Worker'
  const facts = factsOf(reports, 'key-transfer')
  if (facts === undefined)
    return noStep(7, title, 'key-transfer')
  if (!('crypto.key-transfer' in facts))
    return { item: 7, title, status: 'missing', lines: [], missing: ['crypto.key-transfer'] }
  const raw = judge(facts, RAW_RULES)
  const fallback = raw.missing.length === 0 && raw.wrong.length === 0
    ? '退路可行：原始字节转移给 Worker、在 Worker 里导入成不可导出的密钥（导入之后清零），加密、AAD、gzip 与 SHA-256 都对'
    : `退路（Worker 里导入）也不行：${[...raw.missing.map(key => `缺 ${key}`), ...raw.wrong].join('；')}`
  if (facts['crypto.key-transfer'] !== 'ok') {
    const why = facts['crypto.key-transfer'] === 'timeout' ? '超时（可能停在钥匙串的提示上）' : `失败：${text(facts['crypto.key-transfer'])}`
    return { item: 7, title, status: 'fail', lines: [`CryptoKey 经 postMessage 交给 Worker：${why}（${text(facts['crypto.key-transfer-detail'])}）`, fallback], missing: [] }
  }
  return ruled(7, title, facts, [
    ['crypto.key-type', is('secret'), 'secret'],
    ['crypto.key-extractable', is(false), 'false'],
    ['crypto.key-opened-page-seal', is(true), 'true（Worker 解开页面封的）'],
    ['crypto.key-tampered', is('OperationError'), 'OperationError（AAD 改一个字段之后解不开）'],
    ['crypto.key-page-opens-worker-seal', is(true), 'true（页面解开 Worker 封的）'],
    ['crypto.key-gzip', is(true), 'true（Worker 里的 CompressionStream）'],
    ['crypto.key-digest', is(true), 'true（Worker 里的 SHA-256）'],
  ], [`CryptoKey 经 postMessage 交给 Worker：${ms(number(facts['crypto.key-transfer-ms']))}，${text(facts['crypto.key-algorithm'])}、用途 ${text(facts['crypto.key-usages'])}；没有钥匙串的提示`, fallback])
}

function webLocks(reports: readonly ProbeReport[]): ItemVerdict {
  const title = 'Web Locks（页面与 Worker）'
  const facts = factsOf(reports, 'storage')
  if (facts === undefined)
    return noStep(8, title, 'storage')
  if (facts['locks.supported'] === false)
    return { item: 8, title, status: 'fail', lines: ['没有 navigator.locks（M3 的本机锁与 M4 的写入栅栏都建在它上面；没有时 M3 退化为"当作已持有"，防线只剩写入者的核对）'], missing: [] }
  return ruled(8, title, facts, [
    ['locks.supported', is(true), 'true'],
    ['locks.if-available', is('null'), 'null（页面拿着时 Worker 以 ifAvailable 申请拿不到）'],
    ['locks.query-held', is(1), '1'],
    ['locks.steal-granted', is(true), 'true'],
    ['locks.page-request', is('AbortError'), 'AbortError（被抢之后页面的申请结束）'],
    ['locks.query-after-steal', is(1), '1'],
    ['locks.after-terminate', is('granted'), 'granted（终止 Worker 之后锁被释放）'],
  ], [`ifAvailable ${text(facts['locks.if-available'])}、query ${text(facts['locks.query-held'])}、steal 之后页面的申请 ${text(facts['locks.page-request'])}、终止 Worker 之后 ${ms(number(facts['locks.release-ms']))} 内重新拿到`])
}

/** 停顿复核的一组：有没有空定时器 × 空闲的档 */
export interface StallGroup {
  readonly keepAlive: boolean
  /** 空闲的档（毫秒：200、1000、3000、10000） */
  readonly level: number
  readonly n: number
  readonly digest: Distribution | null
  readonly gzip: Distribution | null
  readonly worker: Distribution | null
  readonly send: Distribution | null
  /** 停顿：SHA-256 或 gzip 比这一组的中位数多出 ≥ STALL_EXCESS_MS 的次数 */
  readonly stalls: number
  /** 多出 30 ms 以上、不到停顿的次数 */
  readonly minor: number
  /** 停顿的那几次多出了多少（毫秒） */
  readonly excess: readonly number[]
}

/** 停顿复核的计时（stall#n）按条件分组（纯函数）：没有空定时器的在前，空闲从短到长 */
export function stallGroups(timings: readonly SelftestTiming[]): StallGroup[] {
  const samples = timings.filter(timing => timing.id.startsWith('stall#')).map(timing => timing.ms)
  const keys = [...new Set(samples.map(sample => `${sample.keepAlive ?? 0}:${sample.level ?? 0}`))]
  return keys.map((key) => {
    const [keepAlive, level] = key.split(':').map(Number)
    const group = samples.filter(sample => (sample.keepAlive ?? 0) === keepAlive && (sample.level ?? 0) === level)
    const values = (field: string): number[] => group.map(sample => sample[field]).filter((value): value is number => typeof value === 'number')
    const digest = distribution(values('digest'))
    const gzip = distribution(values('gzip'))
    const excess = group.map(sample => Math.max((sample.digest ?? 0) - (digest?.p50 ?? 0), (sample.gzip ?? 0) - (gzip?.p50 ?? 0)))
    return {
      keepAlive: keepAlive === 1,
      level: level ?? 0,
      n: group.length,
      digest,
      gzip,
      worker: distribution(values('worker')),
      send: distribution(values('send')),
      stalls: excess.filter(value => value >= STALL_EXCESS_MS).length,
      minor: excess.filter(value => value >= MINOR_EXCESS_MS && value < STALL_EXCESS_MS).length,
      excess: excess.filter(value => value >= STALL_EXCESS_MS).map(value => Math.round(value)),
    }
  }).sort((a, b) => Number(a.keepAlive) - Number(b.keepAlive) || a.level - b.level)
}

const LEVEL_TEXT: Readonly<Record<number, string>> = { 200: '0.2 秒', 1000: '1–1.5 秒', 3000: '3 秒', 10_000: '10 秒' }

function workerStall(reports: readonly ProbeReport[]): ItemVerdict {
  const title = 'Worker 的停顿（探针 Worker，第一轮）'
  const entry = reportOf(reports, 'worker-stall')
  if (entry === undefined)
    return noStep(9, title, 'worker-stall')
  const groups = stallGroups(entry.report.timings ?? [])
  if (groups.length === 0)
    return { item: 9, title, status: 'missing', lines: [], missing: ['stall#*'] }
  const lines = groups.map(group => `${group.keepAlive ? '有' : '没有'}空定时器：空闲 ${LEVEL_TEXT[group.level] ?? `${group.level} ms`} ${group.n} 次里 ${group.stalls} 次停顿${group.stalls > 0 ? `（多出 ${group.excess.join('、')} ms）` : ''}、${group.minor} 次小延迟；SHA-256 ${spread(group.digest)}；gzip p50 ${ms(group.gzip?.p50)}；Worker 段 ${spread(group.worker)}；送达 p95 ${ms(group.send?.p95)}`)
  // 判定看有空定时器（生产的 Worker 开着它）、空闲 ≥ 1 秒（M0 出现停顿的条件）的那几组
  const decisive = groups.filter(group => group.keepAlive && group.level >= 1000)
  const decisiveWorker = distribution((entry.report.timings ?? [])
    .filter(timing => timing.id.startsWith('stall#') && timing.ms.keepAlive === 1 && (timing.ms.level ?? 0) >= 1000)
    .map(timing => timing.ms.worker)
    .filter((value): value is number => typeof value === 'number'))
  if (decisive.length === 0)
    return { item: 9, title, status: 'missing', lines, missing: ['有空定时器、空闲 ≥ 1 秒的计时'] }
  const stalls = decisive.reduce((total, group) => total + group.stalls, 0)
  const p95 = decisiveWorker?.p95 ?? Number.NaN
  const pass = stalls === 0 && p95 <= WORKER_SEGMENT_P95_MS
  lines.push(pass
    ? `有空定时器、空闲 ≥ 1 秒：0 次停顿，Worker 段 p95 ${ms(p95)}（≤ ${WORKER_SEGMENT_P95_MS} ms）：保留 Worker 放置（S8 用生产的 Worker 再跑一次定下）`
    : `有空定时器、空闲 ≥ 1 秒：${stalls} 次停顿，Worker 段 p95 ${ms(p95)}：WebKit 改在主线程放置（前提是主线程 gzip 的最长阻塞 ≤ ${MAIN_GZIP_LAG_MS} ms，见第 10 项）`)
  return { item: 9, title, status: pass ? 'pass' : 'fail', lines, missing: [] }
}

interface CaptureFigures {
  readonly stepId: string
  readonly rawBytes: number
  readonly sync: Distribution | null
  readonly workerLag: Distribution | null
  readonly gzipLag: Distribution | null
}

function captureFigures(entry: ProbeReport): CaptureFigures {
  const timings = entry.report.timings ?? []
  return {
    stepId: entry.stepId,
    rawBytes: number(entry.report.facts?.['capture.raw-bytes']) ?? 0,
    sync: distribution(fieldOf(timings, 'capture.sync', 'total')),
    workerLag: distribution(fieldOf(timings, 'capture.worker', 'lagMax')),
    gzipLag: distribution(fieldOf(timings, 'capture.main-gzip', 'lagMax')),
  }
}

function captureCost(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '捕获的主线程成本'
  const entries = reports.filter(entry => entry.report.scenario === 'capture-cost')
  const lines = entries.map((entry) => {
    const facts = entry.report.facts ?? {}
    const timings = entry.report.timings ?? []
    const figures = captureFigures(entry)
    const gzipP95 = figures.gzipLag?.p95
    const fallback = gzipP95 === undefined ? '' : gzipP95 <= MAIN_GZIP_LAG_MS ? `（≤ ${MAIN_GZIP_LAG_MS} ms：退路的前提成立）` : `（> ${MAIN_GZIP_LAG_MS} ms：退路的前提不成立）`
    return [
      `${entry.stepId}（快照 ${text(facts['capture.raw-bytes'])} 字节，gzip 之后 ${text(facts['capture.gzip-bytes'])}）：同步段 ${spread(figures.sync)}（save p50 ${ms(distribution(fieldOf(timings, 'capture.sync', 'save'))?.p50)}、序列化 p50 ${ms(distribution(fieldOf(timings, 'capture.sync', 'stringify'))?.p50)}、编码 p50 ${ms(distribution(fieldOf(timings, 'capture.sync', 'encode'))?.p50)}）`,
      `  Worker 放置：往返 p50 ${ms(distribution(fieldOf(timings, 'capture.worker', 'roundTrip'))?.p50)}（Worker 段 p50 ${ms(distribution(fieldOf(timings, 'capture.worker', 'worker'))?.p50)}），异步段主线程的最长阻塞 ${spread(figures.workerLag)}、最长帧间隔 p95 ${ms(distribution(fieldOf(timings, 'capture.worker', 'frameMax'))?.p95)}`,
      `  主线程 gzip 的最长阻塞 p95 ${ms(gzipP95)}${fallback}，gzip 本身 p50 ${ms(distribution(fieldOf(timings, 'capture.main-gzip', 'total'))?.p50)}；主线程整条管道 p50 ${ms(distribution(fieldOf(timings, 'capture.main-pipeline', 'total'))?.p50)}（写入 p50 ${ms(distribution(fieldOf(timings, 'capture.main-pipeline', 'put'))?.p50)}），最长阻塞 p95 ${ms(distribution(fieldOf(timings, 'capture.main-pipeline', 'lagMax'))?.p95)}`,
    ]
  }).flat()
  const figures = entries.map(captureFigures)
  const small = figures.find(entry => entry.rawBytes > 0 && entry.rawBytes < SMALL_CAPTURE_MAX_BYTES)
  if (small === undefined || figures.some(entry => entry.sync === null || entry.workerLag === null))
    return { item: 10, title, status: 'missing', lines, missing: small === undefined ? ['约 1 MiB 的捕获（capture-1m）'] : ['capture.sync#*、capture.worker#*'] }
  const problems = [
    ...((small.sync?.p95 ?? Number.NaN) <= CAPTURE_SYNC_P95_MS ? [] : [`${small.stepId} 的同步段 p95 ${ms(small.sync?.p95)} 超过 ${CAPTURE_SYNC_P95_MS} ms（计划书 §12.2）`]),
    ...figures.filter(entry => (entry.workerLag?.p50 ?? Number.NaN) > WORKER_ASYNC_LAG_MS).map(entry => `${entry.stepId} 在 Worker 放置时异步段主线程的最长阻塞（中位数）${ms(entry.workerLag?.p50)} 超过 ${WORKER_ASYNC_LAG_MS} ms`),
  ]
  return { item: 10, title, status: problems.length === 0 ? 'pass' : 'fail', lines: [...lines, ...problems.map(problem => `不对：${problem}`)], missing: [] }
}

const MODE_TEXT: Readonly<Record<string, string>> = { 'worker': ' Worker', 'main-thread': '主线程' }

function rounds(timings: readonly SelftestTiming[], prefix: string): string {
  const settle = distribution(fieldOf(timings, prefix, 'settle'))
  const lag = Math.max(...fieldOf(timings, prefix, 'lagMax'))
  const frame = Math.max(...fieldOf(timings, prefix, 'frameMax'))
  return `×${settle?.n ?? 0} 收齐 p50 ${ms(settle?.p50)}、最长 ${ms(settle?.max)}，主线程最长阻塞 ${ms(lag)}、最长帧间隔 ${ms(frame)}`
}

function perfBaseline(reports: readonly ProbeReport[]): ItemVerdict {
  const title = '首屏与公式冻结（只作对照）'
  const entries = reports.filter(entry => entry.report.scenario === 'perf-baseline')
  if (entries.length === 0)
    return noStep(12, title, 'perf-baseline')
  const missing: string[] = []
  const lines = entries.map((entry) => {
    const facts = entry.report.facts ?? {}
    const timings = entry.report.timings ?? []
    for (const key of ['perf.ready', 'perf.steady', 'perf.formula-mode']) {
      if (!(key in facts))
        missing.push(`${entry.stepId}：${key}`)
    }
    if (fieldOf(timings, 'perf.incremental', 'settle').length === 0 || fieldOf(timings, 'perf.full', 'settle').length === 0)
      missing.push(`${entry.stepId}：perf.incremental#*、perf.full#*`)
    const mode = MODE_TEXT[text(facts['perf.formula-mode'])] ?? text(facts['perf.formula-mode'])
    return `${entry.stepId}（${entry.cold ? '冷' : '热'}，公式在${mode}）：首屏到渲染完成 ${ms(number(facts['perf.ready']))}、到 steady ${ms(number(facts['perf.steady']))}；脚本经网络 ${text(facts['perf.script-transfer-bytes'])} 字节；增量 ${rounds(timings, 'perf.incremental')}；全量 ${rounds(timings, 'perf.full')}`
  })
  return { item: 12, title, status: missing.length > 0 ? 'missing' : 'record', lines, missing }
}

/** 全部的项（设计 §3.6 第 1–10、12 项；第 11 项在 S8 用生产的发件箱跑），按项的顺序 */
export function probeVerdicts(reports: readonly ProbeReport[]): ItemVerdict[] {
  return [
    persistence(reports),
    quotaAndUsage(reports),
    durability(reports),
    quotaFill(reports),
    rollback(reports),
    indexedDbBasics(reports),
    keyTransfer(reports),
    webLocks(reports),
    workerStall(reports),
    captureCost(reports),
    perfBaseline(reports),
  ]
}

/** 打印与写进报告的行：每一项一行标题与结论，下面是说明（缩进两格），缺了的列在最后 */
export function verdictLines(verdicts: readonly ItemVerdict[]): string[] {
  return verdicts.flatMap(verdict => [
    `第 ${verdict.item} 项 ${verdict.title}：${STATUS_TEXT[verdict.status]}`,
    ...verdict.lines.map(line => `  ${line}`),
    ...(verdict.missing.length === 0 ? [] : [`  缺：${verdict.missing.join('、')}`]),
  ])
}

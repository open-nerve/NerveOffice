// 真实浏览器的前置复核的判定（probe-verdicts.ts，M4-P1 设计 §3.6）：页面交回的事实与计时 → 每一项的结论。纯函数，不起浏览器
import type { SelftestFact, SelftestReport, SelftestTiming } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { ProbeReport } from './probe-verdicts.ts'
import { describe, expect, it } from 'vitest'
import { SELFTEST_REPORT_FORMAT } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { probeVerdicts, stallGroups, verdictLines } from './probe-verdicts.ts'

function report(scenario: string, facts: Record<string, SelftestFact>, timings: SelftestTiming[] = []): SelftestReport {
  return {
    format: SELFTEST_REPORT_FORMAT,
    scenario,
    documentId: `${scenario}-doc`,
    userAgent: 'Safari',
    startedAt: '2026-10-09T08:00:00.000Z',
    finishedAt: '2026-10-09T08:01:00.000Z',
    page: { state: 'ready', readOnly: true },
    visibility: [],
    checks: [{ id: 'x', pass: true, detail: '', ms: 1 }],
    pageErrors: [],
    consoleErrors: [],
    ignoredNotices: [],
    facts,
    timings,
  }
}

function probe(stepId: string, scenario: string, facts: Record<string, SelftestFact>, timings: SelftestTiming[] = [], cold = false): ProbeReport {
  return { stepId, report: report(scenario, facts, timings), cold }
}

const STORAGE_FACTS: Record<string, SelftestFact> = {
  'persist.supported': true,
  'persist.before': false,
  'persist.result': false,
  'persist.after': false,
  'estimate.supported': true,
  'estimate.quota-before': 10_000_000_000,
  'estimate.usage-before': 20_000,
  'estimate.idb-before': null,
  'estimate.written': 5_242_880,
  'estimate.quota-after': 10_000_000_000,
  'estimate.usage-after': 5_300_000,
  'estimate.idb-after': null,
  'idb.stores': 'drafts,writers',
  'idb.large-bytes': 5_242_880,
  'idb.large-write-ms': 41.5,
  'idb.large-digest-match': true,
  'idb.upgrade-version': 2,
  'idb.upgrade-kept': true,
  'idb.worker-version': 2,
  'idb.worker-read-match': true,
  'idb.worker-wrote-match': true,
  'idb.versionchange': true,
  'idb.versionchange-blocked': false,
  'idb.versionchange-version': 3,
  'idb.databases': 'listed',
  'rollback.abort-error': 'AbortError',
  'rollback.abort-kept': true,
  'rollback.abort-new-absent': true,
  'rollback.abort-writer-kept': true,
  'rollback.constraint-error': 'ConstraintError',
  'rollback.constraint-kept': true,
  'rollback.constraint-new-absent': true,
  'rollback.constraint-writer-kept': true,
  'durability.supported': true,
  'durability.bytes': 1_363_149,
  'durability.default-attribute': 'default',
  'durability.strict-attribute': 'strict',
  'locks.supported': true,
  'locks.if-available': 'null',
  'locks.query-held': 1,
  'locks.steal-granted': true,
  'locks.page-request': 'AbortError',
  'locks.query-after-steal': 1,
  'locks.after-terminate': 'granted',
  'locks.release-ms': 3.2,
  'idb.deleted': true,
  'idb.databases-after-delete': 'absent',
}

const DURABILITY_TIMINGS: SelftestTiming[] = [
  { id: 'durability.default', ms: { 1: 10, 2: 12, 3: 11 } },
  { id: 'durability.strict', ms: { 1: 20, 2: 25, 3: 22 } },
]

const KEY_FACTS: Record<string, SelftestFact> = {
  'crypto.raw-extractable': false,
  'crypto.raw-zeroed': true,
  'crypto.raw-opened-page-seal': true,
  'crypto.raw-tampered': 'OperationError',
  'crypto.raw-page-opens-worker-seal': true,
  'crypto.raw-gzip': true,
  'crypto.raw-digest': true,
  'crypto.page-raw-zeroed': true,
  'crypto.key-transfer': 'ok',
  'crypto.key-transfer-ms': 2.1,
  'crypto.key-type': 'secret',
  'crypto.key-extractable': false,
  'crypto.key-algorithm': 'AES-GCM-256',
  'crypto.key-usages': 'decrypt,encrypt',
  'crypto.key-opened-page-seal': true,
  'crypto.key-tampered': 'OperationError',
  'crypto.key-page-opens-worker-seal': true,
  'crypto.key-gzip': true,
  'crypto.key-digest': true,
}

function verdict(reports: readonly ProbeReport[], item: number) {
  const found = probeVerdicts(reports).find(entry => entry.item === item)
  if (found === undefined)
    throw new Error(`没有第 ${item} 项`)
  return found
}

describe('存储的几项（storage 一步）', () => {
  const storage = [probe('storage', 'storage', STORAGE_FACTS, DURABILITY_TIMINGS)]

  it('第 1 项持久保存只记录事实；第 3 项 durability 记录支持与否与开销（中位数之差）', () => {
    expect(verdict(storage, 1)).toMatchObject({ status: 'record', missing: [] })
    expect(verdict(storage, 1).lines.join('\n')).toContain('persisted false → persist() false → persisted false')
    const durability = verdict(storage, 3)
    expect(durability).toMatchObject({ status: 'record', missing: [] })
    expect(durability.lines.join('\n')).toContain('请求 strict 时事务的 durability 属性是 strict')
    expect(durability.lines.join('\n')).toContain('strict 比 default 多 11 ms（中位数）')
  })

  it('第 2 项：配额大于 0、用量的增长与写入量同一量级才通过；增长太少（例如没算进来）或配额是 0 不通过', () => {
    expect(verdict(storage, 2).status).toBe('pass')
    expect(verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'estimate.usage-after': 30_000 }, DURABILITY_TIMINGS)], 2).status).toBe('fail')
    expect(verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'estimate.quota-before': 0 }, DURABILITY_TIMINGS)], 2).status).toBe('fail')
    expect(verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'estimate.usage-after': 300_000_000 }, DURABILITY_TIMINGS)], 2).status).toBe('fail')
  })

  it('第 5、6、8 项：事实全对才通过；任何一条不对都不通过，并说出是哪一条', () => {
    for (const item of [5, 6, 8])
      expect(verdict(storage, item).status, `第 ${item} 项`).toBe('pass')
    const kept = verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'rollback.abort-kept': false }, DURABILITY_TIMINGS)], 5)
    expect(kept.status).toBe('fail')
    expect(kept.lines.join('\n')).toContain('rollback.abort-kept')
    expect(verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'idb.versionchange': false }, DURABILITY_TIMINGS)], 6).status).toBe('fail')
    expect(verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'locks.page-request': 'still-held' }, DURABILITY_TIMINGS)], 8).status).toBe('fail')
  })

  it('浏览器没有 estimate()、没有 Web Locks：不通过（不是数据不齐），说出没有什么', () => {
    const noEstimate = verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'estimate.supported': false }, DURABILITY_TIMINGS)], 2)
    expect(noEstimate.status).toBe('fail')
    expect(noEstimate.lines.join('\n')).toContain('没有 navigator.storage.estimate')
    const { 'locks.if-available': _a, 'locks.query-held': _b, 'locks.steal-granted': _c, 'locks.page-request': _d, 'locks.query-after-steal': _e, 'locks.after-terminate': _f, ...noLocks } = STORAGE_FACTS
    const locks = verdict([probe('storage', 'storage', { ...noLocks, 'locks.supported': false }, DURABILITY_TIMINGS)], 8)
    expect(locks).toMatchObject({ status: 'fail', missing: [] })
    expect(locks.lines.join('\n')).toContain('没有 navigator.locks')
  })

  it('indexedDB.databases() 不支持时不算不通过（记下）', () => {
    expect(verdict([probe('storage', 'storage', { ...STORAGE_FACTS, 'idb.databases': 'unsupported', 'idb.databases-after-delete': 'unsupported' }, DURABILITY_TIMINGS)], 6).status).toBe('pass')
  })

  it('缺了事实（数据不齐）：列在 missing 里，结论是 missing；没有 storage 这一步时各项都是 missing', () => {
    const { 'locks.after-terminate': _dropped, ...rest } = STORAGE_FACTS
    expect(verdict([probe('storage', 'storage', rest, DURABILITY_TIMINGS)], 8)).toMatchObject({ status: 'missing', missing: ['locks.after-terminate'] })
    expect(verdict([], 6).status).toBe('missing')
    expect(verdict([probe('storage', 'storage', STORAGE_FACTS)], 3)).toMatchObject({ status: 'missing', missing: ['durability.default', 'durability.strict'] })
  })
})

describe('第 7 项：不可导出的 CryptoKey 交给 Worker（key-transfer 一步）', () => {
  it('交过去、不可导出、解得开、改 AAD 之后 OperationError、Worker 封的页面解得开、Worker 里 gzip 与 SHA-256 都对：通过', () => {
    expect(verdict([probe('key-transfer', 'key-transfer', KEY_FACTS)], 7)).toMatchObject({ status: 'pass', missing: [] })
  })

  it('交不过去（DataCloneError）或超时（钥匙串的提示？）：不通过；退路（Worker 里导入）可行时写明改用它', () => {
    const failed = verdict([probe('key-transfer', 'key-transfer', { ...KEY_FACTS, 'crypto.key-transfer': 'timeout', 'crypto.key-type': null })], 7)
    expect(failed.status).toBe('fail')
    expect(failed.lines.join('\n')).toContain('退路可行')
    const clone = verdict([probe('key-transfer', 'key-transfer', { ...KEY_FACTS, 'crypto.key-transfer': 'DataCloneError' })], 7)
    expect(clone.status).toBe('fail')
  })

  it('退路的核对也包括页面这一份原始字节用完清零：没清零时写明退路不行', () => {
    const failed = verdict([probe('key-transfer', 'key-transfer', { ...KEY_FACTS, 'crypto.key-transfer': 'DataCloneError', 'crypto.page-raw-zeroed': false })], 7)
    expect(failed.lines.join('\n')).toContain('退路（Worker 里导入）也不行')
    expect(failed.lines.join('\n')).toContain('crypto.page-raw-zeroed')
  })

  it('交过去了但是可以导出、或者改了 AAD 还解得开：不通过', () => {
    expect(verdict([probe('key-transfer', 'key-transfer', { ...KEY_FACTS, 'crypto.key-extractable': true })], 7).status).toBe('fail')
    expect(verdict([probe('key-transfer', 'key-transfer', { ...KEY_FACTS, 'crypto.key-tampered': '解开了' })], 7).status).toBe('fail')
  })
})

describe('第 4 项：写满（storage-quota 一步）', () => {
  const filled = { 'quota.estimate': 10_737_420_115, 'quota.limit': 67_108_864, 'quota.fill': 'filled', 'quota.records': 10, 'quota.new-error': 'QuotaExceededError', 'quota.new-error-at': 'request', 'quota.new-absent': true, 'quota.overwrite-error': 'QuotaExceededError', 'quota.original-kept': true, 'quota.original-opens': true }

  it('QuotaExceededError、失败的那一条不在、覆盖失败之后原记录不变能解开：通过', () => {
    expect(verdict([probe('storage-quota', 'storage-quota', filled)], 4)).toMatchObject({ status: 'pass', missing: [] })
  })

  it('错误的名字不对、或者覆盖成功了（没有失败）：不通过', () => {
    expect(verdict([probe('storage-quota', 'storage-quota', { ...filled, 'quota.new-error': 'UnknownError' })], 4).status).toBe('fail')
    expect(verdict([probe('storage-quota', 'storage-quota', { ...filled, 'quota.overwrite-error': 'none' })], 4).status).toBe('fail')
  })

  it('写到上限都没写满（配额没被覆盖：WebKit 没有这个接口）：做不了，记作 unavailable；没有这一步也是 unavailable（不在真实 Safari 的步骤里）', () => {
    expect(verdict([probe('storage-quota', 'storage-quota', { 'quota.estimate': 1_000_000_000, 'quota.limit': 67_108_864, 'quota.fill': 'not-full', 'quota.records': 64 })], 4).status).toBe('unavailable')
    expect(verdict([], 4).status).toBe('unavailable')
  })
})

/** 一次停顿复核的计时：条件、空闲的档与各段 */
function stall(index: number, keepAlive: boolean, level: number, digest: number, worker = digest + 150, gzip = 60): SelftestTiming {
  return { id: `stall#${index}`, ms: { keepAlive: keepAlive ? 1 : 0, level, idle: level + 3, send: 0.4, digest, gzip, encrypt: 20, put: 30, worker, back: 0.3, roundTrip: worker + 1 } }
}

describe('第 9 项：Worker 的停顿（worker-stall 一步）', () => {
  it('按条件（有没有空定时器 × 空闲的档）分组：次数、SHA-256 的中位数与最长、停顿（比中位数多出 ≥ 500 ms）、Worker 段的 p95', () => {
    const timings = [stall(1, false, 1000, 20), stall(2, false, 1000, 22), stall(3, false, 1000, 1100), stall(4, true, 1000, 21), stall(5, true, 1000, 23)]
    const groups = stallGroups(timings)
    expect(groups.map(group => [group.keepAlive, group.level, group.n, group.stalls])).toEqual([[false, 1000, 3, 1], [true, 1000, 2, 0]])
    expect(groups[0]?.digest).toMatchObject({ p50: 22, max: 1100 })
  })

  it('有空定时器、空闲 ≥ 1 秒的各组 0 次停顿、Worker 段 p95 ≤ 300 ms：通过（保留 Worker 放置）；没有空定时器的停顿只记下', () => {
    const timings = [stall(1, false, 1000, 20), stall(2, false, 1000, 20), stall(3, false, 1000, 1200), stall(4, true, 1000, 20), stall(5, true, 1000, 25), stall(6, true, 200, 20)]
    const result = verdict([probe('worker-stall', 'worker-stall', { 'stall.payload-bytes': 5_100_000 }, timings)], 9)
    expect(result.status).toBe('pass')
    expect(result.lines.join('\n')).toContain('没有空定时器：空闲 1–1.5 秒 3 次里 1 次停顿')
  })

  it('有空定时器仍有停顿，或者 Worker 段 p95 超过 300 ms：不通过（WebKit 改在主线程）', () => {
    const stalled = [stall(1, true, 1000, 20), stall(2, true, 1000, 20), stall(3, true, 1000, 900)]
    expect(verdict([probe('worker-stall', 'worker-stall', {}, stalled)], 9).status).toBe('fail')
    const slow = [stall(1, true, 3000, 20, 400), stall(2, true, 3000, 20, 410)]
    expect(verdict([probe('worker-stall', 'worker-stall', {}, slow)], 9).status).toBe('fail')
  })

  it('gzip 那一段的停顿同样算（M0 把 SHA-256 挪走之后停顿落在 CompressionStream）', () => {
    const timings = [stall(1, true, 1000, 20, 200, 60), stall(2, true, 1000, 20, 200, 60), stall(3, true, 1000, 20, 900, 700)]
    expect(stallGroups(timings)[0]?.stalls).toBe(1)
  })

  it('没有计时：missing', () => {
    expect(verdict([probe('worker-stall', 'worker-stall', {})], 9).status).toBe('missing')
  })
})

function capture(index: number, total: number, workerLag: number, gzipLag: number): SelftestTiming[] {
  return [
    { id: `capture.sync#${index}`, ms: { save: total / 2, stringify: total / 3, encode: total / 6, total } },
    { id: `capture.worker#${index}`, ms: { roundTrip: 200, worker: 190, digest: 10, gzip: 100, encrypt: 30, put: 50, lagMax: workerLag, frameMax: 17 } },
    { id: `capture.main-gzip#${index}`, ms: { total: 120, bytes: 1_200_000, lagMax: gzipLag, frameMax: gzipLag } },
    { id: `capture.main-pipeline#${index}`, ms: { total: 250, digest: 10, gzip: 120, encrypt: 40, put: 80, lagMax: gzipLag, frameMax: gzipLag } },
  ]
}

describe('第 10 项：捕获的主线程成本（capture-1m、capture-5m）', () => {
  const small = probe('capture-1m', 'capture-cost', { 'capture.raw-bytes': 1_050_000, 'capture.gzip-bytes': 260_000, 'capture.formula-mode': 'worker' }, [...capture(1, 40, 5, 30), ...capture(2, 45, 6, 32)])
  const large = probe('capture-5m', 'capture-cost', { 'capture.raw-bytes': 5_090_000, 'capture.gzip-bytes': 1_270_000, 'capture.formula-mode': 'worker' }, [...capture(1, 180, 7, 70), ...capture(2, 190, 8, 75)])

  it('1 MiB 的同步段 p95 ≤ 100 ms、Worker 放置时异步段主线程的最长阻塞（中位数）≤ 10 ms：通过；5 MiB 记录，另写主线程 gzip 的阻塞（退路的前提 ≤ 100 ms）', () => {
    const result = verdict([small, large], 10)
    expect(result).toMatchObject({ status: 'pass', missing: [] })
    expect(result.lines.join('\n')).toContain('主线程 gzip 的最长阻塞 p95 75 ms（≤ 100 ms：退路的前提成立）')
  })

  it('1 MiB 的同步段 p95 超过 100 ms，或者 Worker 放置时主线程仍被占住：不通过', () => {
    const slow = probe('capture-1m', 'capture-cost', small.report.facts ?? {}, [...capture(1, 40, 5, 30), ...capture(2, 130, 6, 32)])
    expect(verdict([slow, large], 10).status).toBe('fail')
    const blocked = probe('capture-1m', 'capture-cost', small.report.facts ?? {}, [...capture(1, 40, 25, 30), ...capture(2, 45, 30, 32)])
    expect(verdict([blocked, large], 10).status).toBe('fail')
  })

  it('没有 1 MiB 的那一步：missing', () => {
    expect(verdict([large], 10).status).toBe('missing')
  })
})

describe('第 12 项：首屏与公式冻结（perf-baseline，只作对照）', () => {
  const timings: SelftestTiming[] = [
    { id: 'perf.incremental#1', ms: { settle: 300, lagMax: 12, frameMax: 20, frames: 18 } },
    { id: 'perf.incremental#2', ms: { settle: 320, lagMax: 14, frameMax: 21, frames: 19 } },
    { id: 'perf.full#1', ms: { settle: 900, lagMax: 15, frameMax: 25, frames: 50 } },
  ]
  const facts = { 'perf.ready': 1850, 'perf.steady': 4900, 'perf.formula-mode': 'worker', 'perf.formulas': 1000, 'perf.script-entries': 30, 'perf.script-transfer-bytes': 3_000_000, 'perf.script-decoded-bytes': 9_000_000 }

  it('每一步一行：冷热、公式模式、首屏、增量与全量的收齐与界面冻结', () => {
    const result = verdict([probe('perf-worker', 'perf-baseline', facts, timings, true), probe('perf-main', 'perf-baseline', { ...facts, 'perf.formula-mode': 'main-thread', 'perf.script-transfer-bytes': 0 }, timings)], 12)
    expect(result.status).toBe('record')
    expect(result.lines[0]).toBe('perf-worker（冷，公式在 Worker）：首屏到渲染完成 1850 ms、到 steady 4900 ms；脚本经网络 3000000 字节；增量 ×2 收齐 p50 300 ms、最长 320 ms，主线程最长阻塞 14 ms、最长帧间隔 21 ms；全量 ×1 收齐 p50 900 ms、最长 900 ms，主线程最长阻塞 15 ms、最长帧间隔 25 ms')
    expect(result.lines[1]).toContain('perf-main（热，公式在主线程）')
  })
})

describe('输出', () => {
  it('每一项一行标题与结论，下面是说明（缩进）', () => {
    const lines = verdictLines(probeVerdicts([probe('key-transfer', 'key-transfer', KEY_FACTS)]))
    expect(lines).toContain('第 7 项 不可导出的 CryptoKey 交给 Worker：通过')
    expect(lines.some(line => line.startsWith('  '))).toBe(true)
  })
})

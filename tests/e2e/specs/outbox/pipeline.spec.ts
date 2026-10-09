// 写入管道与发件箱 Worker（M4-P1 设计 §3.1、§3.4.3–§3.4.8 与 §4 的浏览器层一行）：在真实的浏览器里经测试构建的探针（pipeline 一侧）
// 跑生产的管道、IndexedDB 存储、编解码与 Worker。同一组用例跑两种宿主——进程内（createDraftWriter）与发件箱 Worker（客户端 + 生产的
// Worker 脚本）：编辑器页（P2）只依赖 DraftWriter，两种宿主应当给出同样的结果；WebKit 改在主线程放置时（DEF-011）换的正是宿主。
// 另有只属于 Worker 的：Worker 里读写的事务都要求 strict（记事务的测试脚本）、脚本加载失败与写入途中终止都不挂住。
// 库里的那一份由探针自己的存储读出、用同一把密钥解开（storedGzip），与管道交回的 gzip 逐字节比较（SHA-256）。标签 @test-build
import type { Page } from '@playwright/test'
import type { DraftKey, InFlightSave, PipelineWritten, ProbeCapture, ProbeHost, ProbePipelineOptions, WriterIdentity } from '../../support/outbox-probe.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, NOW, openOutboxProbe, outcomeOf, probe, probePipeline, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

const FORMAT = { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 }

const HOSTS: readonly ProbeHost[] = ['in-process', 'worker']

const HOST_LABELS: Readonly<Record<ProbeHost, string>> = { 'in-process': '进程内', 'worker': '发件箱 Worker' }

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 一次捕获：默认是 writer 写下的第 seq 份，基于第 1 版、不在途、允许去重 */
function captureOf(key: DraftKey, writer: WriterIdentity, draftSeq: number, content: ProbeCapture['content'], overrides: Partial<ProbeCapture> = {}): ProbeCapture {
  return { key, writer, draftSeq, baseRevision: 1, writtenBy: `instance-${writer.writerId}`, format: FORMAT, formulasPending: false, inFlight: null, dedupe: true, content, ...overrides }
}

/** 终止 Worker 时在途的那次写入的结局：写成了（终止之前已经回复）、以 terminated 失败；别的都原样写出来（用例随之失败） */
function terminationOf(result: PipelineWritten): string {
  if (result.kind === 'written')
    return 'written'
  if (result.kind === 'failed' && result.gzip === null && result.error.name === 'OutboxWorkerError' && result.error.message.includes('terminated'))
    return 'terminated'
  return JSON.stringify(result)
}

function inFlightOf(localSeq: number): InFlightSave {
  return { requestId: randomUUID(), clientInstanceId: 'instance-in-flight', localSeq, sentAt: NOW }
}

/** 登录、打开探针、选第 version 版的密钥（随机的一把，不可导出）；交回这份文档的键 */
async function prepare(page: Page, prefix: string, version = 2): Promise<DraftKey> {
  const user = await createUser(prefix)
  await loginThroughApi(page, user)
  await openOutboxProbe(page)
  await probe(page, 'chooseKey', version)
  return { userId: user.id, documentId: randomUUID() }
}

/** 建一个管道、握手成功、交给它探针当前的密钥 */
async function pipelineOn(page: Page, options: ProbePipelineOptions): Promise<number> {
  const { id, ready } = await probePipeline(page, 'create', options)
  expect(ready, `${options.host} 的管道应当就绪`).toEqual({ kind: 'ready' })
  expect(await probePipeline(page, 'setKey', id, 'probe')).toEqual({ kind: 'key-set', notResealed: [] })
  return id
}

for (const host of HOSTS) {
  test.describe(`写入管道（${HOST_LABELS[host]}）`, { tag: '@test-build' }, () => {
    test('整条管道：写入 → 交回的 gzip 就是库里加密的那一份 → 去重 → 标记在途 → 上传期间又写一份 → 确认改基准 → 再确认删掉；大的内容同样一致', async ({ page }) => {
      const key = await prepare(page, `ob-pipe-${host}`)
      const id = await pipelineOn(page, { host })
      const writer = writerOf(3)
      expect(await probePipeline(page, 'register', id, key, writer, false)).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined })

      const first = contentOf(writer, 1)
      const written = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 1, first)), 'written')
      expect(written.gzip.text, '交回的 gzip 解压之后就是写入的内容').toBe(first)
      expect(written.digest).toBe(sha256(first))
      const stored = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect(stored.gzip.sha256, '交回的 gzip 与库里解开的逐字节相同').toBe(written.gzip.sha256)
      expect(stored.meta).toMatchObject({ draftSeq: 1, baseRevision: 1, keyVersion: 2, writeEpoch: 3, writerId: writer.writerId, inFlight: null, rawBytes: new TextEncoder().encode(first).byteLength })
      expect(outcomeOf(await probePipeline(page, 'read', id, key), 'draft').gzip.sha256, '管道读回的也是它').toBe(written.gzip.sha256)

      // 内容没变：不写
      expect(await probePipeline(page, 'write', id, captureOf(key, writer, 2, first))).toEqual({ kind: 'unchanged', digest: written.digest })

      // 上传发出之前标记在途：重封（内容不变、换新的 IV）
      const inFlight = inFlightOf(1)
      expect(await probePipeline(page, 'markInFlight', id, key, writer, inFlight)).toEqual({ kind: 'resealed' })
      const marked = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect([marked.meta.inFlight, marked.gzip.sha256]).toEqual([inFlight, written.gzip.sha256])

      // 上传期间又写了一份（带着在途的请求），然后第 1 份的确认到了：不删，改基准、清掉在途（A08）
      const third = contentOf(writer, 3)
      outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 3, third, { inFlight })), 'written')
      expect(await probePipeline(page, 'confirm', id, key, writer, 1, 2)).toEqual({ kind: 'rebased' })
      const rebased = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect([rebased.meta.draftSeq, rebased.meta.baseRevision, rebased.meta.inFlight, rebased.gzip.text]).toEqual([3, 2, null, third])

      // 第 3 份的确认：删掉；高水位留着
      expect(await probePipeline(page, 'confirm', id, key, writer, 3, 3)).toEqual({ kind: 'deleted' })
      expect(await probePipeline(page, 'storedGzip', key)).toEqual({ kind: 'absent' })
      expect(await probePipeline(page, 'register', id, key, writer, false)).toEqual({ kind: 'registered', lastDraftSeq: 3, existing: undefined })

      // 大的内容（约 2 MiB、几乎压不动）：Worker 转移字节与 gzip，照样一致
      const large = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 4, { randomBase64Chars: 2 * 1024 * 1024 })), 'written')
      expect(large.gzip.textLength).toBe(2 * 1024 * 1024)
      const storedLarge = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect([storedLarge.gzip.sha256, storedLarge.gzip.textSha256, storedLarge.meta.rawBytes]).toEqual([large.gzip.sha256, large.gzip.textSha256, 2 * 1024 * 1024])
    })

    test('换密钥：本页写下的用新密钥重封（内容不变、带上新版本），之后的写入用新密钥；丢掉密钥之后的写入 no-key、照样交回 gzip', async ({ page }) => {
      const key = await prepare(page, `ob-rekey-${host}`)
      const id = await pipelineOn(page, { host })
      const writer = writerOf(3)
      expect((await probePipeline(page, 'register', id, key, writer, false)).kind).toBe('registered')
      outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 1, 'one')), 'written')

      // 心跳得知新版本（P2）：换一把第 3 版的密钥交给管道
      await probe(page, 'chooseKey', 3)
      expect(await probePipeline(page, 'setKey', id, 'probe')).toEqual({ kind: 'key-set', notResealed: [] })
      const rekeyed = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect([rekeyed.meta.keyVersion, rekeyed.meta.draftSeq, rekeyed.gzip.text]).toEqual([3, 1, 'one'])

      outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 2, 'two')), 'written')
      const second = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect([second.meta.keyVersion, second.gzip.text]).toEqual([3, 'two'])

      expect(await probePipeline(page, 'setKey', id, 'none')).toEqual({ kind: 'key-set', notResealed: [] })
      const keyless = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 3, 'three')), 'no-key')
      expect(keyless.gzip.text, '没有密钥时不写本机，上传照旧（交回 gzip）').toBe('three')
      expect(outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip').gzip.text).toBe('two')
    })

    test('写入栅栏：更新的一代登记之后，本页的写入、标记在途、确认都被拒，库里那一份不动', async ({ page }) => {
      const key = await prepare(page, `ob-fence-${host}`)
      const id = await pipelineOn(page, { host })
      const writer = writerOf(3)
      expect((await probePipeline(page, 'register', id, key, writer, false)).kind).toBe('registered')
      const written = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 1, 'mine')), 'written')

      // 别的标签页拿到了第 4 代、登记为写入者（经探针自己的存储）
      expect((await probe(page, 'register', key, writerOf(4), { now: NOW, force: false })).kind).toBe('registered')
      const fenced = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 2, 'late')), 'fenced')
      expect([fenced.reason, fenced.gzip.text]).toEqual(['not-writer', 'late'])
      expect(await probePipeline(page, 'markInFlight', id, key, writer, inFlightOf(1))).toEqual({ kind: 'fenced', reason: 'not-writer' })
      expect(await probePipeline(page, 'confirm', id, key, writer, 1, 2)).toEqual({ kind: 'fenced', reason: 'not-writer' })
      const kept = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect([kept.meta.draftSeq, kept.meta.inFlight, kept.gzip.sha256]).toEqual([1, null, written.gzip.sha256])
    })
  })
}

test.describe('发件箱 Worker', { tag: '@test-build' }, () => {
  test('Worker 里读写的事务都要求 strict、只读的不带（记事务的测试脚本报来）；不可导出的 CryptoKey 经结构化克隆交过去，Worker 封的页面里解得开', async ({ page }) => {
    const key = await prepare(page, 'ob-worker-strict')
    const id = await pipelineOn(page, { host: 'worker', script: 'recording' })
    const writer = writerOf(3)
    expect((await probePipeline(page, 'register', id, key, writer, false)).kind).toBe('registered')
    const written = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 1, 'strict')), 'written')
    expect(outcomeOf(await probePipeline(page, 'read', id, key), 'draft').gzip.sha256).toBe(written.gzip.sha256)
    await expect.poll(async () => (await probePipeline(page, 'workerTransactions', id)).map(tx => [tx.stores, tx.mode, tx.durability])).toEqual([
      [['drafts', 'writers'], 'readwrite', 'strict'],
      [['drafts', 'writers'], 'readwrite', 'strict'],
      [['drafts', 'writers'], 'readonly', undefined],
    ])
    // 页面里用同一把密钥（探针选的那一把）解开 Worker 封的记录
    expect(outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip').gzip.text).toBe('strict')
  })

  test('Worker 脚本加载失败：握手交回 load-failed，之后的请求立即以失败结束（不等看门狗、不挂住），库里什么也没写', async ({ page }) => {
    const key = await prepare(page, 'ob-worker-missing')
    const { id, ready } = await probePipeline(page, 'create', { host: 'worker', script: 'missing', requestTimeoutMs: 120_000 })
    expect(ready).toEqual({ kind: 'broken', failure: 'load-failed' })
    expect(await probePipeline(page, 'broken', id)).toBe('load-failed')
    const started = Date.now()
    const writer = writerOf(3)
    expect(await probePipeline(page, 'register', id, key, writer, false)).toMatchObject({ kind: 'failed', error: { name: 'OutboxWorkerError' } })
    expect(await probePipeline(page, 'write', id, captureOf(key, writer, 1, 'never'))).toMatchObject({ kind: 'failed', gzip: null, error: { name: 'OutboxWorkerError' } })
    expect(Date.now() - started, '立即失败，不等 120 秒的看门狗').toBeLessThan(10_000)
    expect(await probePipeline(page, 'storedGzip', key)).toEqual({ kind: 'absent' })
  })

  test('写入途中终止 Worker：在途的写入以失败（terminated）结束或者已经写成，都不挂住；库里留下的是旧的或新的一份，都解得开', async ({ page }) => {
    const key = await prepare(page, 'ob-worker-terminate')
    const writer = writerOf(3)
    const setup = await pipelineOn(page, { host: 'worker' })
    expect((await probePipeline(page, 'register', setup, key, writer, false)).kind).toBe('registered')
    outcomeOf(await probePipeline(page, 'write', setup, captureOf(key, writer, 1, 'old')), 'written')
    await probePipeline(page, 'dispose', setup)
    let expected = { seq: 1, textSha256: sha256('old') }
    const outcomes: string[] = []
    // 终止的时刻从"发出之后立即"到写入大致做完，落在压缩、加密、事务的不同阶段
    for (const [index, delayMs] of [0, 1, 2, 5, 10, 20, 40, 80].entries()) {
      const seq = 2 + index
      const id = await pipelineOn(page, { host: 'worker' })
      const { result, settledAfterDisposeMs, contentSha256 } = await probePipeline(page, 'writeThenDispose', id, captureOf(key, writer, seq, { randomBase64Chars: 3 * 1024 * 1024 }), delayMs)
      const outcome = terminationOf(result)
      expect(settledAfterDisposeMs, `终止之后在途的写入立即结束（${delayMs} ms）`).toBeLessThan(5_000)
      expect(['written', 'terminated'], `${delayMs} ms：${JSON.stringify(result)}`).toContain(outcome)
      const stored = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      const current = { seq: stored.meta.draftSeq, textSha256: stored.gzip.textSha256 }
      expect([expected, { seq, textSha256: contentSha256 }], `库里留下的要么是旧的一份、要么是这一次的完整一份（${delayMs} ms）`).toContainEqual(current)
      expect(outcome === 'written' ? current.seq : seq, `报告写成的就在库里（${delayMs} ms）`).toBe(seq)
      outcomes.push(`${delayMs}ms:${outcome}/库里${current.seq === seq ? '新' : '旧'}`)
      expected = current
    }
    test.info().annotations.push({ type: 'termination-outcomes', description: outcomes.join(', ') })
    // 用例的前提：至少有一次终止落在写入途中（都在终止之前写完的话，这条用例什么也没测到）
    expect(outcomes.some(outcome => outcome.includes('terminated')), outcomes.join(', ')).toBe(true)
  })
})

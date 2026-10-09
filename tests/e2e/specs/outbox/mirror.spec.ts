// OPFS 的镜像（M4-P1 设计 §3.8，S9）：在真实的浏览器里经测试构建的探针跑生产的发件箱 Worker——IndexedDB 写成之后同一份记录写进
// nerve-office-outbox/<userId>/<documentId>/ 的两个槽位文件（同步访问句柄、轮流原地改写），删掉草稿时截断，IndexedDB 被删之后读回并写回、
// 留下事件。槽位文件经测试构建的另一个 Worker 读出（页面里按生产的格式校验）、改坏。
// 每个用例一个持久化的浏览器目录（三个浏览器同样）：WebKit 默认的上下文是临时的数据存储，没有 OPFS（拿不到根目录，默认上下文里的管道用例
// 核对的正是"用不了"）；Chromium 默认的无痕式上下文里 OPFS 在内存里，配额的覆盖也管不到同步访问句柄。
// Playwright 的 WebKit 在 macOS 上把持久上下文的 OPFS 放在共用的目录里（不在资料目录里）：每个用例用自己的用户，收尾时删掉他的镜像目录。
// 标签 @test-build
import type { BrowserContext, Page } from '@playwright/test'
import type { DraftKey, InFlightSave, ProbeCapture, ProbeSlot, WriterIdentity } from '../../support/outbox-probe.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { test as base, expect } from '../../support/fixtures.ts'
import { NOW, openOutboxProbe, outcomeOf, probe, probeDatabase, probePipeline, removeMirrorOf, writerOf } from '../../support/outbox-probe.ts'
import { firstPage, launchPersistentProfile, overrideQuota } from '../../support/persistent-profile.ts'
import { loginThroughApi } from '../../support/session.ts'

const FORMAT = { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 }

function captureOf(key: DraftKey, writer: WriterIdentity, draftSeq: number, content: ProbeCapture['content'], overrides: Partial<ProbeCapture> = {}): ProbeCapture {
  return { key, writer, draftSeq, baseRevision: 1, writtenBy: `instance-${writer.writerId}`, format: FORMAT, formulasPending: false, inFlight: null, dedupe: false, content, ...overrides }
}

function inFlightOf(localSeq: number): InFlightSave {
  return { requestId: randomUUID(), clientInstanceId: 'instance-in-flight', localSeq, sentAt: NOW }
}

/** 槽位读出来的样子：空的、不合格、合格的那一份的序号与代号 */
function summaryOf(slot: ProbeSlot): string {
  switch (slot.kind) {
    case 'missing':
    case 'empty':
      return slot.kind
    case 'invalid':
      return `invalid:${slot.reason}`
    case 'valid':
      return `seq${slot.meta.draftSeq}@${slot.generation}`
  }
}

/** 这一个用例的用户：收尾时删掉他的 OPFS 镜像目录 */
let currentUserId: string | undefined

interface Profile {
  readonly context: BrowserContext
  readonly page: Page
}

/**
 * profile：这个用例的持久上下文（沿用项目的浏览器与 channel，挂上 CSP 违规与页面错误的收集）与它的第一页。收尾时关掉别的标签页、
 * 在第一页里关掉全部管道并删掉用例用户的镜像目录（Worker 终止之后句柄是异步放开的：删到成功为止），再关上下文
 */
const test = base.extend<{ profile: Profile }>({
  profile: async ({ playwright, browserName, cspViolations, pageErrors }, provide, testInfo) => {
    const context = await launchPersistentProfile(playwright[browserName], testInfo, 'profile', { cspViolations, pageErrors })
    const page = await firstPage(context)
    await provide({ context, page })
    for (const other of context.pages().filter(other => other !== page))
      await other.close()
    const owner = currentUserId
    currentUserId = undefined
    if (owner !== undefined)
      await expect.poll(async () => removeMirrorOf(page, owner), { message: '删掉用例用户的镜像目录', timeout: 10_000 }).toBe('removed')
    await context.close()
  },
})

/** 登录、打开探针、选一把第 2 版的密钥（rawHex 给出时用它：几个标签页用同一把）；交回这份文档的键 */
async function prepare(page: Page, prefix: string): Promise<{ readonly key: DraftKey, readonly rawKey: string }> {
  const user = await createUser(prefix)
  currentUserId = user.id
  await loginThroughApi(page, user)
  await openOutboxProbe(page)
  const rawKey = randomBytes(32).toString('hex')
  await probe(page, 'chooseKey', 2, rawKey)
  return { key: { userId: user.id, documentId: randomUUID() }, rawKey }
}

/** 发件箱 Worker 的管道（生产的脚本，带镜像）：握手成功、交给它探针当前的密钥 */
async function workerPipeline(page: Page): Promise<number> {
  const { id, ready } = await probePipeline(page, 'create', { host: 'worker' })
  expect(ready).toEqual({ kind: 'ready' })
  expect(await probePipeline(page, 'setKey', id, 'probe')).toEqual({ kind: 'key-set', notResealed: [] })
  return id
}

async function slotsOf(page: Page, key: DraftKey): Promise<string[]> {
  return (await probePipeline(page, 'mirrorSlots', key)).map(summaryOf)
}

test.describe('OPFS 的镜像', { tag: '@test-build' }, () => {
  test('写读：登记时建好两个空槽位；写成之后镜像里是库里那一份，两个槽位轮流写、代号往上；标记在途跟着重封；确认删掉之后两个都截断为 0', async ({ profile: { page } }) => {
    const { key } = await prepare(page, 'ob-mirror-rw')
    const id = await workerPipeline(page)
    const writer = writerOf(3)
    expect(await probePipeline(page, 'register', id, key, writer, false)).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined, mirror: { kind: 'mirrored' } })
    // 看槽位之前先放开句柄（同一时刻一个文件只有一个句柄）；之后的操作再拿
    await probePipeline(page, 'release', id, key)
    expect(await slotsOf(page, key)).toEqual(['empty', 'empty'])

    expect((await probePipeline(page, 'write', id, captureOf(key, writer, 1, 'one'))).kind).toBe('written')
    const second = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 2, 'two')), 'written')
    expect(second.mirror).toEqual({ kind: 'mirrored' })
    await probePipeline(page, 'release', id, key)
    expect(await slotsOf(page, key)).toEqual(['seq1@1', 'seq2@2'])
    const [, newest] = await probePipeline(page, 'mirrorSlots', key)
    const stored = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
    expect(newest.kind === 'valid' && newest.meta, '镜像里就是库里那一份（元数据相同）').toEqual(stored.meta)

    expect(await probePipeline(page, 'markInFlight', id, key, writer, inFlightOf(2))).toEqual({ kind: 'resealed' })
    await probePipeline(page, 'release', id, key)
    const resealed = await probePipeline(page, 'mirrorSlots', key)
    expect(resealed.map(summaryOf)).toEqual(['seq2@3', 'seq2@2'])
    expect(resealed[0].kind === 'valid' && resealed[0].meta.inFlight?.localSeq).toBe(2)

    expect(await probePipeline(page, 'confirm', id, key, writer, 2, 2)).toEqual({ kind: 'deleted' })
    await probePipeline(page, 'release', id, key)
    expect(await slotsOf(page, key)).toEqual(['empty', 'empty'])
  })

  test('两个标签页争同一个文件的句柄：新的写入者拿不到时照样写 IndexedDB、结果带 busy；旧的被栅栏拒绝后放开，新的退避之后拿到', async ({ profile: { context, page } }) => {
    const { key, rawKey } = await prepare(page, 'ob-mirror-handles')
    const older = writerOf(3)
    const first = await workerPipeline(page)
    expect((await probePipeline(page, 'register', first, key, older, false)).kind).toBe('registered')
    expect(outcomeOf(await probePipeline(page, 'write', first, captureOf(key, older, 1, 'older 1')), 'written').mirror).toEqual({ kind: 'mirrored' })

    const second = await context.newPage()
    await openOutboxProbe(second)
    await probe(second, 'chooseKey', 2, rawKey)
    const newer = writerOf(4)
    const takeover = await workerPipeline(second)
    expect(await probePipeline(second, 'register', takeover, key, newer, false)).toMatchObject({ kind: 'registered', lastDraftSeq: 1, mirror: { kind: 'not-mirrored', reason: 'busy' } })
    const blocked = outcomeOf(await probePipeline(second, 'write', takeover, captureOf(key, newer, 2, 'newer 2', { adoptSeq: 1 })), 'written')
    expect(blocked.mirror, '句柄被第一页拿着：照样写进 IndexedDB').toEqual({ kind: 'not-mirrored', reason: 'busy' })
    expect(outcomeOf(await probePipeline(second, 'storedGzip', key), 'gzip').gzip.text).toBe('newer 2')

    // 第一页再写：被栅栏拒绝（不再是写入者），随即放开句柄
    expect(await probePipeline(page, 'write', first, captureOf(key, older, 3, 'older 3'))).toMatchObject({ kind: 'fenced', reason: 'not-writer' })
    // 新的写入者按退避再拿：接着写，直到镜像写成（每次一份新的）
    let seq = 2
    await expect.poll(async () => {
      seq += 1
      const result = await probePipeline(second, 'write', takeover, captureOf(key, newer, seq, `newer ${seq}`))
      return result.kind === 'written' ? result.mirror.kind : result.kind
    }, { message: '新的写入者退避之后拿到句柄、镜像写成', timeout: 15_000, intervals: [250] }).toBe('mirrored')
    await probePipeline(second, 'release', takeover, key)
    const slots = await probePipeline(second, 'mirrorSlots', key)
    expect(slots.some(slot => slot.kind === 'valid' && slot.meta.writeEpoch === 4), '镜像里有新的写入者写的').toBe(true)
  })

  test('IndexedDB 被删之后（Chromium 崩溃重开时会删整个来源的库）：读回镜像里的那一份并写回库（连同写入者），留下"已从备份恢复"；之后登记新的一代时它是现有的草稿', async ({ profile: { page } }) => {
    const { key } = await prepare(page, 'ob-mirror-restore')
    const writer = writerOf(3)
    const before = await workerPipeline(page)
    await probePipeline(page, 'register', before, key, writer, false)
    outcomeOf(await probePipeline(page, 'write', before, captureOf(key, writer, 1, 'one')), 'written')
    const written = outcomeOf(await probePipeline(page, 'write', before, captureOf(key, writer, 2, 'two')), 'written')
    await probePipeline(page, 'dispose', before)

    expect(await probeDatabase(page, 'remove', 5_000)).toBe('deleted')
    expect(await probeDatabase(page, 'exists')).toBe(false)

    const after = await workerPipeline(page)
    const read = outcomeOf(await probePipeline(page, 'read', after, key), 'draft')
    expect([read.meta.draftSeq, read.gzip.text, read.gzip.sha256]).toEqual([2, 'two', written.gzip.sha256])
    expect(await probePipeline(page, 'takeEvents', after)).toEqual([{ kind: 'restored', key }])
    // 写回了库：草稿与写入者（代次、writerId、高水位）
    expect(outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip').meta.draftSeq).toBe(2)
    expect(await probeDatabase(page, 'getRaw', 'writers', key)).toMatchObject({ writeEpoch: 3, writerId: writer.writerId, lastDraftSeq: 2 })
    expect(await probePipeline(page, 'register', after, key, writerOf(4), false)).toMatchObject({ kind: 'registered', lastDraftSeq: 2, existing: { kind: 'draft', meta: { draftSeq: 2, writerId: writer.writerId } } })
  })

  test('IndexedDB 被删、两个槽位都坏了：读不回，留下"本机草稿因浏览器存储损坏丢失"', async ({ profile: { page } }) => {
    const { key } = await prepare(page, 'ob-mirror-lost')
    const writer = writerOf(3)
    const before = await workerPipeline(page)
    await probePipeline(page, 'register', before, key, writer, false)
    outcomeOf(await probePipeline(page, 'write', before, captureOf(key, writer, 1, 'one')), 'written')
    outcomeOf(await probePipeline(page, 'write', before, captureOf(key, writer, 2, 'two')), 'written')
    await probePipeline(page, 'dispose', before)
    await probePipeline(page, 'corruptSlot', key, 0, { truncate: 300 })
    await probePipeline(page, 'corruptSlot', key, 1, { fill: 400, value: 7 })
    expect(await slotsOf(page, key)).toEqual(['invalid:torn', 'invalid:torn'])
    expect(await probeDatabase(page, 'remove', 5_000)).toBe('deleted')

    const after = await workerPipeline(page)
    expect(await probePipeline(page, 'read', after, key)).toEqual({ kind: 'absent' })
    expect(await probePipeline(page, 'takeEvents', after)).toEqual([{ kind: 'lost', key }])
  })

  test('放弃过、确认删掉过的不复活：库里的草稿删掉了而镜像里留着那一份（当时没截断成）——比对时按写入者的高水位认出，截断镜像，读不回、没有事件', async ({ profile: { page } }) => {
    const { key } = await prepare(page, 'ob-mirror-stale')
    const writer = writerOf(3)
    const before = await workerPipeline(page)
    await probePipeline(page, 'register', before, key, writer, false)
    outcomeOf(await probePipeline(page, 'write', before, captureOf(key, writer, 1, 'one')), 'written')
    await probePipeline(page, 'dispose', before)
    // 绕过管道直接从库里删掉草稿（写入者与它的高水位留着）：镜像没跟着截断
    expect(await probe(page, 'remove', key)).toEqual({ kind: 'removed' })
    expect(await slotsOf(page, key)).toEqual(['seq1@1', 'empty'])

    const after = await workerPipeline(page)
    expect(await probePipeline(page, 'read', after, key)).toEqual({ kind: 'absent' })
    expect(await probePipeline(page, 'takeEvents', after)).toEqual([])
    expect(await probePipeline(page, 'storedGzip', key)).toEqual({ kind: 'absent' })
    await probePipeline(page, 'release', after, key)
    expect(await slotsOf(page, key)).toEqual(['empty', 'empty'])
  })

  test('打开平台时的比对：IndexedDB 被删之后，这个用户在镜像里的每份文档都写回库、各留一个"已从备份恢复"', async ({ profile: { page } }) => {
    const { key } = await prepare(page, 'ob-mirror-reconcile')
    const other = { userId: key.userId, documentId: randomUUID() }
    const writer = writerOf(3)
    const before = await workerPipeline(page)
    for (const target of [key, other]) {
      await probePipeline(page, 'register', before, target, writer, false)
      outcomeOf(await probePipeline(page, 'write', before, captureOf(target, writer, 1, `content of ${target.documentId}`)), 'written')
    }
    await probePipeline(page, 'dispose', before)
    expect(await probeDatabase(page, 'remove', 5_000)).toBe('deleted')

    const after = await workerPipeline(page)
    expect(await probePipeline(page, 'reconcile', after, key.userId)).toEqual({ kind: 'reconciled', documents: 2 })
    expect((await probePipeline(page, 'takeEvents', after)).map(event => [event.kind, event.key.documentId]).sort()).toEqual([['restored', key.documentId], ['restored', other.documentId]].sort())
    expect(await probe(page, 'draftIds', key.userId)).toEqual([key.documentId, other.documentId].sort())
  })

  test('写满（Chromium 内核经 CDP 把配额设小）：IndexedDB 写成、镜像写满，结果带 quota；库里那一份完好、镜像里没有合格的半截', async ({ browserName, profile: { context, page } }, testInfo) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 没有覆盖配额的接口（CDP 的 Storage.overrideQuotaForOrigin 只在 Chromium 内核里有），写满在 Playwright 的 WebKit 上造不出来
    test.skip(browserName === 'webkit', 'WebKit 没有覆盖配额的接口（CDP 只在 Chromium 内核里有）')
    // 配额要在本站第一次写 IndexedDB 与 OPFS 之前设（持久化的浏览器目录：默认的无痕式上下文里覆盖管不到同步访问句柄，实测写 32 MiB 照样写成）
    const release = await overrideQuota(context, page, new URL(testInfo.project.use.baseURL ?? '').origin, 8 * 1024 * 1024)
    try {
      const { key } = await prepare(page, 'ob-mirror-quota')
      const writer = writerOf(3)
      const id = await workerPipeline(page)
      expect(await probePipeline(page, 'register', id, key, writer, false)).toMatchObject({ kind: 'registered', mirror: { kind: 'mirrored' } })
      // 先在另一份文档的槽位里放 4 MiB 压舱的字节，再写一份 gzip 约 2.6 MiB 的记录（3.5 MiB 随机内容）：IndexedDB 写得下（4 + 2.6 < 8），
      // 镜像再写同样大小就超过 8 MiB（4 + 2.6 + 2.6 > 8），两边各留 1 MiB 以上的余量。实测 Chromium 给同步访问句柄批空间是整块地批、
      // 按来源的总用量（IndexedDB 也算在内）核对：压舱放 5、6 MiB 时它自己就写满，所以压舱正好 4 MiB
      const ballast = { userId: key.userId, documentId: randomUUID() }
      expect((await probePipeline(page, 'register', id, ballast, writer, false)).kind).toBe('registered')
      await probePipeline(page, 'release', id, ballast)
      await probePipeline(page, 'corruptSlot', ballast, 0, { fill: 4 * 1024 * 1024, value: 1 })
      const written = outcomeOf(await probePipeline(page, 'write', id, captureOf(key, writer, 1, { randomBase64Chars: 3.5 * 1024 * 1024 })), 'written')
      expect(written.mirror).toEqual({ kind: 'not-mirrored', reason: 'quota' })
      const stored = outcomeOf(await probePipeline(page, 'storedGzip', key), 'gzip')
      expect(stored.gzip.sha256, '库里那一份完好').toBe(written.gzip.sha256)
      await probePipeline(page, 'release', id, key)
      const slots = await slotsOf(page, key)
      expect(slots.every(slot => slot === 'empty' || slot.startsWith('invalid:')), `镜像里没有合格的一份：${slots.join(', ')}`).toBe(true)
    }
    finally {
      await release()
    }
  })
})

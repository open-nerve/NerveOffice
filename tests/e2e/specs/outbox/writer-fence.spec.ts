// 写入栅栏（M4-P1 设计 §3.4.2–§3.4.5，M4 总设计 §6.3）：同一个浏览器的两个标签页（同源，共用一个 IndexedDB）在真实的事务里登记、写入、
// 重封与确认。确定的交错按先后一步一步走（每一步等上一步的结果）；同时发起的竞争核对结果与某一种先后一致——判定与写入在同一个事务里，
// 别的标签页插不进来。经测试构建里的探针调用生产的存储，标签 @test-build
import type { Page } from '@playwright/test'
import type { DraftKey, ProbeDraftInput, ProbeRead, ProbeRegisterOutcome, ProbeWriteOutcome, WriterIdentity } from '../../support/outbox-probe.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, draftFor, NOW, openOutboxProbe, outcomeOf, probe, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 同一个浏览器里的两个标签页，用同一把密钥（同一个人在这台设备上的本机密钥） */
async function twoTabs(page: Page, prefix: string): Promise<{ readonly first: Page, readonly second: Page, readonly key: DraftKey }> {
  const user = await createUser(prefix)
  await loginThroughApi(page, user)
  const second = await page.context().newPage()
  const rawKey = randomBytes(32).toString('hex')
  for (const tab of [page, second]) {
    await openOutboxProbe(tab)
    await probe(tab, 'chooseKey', 1, rawKey)
  }
  return { first: page, second, key: { userId: user.id, documentId: randomUUID() } }
}

async function register(tab: Page, key: DraftKey, writer: WriterIdentity, force = false) {
  return probe(tab, 'register', key, writer, { now: NOW, force })
}

/** 读出的那一份是谁写的第几份、解开得到什么 */
function identityOf(read: ProbeRead | { readonly kind: string }): unknown {
  const draft = outcomeOf(read as ProbeRead, 'draft')
  return [draft.meta.writerId, draft.meta.draftSeq, draft.opened]
}

/**
 * 竞争的一轮：first 写第 seq 份的同时 second 登记了下一代。两种先后都可能，结果要与其中一种一致——写入先提交：登记看到的就是它、
 * 高水位接着它；登记先提交：写入因写入者不是它被拦下，登记看到的不是它。交回是哪一种
 */
function orderOf(round: number, seq: number, written: ProbeWriteOutcome, registered: ProbeRegisterOutcome): 'write-first' | 'register-first' {
  const { existing, lastDraftSeq } = outcomeOf(registered, 'registered')
  const seenSeq = existing?.kind === 'draft' ? existing.meta.draftSeq : undefined
  if (written.kind === 'written') {
    expect([seenSeq, lastDraftSeq], `第 ${round} 轮：写成了却不在登记看到的草稿里`).toEqual([seq, seq])
    return 'write-first'
  }
  expect(written, `第 ${round} 轮`).toEqual({ kind: 'fenced', reason: 'not-writer' })
  expect(seenSeq, `第 ${round} 轮：被拦下的写入却在登记看到的草稿里`).not.toBe(seq)
  return 'register-first'
}

/**
 * 竞争那一轮写的内容：偶数轮约 1.5 MiB 的随机内容（压缩、加密要十几毫秒，登记多半先提交），奇数轮小的（写入多半先提交），
 * 两种先后都走得到
 */
function raceContent(round: number, writer: WriterIdentity, seq: number): ProbeDraftInput['content'] {
  return round % 2 === 0 ? { randomBase64Chars: 1_500_000 } : contentOf(writer, seq)
}

/** 接手库里现在的那一份（有的话）：写入的选项 */
function adoptionOf(latest: ProbeRead | { readonly kind: string }): { readonly adoptSeq: number } | undefined {
  return latest.kind === 'draft' ? { adoptSeq: (latest as Extract<ProbeRead, { kind: 'draft' }>).meta.draftSeq } : undefined
}

test.describe('写入栅栏：两个标签页', { tag: '@test-build' }, () => {
  test('后登记的更大一代取代先登记的：先登记的那一页之后的写入、重封、确认、再登记都被拦下；新的一代不经接手不覆盖旧的草稿，带上接手的序号才写', async ({ page }) => {
    const { first, second, key } = await twoTabs(page, 'ob-fence')
    const older = writerOf(3)
    const newer = writerOf(4)

    expect(await register(first, key, older)).toEqual({ kind: 'registered', lastDraftSeq: 0, existing: undefined })
    expect(await probe(first, 'write', draftFor(key, older, 1))).toEqual({ kind: 'written' })

    // 新的一代登记：高水位接着旧的草稿，交回旧的草稿（解得开）
    const registered = outcomeOf(await register(second, key, newer), 'registered')
    expect(registered.lastDraftSeq).toBe(1)
    expect(identityOf(registered.existing ?? { kind: 'absent' })).toEqual([older.writerId, 1, { kind: 'opened', content: contentOf(older, 1) }])

    // 旧的一代：写入、重封、确认都被拦下（写入者不是它），再登记得到 superseded
    expect(await probe(first, 'write', draftFor(key, older, 2))).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect(await probe(first, 'replace', draftFor(key, older, 1, { inFlight: { requestId: randomUUID(), clientInstanceId: 'c', localSeq: 1, sentAt: NOW } }))).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect(await probe(first, 'confirm', key, older, 1)).toEqual({ kind: 'fenced', reason: 'not-writer' })
    expect(await register(first, key, older)).toEqual({ kind: 'superseded', currentEpoch: 4, sameEpoch: false })

    // 新的一代：不带接手的序号不覆盖旧的草稿；带错了也不行；带上看过的那一份的序号才写
    expect(await probe(second, 'write', draftFor(key, newer, 2))).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    expect(await probe(second, 'write', draftFor(key, newer, 3), { adoptSeq: 2 })).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    // 确认不删别的写入者留下的草稿（本页的上传不包含它的内容）
    expect(await probe(second, 'confirm', key, newer, 5)).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    expect(await probe(second, 'write', draftFor(key, newer, 4), { adoptSeq: 1 })).toEqual({ kind: 'written' })
    expect(identityOf(await probe(second, 'read', key))).toEqual([newer.writerId, 4, { kind: 'opened', content: contentOf(newer, 4) }])
    // 序号不回头：拦下的、空号都留着，之后只能更大
    expect(await probe(second, 'write', draftFor(key, newer, 3))).toEqual({ kind: 'fenced', reason: 'stale-seq' })
    expect(await probe(second, 'write', draftFor(key, newer, 5))).toEqual({ kind: 'written' })
  })

  test('同一代的另一次登记（页面重建了 Worker）得到 superseded（sameEpoch）；经服务端核对之后 force 取代它；代次更大的写入者同样可以被 force 取代（服务端从备份恢复、代次倒退）', async ({ page }) => {
    const { first, second, key } = await twoTabs(page, 'ob-force')
    const before = writerOf(5)
    await register(first, key, before)
    expect(await probe(first, 'write', draftFor(key, before, 1))).toEqual({ kind: 'written' })

    const rebuilt = { writeEpoch: 5, writerId: randomUUID() }
    expect(await register(second, key, rebuilt)).toEqual({ kind: 'superseded', currentEpoch: 5, sameEpoch: true })
    expect(outcomeOf(await register(second, key, rebuilt, true), 'registered').lastDraftSeq).toBe(1)
    expect(await probe(first, 'write', draftFor(key, before, 2))).toEqual({ kind: 'fenced', reason: 'not-writer' })

    const restored = writerOf(2)
    expect(await register(first, key, restored)).toEqual({ kind: 'superseded', currentEpoch: 5, sameEpoch: false })
    expect(outcomeOf(await register(first, key, restored, true), 'registered').lastDraftSeq).toBe(1)
    expect(await probe(second, 'write', draftFor(key, rebuilt, 2), { adoptSeq: 1 })).toEqual({ kind: 'fenced', reason: 'not-writer' })
  })

  test('只删到已确认的序号：上传在途时又写了新的一份，确认之后改基准、不删（没给重封的那一份时交回 needs-rebase）；再确认新的那一份才删；高水位留着', async ({ page }) => {
    const { first, key } = await twoTabs(page, 'ob-confirm')
    const writer = writerOf(3)
    await register(first, key, writer)
    expect(await probe(first, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    // 上传第 1 份之前先记下在途（重封：同一份、换元数据）
    const inFlight = { requestId: randomUUID(), clientInstanceId: `instance-${writer.writerId}`, localSeq: 1, sentAt: NOW }
    expect(await probe(first, 'replace', draftFor(key, writer, 1, { inFlight }))).toEqual({ kind: 'written' })
    // 期间又写了第 2 份（保存中继续输入，A08）：带着在途的记号
    expect(await probe(first, 'write', draftFor(key, writer, 2, { inFlight }))).toEqual({ kind: 'written' })
    // 重封的 expectedSeq 对不上（第 1 份已经被第 2 份覆盖）：changed
    expect(await probe(first, 'replace', draftFor(key, writer, 1))).toEqual({ kind: 'fenced', reason: 'changed' })

    // 第 1 份确认了：草稿是第 2 份，不删；没给重封的那一份时不动、交回 needs-rebase；给了序号不对的也一样
    expect(await probe(first, 'confirm', key, writer, 1)).toEqual({ kind: 'needs-rebase' })
    expect(await probe(first, 'confirm', key, writer, 1, draftFor(key, writer, 1, { baseRevision: 2 }))).toEqual({ kind: 'needs-rebase' })
    expect(await probe(first, 'confirm', key, writer, 1, draftFor(key, writer, 2, { baseRevision: 2 }))).toEqual({ kind: 'rebased' })
    const rebased = outcomeOf(await probe(first, 'read', key), 'draft')
    expect([rebased.meta.draftSeq, rebased.meta.baseRevision, rebased.meta.inFlight, rebased.opened]).toEqual([2, 2, null, { kind: 'opened', content: contentOf(writer, 2) }])

    // 第 2 份确认了：删掉；再确认一次是 absent
    expect(await probe(first, 'confirm', key, writer, 2)).toEqual({ kind: 'deleted' })
    expect(await probe(first, 'read', key)).toEqual({ kind: 'absent' })
    expect(await probe(first, 'confirm', key, writer, 2)).toEqual({ kind: 'absent' })
    // 高水位留着：序号不回头
    expect(await probe(first, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'fenced', reason: 'stale-seq' })
    expect(await register(first, key, writer)).toEqual({ kind: 'registered', lastDraftSeq: 2, existing: undefined })
  })

  test('同一写入者、同一序号的重试（提交了而回应丢了）按已写入，不覆盖；放弃带 expectedSeq 时只删那一份', async ({ page }) => {
    const { first, second, key } = await twoTabs(page, 'ob-retry')
    const writer = writerOf(3)
    await register(first, key, writer)
    expect(await probe(first, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    // 同一序号再写一次（内容不同也一样：序号相同就是同一份的重试），库里还是原来那一份
    expect(await probe(first, 'write', draftFor(key, writer, 1, {}, 'retried'))).toEqual({ kind: 'written' })
    expect(outcomeOf(await probe(second, 'read', key), 'draft').opened).toEqual({ kind: 'opened', content: contentOf(writer, 1) })

    // 用户在另一个标签页放弃：带的序号已经不是库里那一份（又写了第 2 份）就不删
    expect(await probe(first, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'written' })
    expect(await probe(second, 'remove', key, 1)).toEqual({ kind: 'changed' })
    expect(await probe(second, 'remove', key, 2)).toEqual({ kind: 'removed' })
    expect(await probe(second, 'remove', key)).toEqual({ kind: 'absent' })
  })

  test('竞争：一个标签页写入的同时另一个登记更大的一代——结果与某一种先后一致：写成了的一定在登记看到的草稿里，被拦下的一定不在', async ({ page }) => {
    const { first, second, key } = await twoTabs(page, 'ob-race')
    let epoch = 1
    let seq = 0
    let writer = writerOf(epoch)
    expect((await register(first, key, writer)).kind).toBe('registered')
    const outcomes: string[] = []
    for (let round = 0; round < 12; round += 1) {
      seq += 1
      // 同时发起：first 写第 seq 份（先压缩、加密，再开事务），second 登记下一代
      const operation = await probe(first, 'startWrite', draftFor(key, writer, seq, {}, raceContent(round, writer, seq)))
      const next = writerOf(epoch + 1)
      const registered = await register(second, key, next)
      const written = await probe(first, 'settled', operation)
      outcomes.push(orderOf(round, seq, written, registered))
      // 下一轮由更新的一代在 first 里写：登记，接手库里现在的那一份（有的话），写下一份
      epoch += 2
      writer = writerOf(epoch)
      expect((await register(first, key, writer)).kind).toBe('registered')
      seq = Math.max(seq, outcomeOf(registered, 'registered').lastDraftSeq) + 1
      expect(await probe(first, 'write', draftFor(key, writer, seq), adoptionOf(await probe(first, 'read', key)))).toEqual({ kind: 'written' })
    }
    // 记下两种先后各出现了几次（不断言：先后由两个进程的时机决定）
    test.info().annotations.push({ type: 'race', description: outcomes.join(',') })
  })
})

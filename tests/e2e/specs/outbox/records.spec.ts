// 发件箱的记录（M4-P1 设计 §3.3、§3.4.6、§3.5）：在真实的浏览器里核对——直接改库里的明文字段之后解不开（AAD 覆盖全部明文元数据）、
// 认不出的记录不动它、断网时写读照常（全程在内存的字节上，不经 Blob：WebKit 离线时读不了 Blob）、写满时整个事务回滚。
// 经测试构建里的探针调用生产的存储与编解码，标签 @test-build
import type { Page } from '@playwright/test'
import type { DraftKey, WriterIdentity } from '../../support/outbox-probe.ts'
import { randomUUID } from 'node:crypto'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { contentOf, draftFor, NOW, openOutboxProbe, outcomeOf, probe, probeDatabase, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 登录、打开探针、换上第 keyVersion 版的密钥，登记一个写入者 */
async function prepare(page: Page, prefix: string, keyVersion = 1): Promise<{ readonly key: DraftKey, readonly writer: WriterIdentity, readonly userId: string }> {
  const user = await createUser(prefix)
  await loginThroughApi(page, user)
  await openOutboxProbe(page)
  await probe(page, 'chooseKey', keyVersion)
  const key = { userId: user.id, documentId: randomUUID() }
  const writer = writerOf(3)
  await probe(page, 'register', key, writer, { now: NOW, force: false })
  return { key, writer, userId: user.id }
}

/** 翻转十六进制里第一个字节的最低位 */
function flippedHex(hex: string): string {
  return (Number.parseInt(hex.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0') + hex.slice(2)
}

test.describe('发件箱的记录', { tag: '@test-build' }, () => {
  test('直接改库里的任何一个明文字段之后解不开：密钥版本改小算"已吊销"、改大算"本页的密钥过时"（审查 A3），其余算"已损坏"；IV、密文改一个字节同样；格式版本改大算更新的格式、不动它；形状不对算损坏', async ({ page }) => {
    const { key, writer } = await prepare(page, 'ob-tamper', 3)
    const inFlight = { requestId: randomUUID(), clientInstanceId: `instance-${writer.writerId}`, localSeq: 0, sentAt: NOW - 1_000 }
    const cases: readonly { readonly label: string, readonly patch: (raw: Record<string, unknown>) => Record<string, unknown>, readonly expected: unknown }[] = [
      { label: 'baseRevision', patch: () => ({ baseRevision: 99 }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'writeEpoch', patch: () => ({ writeEpoch: 4 }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'writerId', patch: () => ({ writerId: randomUUID() }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'writtenBy', patch: () => ({ writtenBy: 'someone-else' }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'formulasPending', patch: () => ({ formulasPending: true }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'rawBytes', patch: raw => ({ rawBytes: Number(raw.rawBytes) + 1 }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'updatedAt', patch: raw => ({ updatedAt: Number(raw.updatedAt) - 1 }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'format.clientBuild', patch: raw => ({ format: { ...raw.format as object, clientBuild: '9.9.9' } }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'inFlight.localSeq', patch: raw => ({ inFlight: { ...raw.inFlight as object, localSeq: Number((raw.inFlight as { localSeq: number }).localSeq) - 1 } }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'inFlight（去掉）', patch: () => ({ inFlight: null }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'keyVersion（改小）', patch: () => ({ keyVersion: 2 }), expected: { kind: 'unreadable', reason: 'revoked' } },
      { label: 'keyVersion（改大）', patch: () => ({ keyVersion: 4 }), expected: { kind: 'unreadable', reason: 'stale-key' } },
      { label: 'iv', patch: raw => ({ iv: flippedHex((raw.iv as { hex: string }).hex) }), expected: { kind: 'unreadable', reason: 'corrupted' } },
      { label: 'ciphertext', patch: raw => ({ ciphertext: flippedHex((raw.ciphertext as { hex: string }).hex) }), expected: { kind: 'unreadable', reason: 'corrupted' } },
    ]
    let seq = 0
    for (const { label, patch, expected } of cases) {
      // 每一项都从一份新写的草稿开始（在途的就是这一份）
      seq += 1
      expect(await probe(page, 'write', draftFor(key, writer, seq, { inFlight: { ...inFlight, localSeq: seq } })), label).toEqual({ kind: 'written' })
      expect(outcomeOf(await probe(page, 'read', key), 'draft').opened, `${label}：改之前解得开`).toEqual({ kind: 'opened', content: contentOf(writer, seq) })
      const raw = await probeDatabase(page, 'getRaw', 'drafts', key)
      expect(raw, `${label}：库里有这一条草稿`).not.toBeNull()
      await probeDatabase(page, 'patchDraft', key, patch(raw ?? {}))
      // 形状照样对，读得出元数据；解不开
      expect(outcomeOf(await probe(page, 'read', key), 'draft').opened, label).toEqual(expected)
      // 改过写入者那几项的草稿看起来是别的写入者留下的，下一份不会覆盖它：先放弃（用户的决定，不核对写入者）
      expect(await probe(page, 'remove', key), label).toEqual({ kind: 'removed' })
    }
    seq += 1
    expect(await probe(page, 'write', draftFor(key, writer, seq))).toEqual({ kind: 'written' })

    // 格式版本改大：更新的页面写的，交回它的版本，不往下看；本页的写入不覆盖它（要先显式删掉）
    await probeDatabase(page, 'patchDraft', key, { recordVersion: 2 })
    expect(await probe(page, 'read', key)).toEqual({ kind: 'newer-format', recordVersion: 2 })
    expect(await probe(page, 'write', draftFor(key, writer, seq + 1))).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    // 在途的序号比这一份还大（反过来的记录，恢复时会把旧内容当"自己追自己"）：读成形状不对
    await probeDatabase(page, 'patchDraft', key, { recordVersion: 1, inFlight: { requestId: 'r', clientInstanceId: 'c', localSeq: seq + 1, sentAt: NOW } })
    expect(await probe(page, 'read', key)).toEqual({ kind: 'malformed' })
    // 形状不对：损坏的记录，同样不覆盖；登记照常（交回它，由恢复决定）
    await probeDatabase(page, 'patchDraft', key, { inFlight: null, draftSeq: 'x' })
    expect(await probe(page, 'read', key)).toEqual({ kind: 'malformed' })
    expect(await probe(page, 'write', draftFor(key, writer, seq + 1))).toEqual({ kind: 'fenced', reason: 'foreign-draft' })
    expect(await probe(page, 'register', key, writer, { now: NOW, force: false })).toEqual({ kind: 'registered', lastDraftSeq: seq, existing: { kind: 'malformed' } })
    expect(await probe(page, 'remove', key)).toEqual({ kind: 'removed' })
    expect(await probe(page, 'write', draftFor(key, writer, seq + 1))).toEqual({ kind: 'written' })
  })

  test('形状不对的草稿不写（存进去的一律要读得回来）：交回 failed（TypeError），库里不变、高水位不变', async ({ page }) => {
    const { key, writer } = await prepare(page, 'ob-malformed-write')
    expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })
    expect(outcomeOf(await probe(page, 'writeMalformed', draftFor(key, writer, 2)), 'failed').error.name).toBe('TypeError')
    expect(outcomeOf(await probe(page, 'read', key), 'draft').opened).toEqual({ kind: 'opened', content: contentOf(writer, 1) })
    expect(await probe(page, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'written' })
  })

  test('断网时写读照常：压缩、加密、写入、读回、解开、解压都在内存的字节上做，不经网络', async ({ page }) => {
    const { key, writer, userId } = await prepare(page, 'ob-offline')
    await page.context().setOffline(true)
    try {
      const content = `${contentOf(writer, 1)}${'离线时的修改，'.repeat(20_000)}`
      expect(await probe(page, 'write', draftFor(key, writer, 1, {}, content))).toEqual({ kind: 'written' })
      const read = outcomeOf(await probe(page, 'read', key), 'draft')
      expect(read.opened).toEqual({ kind: 'opened', content })
      expect(read.meta.rawBytes).toBe(new TextEncoder().encode(content).byteLength)
      expect(await probe(page, 'draftIds', userId)).toEqual([key.documentId])
    }
    finally {
      await page.context().setOffline(false)
    }
  })

  test('写满（Chromium 内核经 CDP 把配额设小）：整个事务回滚——已有的记录不变、解得开，高水位不变；新文档的写入也不留下半截', async ({ page, browserName }) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 没有覆盖配额的接口（CDP 的 Storage.overrideQuotaForOrigin 只在 Chromium 内核里有），写满在 Playwright 的 WebKit 上造不出来；Safari 上由真实 Safari 的复核以事务 abort 的回滚补上（P1 设计 §3.6 第 5 项）
    test.skip(browserName === 'webkit', 'WebKit 没有覆盖配额的接口：Safari 上由真实 Safari 的复核以事务 abort 的回滚补上（P1 设计 §3.6 第 5 项）')
    const user = await createUser('ob-quota')
    await loginThroughApi(page, user)
    await openOutboxProbe(page)
    // 配额要在本站第一次写 IndexedDB 之前设（M0 审查 S3）：探针挂上时还没有打开库
    expect(await probeDatabase(page, 'exists')).toBe(false)
    const cdp = await page.context().newCDPSession(page)
    const origin = new URL(page.url()).origin
    await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 8 * 1024 * 1024 })
    await probe(page, 'chooseKey', 1)
    const key = { userId: user.id, documentId: randomUUID() }
    const writer = writerOf(3)
    // 写满之后 Chromium 的用量要过一会儿才降下来，这期间再小的写入（含登记）也可能写满：登记与小的写入都在第一次写满之前做完
    const other = { userId: user.id, documentId: randomUUID() }
    try {
      for (const target of [key, other])
        expect((await probe(page, 'register', target, writer, { now: NOW, force: false })).kind).toBe('registered')
      expect(await probe(page, 'write', draftFor(key, writer, 1))).toEqual({ kind: 'written' })

      // 新文档第一次写就写满（约 12 MiB 随机内容，几乎压不动）：不留下半截
      expect(await probe(page, 'write', draftFor(other, writer, 1, {}, { randomBase64Chars: 12 * 1024 * 1024 }))).toEqual({ kind: 'quota' })
      expect(await probe(page, 'read', other)).toEqual({ kind: 'absent' })
      expect((await probeDatabase(page, 'getRaw', 'writers', other))?.lastDraftSeq).toBe(0)

      // 覆盖已有的记录时写满：整个事务回滚——原记录不变、解得开，高水位还是 1
      expect(await probe(page, 'write', draftFor(key, writer, 2, {}, { randomBase64Chars: 12 * 1024 * 1024 }))).toEqual({ kind: 'quota' })
      const kept = outcomeOf(await probe(page, 'read', key), 'draft')
      expect([kept.meta.draftSeq, kept.opened]).toEqual([1, { kind: 'opened', content: contentOf(writer, 1) }])
      expect((await probeDatabase(page, 'getRaw', 'writers', key))?.lastDraftSeq).toBe(1)
      expect(await probe(page, 'draftIds', user.id)).toEqual([key.documentId])
    }
    finally {
      await cdp.send('Storage.overrideQuotaForOrigin', { origin })
    }
    // 配额放开之后：高水位没有被抬到 2，第 2 份照常写得进
    expect(await probe(page, 'write', draftFor(key, writer, 2))).toEqual({ kind: 'written' })
  })
})

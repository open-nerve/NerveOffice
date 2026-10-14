// 冻结页模型：实际宿主保留密钥/摘要，漏过广播；退出必须仍以持久资格挡住迟到捕获。
import type { ProbeCapture } from '../../support/outbox-probe.ts'
import { createUser, revisionOf } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { openLogoutPreview } from '../../support/logout.ts'
import { probePipeline, writerOf } from '../../support/outbox-probe.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, savedContent } from '../../support/sheet.ts'

test.describe('公开退出与另一页迟到捕获', { tag: '@test-build' }, () => {
  for (const host of ['in-process', 'worker'] as const) {
    test(`${host} 保留旧密钥和摘要也不能在退出后重建草稿、借 force 写入新文档`, async ({ page, context }) => {
      const owner = await createUser('logout-late')
      await loginThroughApi(page, owner)
      const documentId = await createSheetThroughApi(page)
      const key = { userId: owner.id, documentId }
      const snapshot = recoverySnapshot((await savedContent(page, documentId)).text, '退出前已捕获内容')
      const seeded = await seedRecovery(page, key, snapshot)
      const { id, ready } = await probePipeline(page, 'create', { host })
      expect(ready.kind).toBe('ready')
      await probePipeline(page, 'setKey', id, 'probe')
      const { writeEpoch, writerId, writtenBy, format } = seeded.input.meta
      const writer = { writeEpoch, writerId }
      expect((await probePipeline(page, 'register', id, key, writer, false)).kind).toBe('registered')
      const capture: ProbeCapture = { key, writer, draftSeq: 38, baseRevision: 1, writtenBy, format, formulasPending: false, inFlight: null, content: snapshot, dedupe: true }
      expect((await probePipeline(page, 'write', id, capture)).kind).toBe('written')
      // 只释放镜像句柄；宿主仍活着，保留本页密钥与摘要，模拟挂起后迟到的捕获。
      await probePipeline(page, 'release', id, key)
      const logout = await context.newPage()
      await openLogoutPreview(logout)
      await logout.getByRole('button', { name: '清理本机草稿并退出' }).click()
      await expect(logout.getByRole('form', { name: '登录' })).toBeVisible()
      expect(await readLocalDisk(page, key)).toEqual({ draft: null, writer: null })
      expect(await probePipeline(page, 'write', id, { ...capture, draftSeq: 39 })).toEqual({ kind: 'session-invalid', gzip: null })
      expect(await probePipeline(page, 'write', id, { ...capture, draftSeq: 40, content: recoverySnapshot(snapshot, '迟到的新正文') })).toEqual({ kind: 'session-invalid', gzip: null })
      const other = { ...key, documentId: crypto.randomUUID() }
      expect((await probePipeline(page, 'register', id, other, writerOf(99), true)).kind).toBe('session-invalid')
      expect(await readLocalDisk(page, key)).toEqual({ draft: null, writer: null })
      expect(await readLocalDisk(page, other)).toEqual({ draft: null, writer: null })
      expect(await revisionOf(documentId)).toBe(1)
      await probePipeline(page, 'dispose', id)
      await logout.close()
    })
  }
})

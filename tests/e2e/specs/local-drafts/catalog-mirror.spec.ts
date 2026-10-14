// WebKit 的 OPFS 需要持久上下文；在清理阶段注入目录删除失败，保留真实镜像。
import { createUser } from '../../support/database.ts'
import { draftRow, openDraftCatalog } from '../../support/draft-catalog.ts'
import { expect, test } from '../../support/fixtures.ts'
import { readLocalDisk } from '../../support/local-draft.ts'
import { mirrorRecovery, recoverySnapshot, seedRecovery } from '../../support/local-recovery.ts'
import { openOutboxProbe, probe, removeMirrorOf } from '../../support/outbox-probe.ts'
import { firstPage, launchPersistentProfile } from '../../support/persistent-profile.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, savedContent } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M4-07 先恢复仅存于镜像的原件；放弃遇到备份清理失败时不声称全部清完', { tag: '@test-build' }, async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
  const context = await launchPersistentProfile(playwright[browserName], testInfo, 'catalog-mirror', { cspViolations, pageErrors })
  const page = await firstPage(context)
  const owner = await createUser('catalog-mirror')
  try {
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page, '仅存于备份的本机修改')
    const key = { userId: owner.id, documentId }
    const cloud = await savedContent(page, documentId)
    const seeded = await seedRecovery(page, key, recoverySnapshot(cloud.text, '镜像中待恢复的内容'))
    await mirrorRecovery(page, key, seeded)
    expect(await probe(page, 'remove', key)).toMatchObject({ kind: 'removed' })
    expect((await readLocalDisk(page, key)).draft).toBeNull()
    // 模拟主库记录和其高水位一并丢失，保留真实镜像和会话许可。
    await page.evaluate(async (key) => {
      const open = indexedDB.open('nerve-office-outbox')
      await new Promise<void>((resolve, reject) => {
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('writers', 'readwrite')
          tx.objectStore('writers').delete([key.userId, key.documentId])
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onabort = () => {
            db.close()
            reject(tx.error)
          }
        }
      })
    }, key)
    await page.route('**/assets/outbox.worker-*.js', async (route) => {
      const response = await route.fetch()
      const failure = `FileSystemDirectoryHandle.prototype.removeEntry = async function() { throw new DOMException('测试清理阶段备份占用', 'NoModificationAllowedError'); };`
      await route.fulfill({ response, body: `${failure}\n${await response.text()}` })
    })
    await openDraftCatalog(page)
    const row = draftRow(page, documentId)
    await expect(row.getByRole('link', { name: '打开文档恢复' })).toHaveAttribute('aria-disabled', 'false')
    expect((await readLocalDisk(page, key)).draft?.ciphertextHex).toBe(seeded.disk.ciphertextHex)
    await row.getByRole('button', { name: '放弃本机修改' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: '确认放弃' }).click()
    await expect(row).toContainText('本机备份尚未清理完成')
    expect((await readLocalDisk(page, key)).draft).toBeNull()
    await page.getByRole('button', { name: '重新检查' }).click()
    await expect(row).toBeVisible()
    await expect(page.getByText('这台设备上没有待处理的本机草稿。')).toHaveCount(0)
  }
  finally {
    for (const other of context.pages().filter(other => other !== page))
      await other.close()
    try {
      await page.unroute('**/assets/outbox.worker-*.js')
      await openOutboxProbe(page)
      await expect.poll(async () => removeMirrorOf(page, owner.id), { timeout: 10_000 }).toBe('removed')
    }
    finally {
      await context.close()
    }
  }
})

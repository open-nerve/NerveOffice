// M4-P6：生产构建的本机保存与离线快进。只用公开 UI、真实网络和只读磁盘观察。
import type { Workbook } from '../../support/sheet.ts'
import { recordWrites } from '../../support/autosave.ts'
import { createUser, expireEditLease, revisionOf } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

test.use({ autosave: 'running' })
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M4-02 生产：离线连续输入十分钟真实落盘，联网后无需新输入即快进同步', async ({ page, context }, testInfo) => {
  await page.clock.install()
  const owner = await createUser('production-offline')
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId)
  const key = { userId: owner.id, documentId }
  const secret = await currentLocalKey(page)
  const writes = recordWrites(page, documentId)
  const rounds: { minute: number, draftSeq: number }[] = []
  try {
    await context.setOffline(true)
    for (let minute = 1; minute <= 10; minute += 1) {
      const value = `生产离线第 ${minute} 分钟`
      await typeInCell(page, 'A1', value)
      await expect.poll(async () => {
        const disk = (await readLocalDisk(page, key)).draft
        return disk === null ? undefined : cellOf(JSON.parse(diskSnapshot(disk, secret)) as Workbook, 'A1')?.v
      }).toBe(value)
      const disk = (await readLocalDisk(page, key)).draft!
      expect(disk.inFlight).toBeNull()
      expect(disk.draftSeq).toBeGreaterThan(rounds.at(-1)?.draftSeq ?? 0)
      rounds.push({ minute, draftSeq: disk.draftSeq })
      await expect(page.locator('[data-slot="local-save-status"] summary')).toHaveText('已离线，修改已保存在本机')
      await page.clock.fastForward(60_000)
    }
    expect(writes.saves).toHaveLength(0)
    expect(await revisionOf(documentId)).toBe(1)
    await expect(page.locator('[data-slot="connection-expiry"]')).toContainText('编辑权可能已过期')
    await expireEditLease(documentId)
    await context.setOffline(false)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    const cloud = await savedContent(page, documentId)
    expect(cloud.revision).toBe(2)
    expect(cellOf(cloud.snapshot, 'A1')?.v).toBe('生产离线第 10 分钟')
    expect(writes.saves).toHaveLength(1)
    await testInfo.attach('production-offline-evidence', {
      body: JSON.stringify({ documentId, rounds, cloudRevision: cloud.revision, cloudValue: cellOf(cloud.snapshot, 'A1')?.v, saves: writes.saves.length }),
      contentType: 'application/json',
    })
  }
  finally {
    await context.setOffline(false)
  }
})

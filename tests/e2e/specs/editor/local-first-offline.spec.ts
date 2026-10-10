// M4-P2 S5：真实离线输入、生产 Worker 密文、数据库过期与实际续租回包。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { recordWrites, releaseAutosave, saveParam } from '../../support/autosave.ts'
import { createUser, expireEditLease } from '../../support/database.ts'
import { setCellValue } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, saveButton, savedContent, saveStatus, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

async function openLocalSheet(page: Page, prefix: string) {
  const owner = await createUser(prefix)
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId)
  return { documentId, key: { userId: owner.id, documentId } }
}

function valueAt(text: string, cell = 'A1'): unknown {
  return cellOf(JSON.parse(text) as Workbook, cell)?.v
}

function localStatus(page: Page) {
  return page.locator('[data-slot="local-save-status"] summary')
}

interface LeaseReply {
  readonly method: string
  readonly status: number
  readonly release: () => void
}

/** 请求确实到真实后端，再逐个暂停回包。用于区分 online、续上成功与最后一次有效确认。 */
async function holdLeaseReplies(page: Page, documentId: string) {
  const replies: LeaseReply[] = []
  let holding = true
  await page.route(`**/api/documents/${documentId}/edit-lease`, async (route) => {
    if (!holding || route.request().method() === 'DELETE') {
      await route.continue()
      return
    }
    const response = await route.fetch()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    replies.push({ method: route.request().method(), status: response.status(), release })
    if (holding)
      await gate
    await route.fulfill({ response })
  })
  return { replies, releaseAll: () => {
    holding = false
    replies.forEach(reply => reply.release())
  } }
}

test.describe('US-M4-01/02/11 离线保存与联网复核', { tag: '@test-build' }, () => {
  test('真实离线连续输入十分钟仍落盘；数据库租约过期后先续上再确认，确认之前零上传', async ({ page, context }) => {
    await page.clock.install()
    const { documentId, key } = await openLocalSheet(page, 'offline-ten-minutes')
    const secret = await currentLocalKey(page)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    let held: Awaited<ReturnType<typeof holdLeaseReplies>> | undefined
    try {
      await context.setOffline(true)
      for (let minute = 1; minute <= 10; minute += 1) {
        const value = `离线第 ${minute} 分钟的输入`
        await typeInCell(page, 'A1', value)
        await expect.poll(async () => {
          const disk = (await readLocalDisk(page, key)).draft
          return disk === null ? undefined : valueAt(diskSnapshot(disk, secret))
        }).toBe(value)
        await expect(localStatus(page)).toHaveText('已离线，修改已保存在本机')
        await page.clock.fastForward(60_000)
      }
      await expect(page.locator('[data-slot="connection-expiry"]')).toContainText('编辑权可能已过期')
      expect(writes.saves).toHaveLength(0)
      const offlineDraft = (await readLocalDisk(page, key)).draft
      expect(offlineDraft?.inFlight).toBeNull()
      // 页面时钟不代表 PostgreSQL 时间：显式让真实租约到期。
      await expireEditLease(documentId)
      held = await holdLeaseReplies(page, documentId)
      await context.setOffline(false)
      await expect.poll(() => held?.replies.length).toBe(1)
      expect(held.replies[0]).toMatchObject({ method: 'PUT', status: 409 })
      expect(writes.saves).toHaveLength(0)
      held.replies[0]!.release()
      await expect.poll(() => held?.replies.length).toBe(2)
      expect(held.replies[1]).toMatchObject({ method: 'POST', status: 201 })
      expect(writes.saves).toHaveLength(0)
      held.replies[1]!.release()
      await expect.poll(() => held?.replies.length).toBe(3)
      expect(held.replies[2]).toMatchObject({ method: 'PUT', status: 200 })
      expect(writes.saves).toHaveLength(0)
      held.releaseAll()
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('离线第 10 分钟的输入')
      expect(writes.saves).toHaveLength(1)
      // 续上换了 writeEpoch；P2 不接手旧 writer 的磁盘记录，不能因新代上传成功擅自删除。
      expect((await readLocalDisk(page, key)).draft).toEqual(offlineDraft)
      await expect(localStatus(page)).toHaveText('本机已有草稿需要保留，当前修改暂留在本页')
      await expect(page.locator('[data-slot="connection-expiry"]')).toHaveCount(0)
    }
    finally {
      held?.releaseAll()
      await context.setOffline(false)
    }
  })

  test('navigator 仍在线但请求失败；旧心跳的成功不能恢复，无新输入也会复核并原样同步', async ({ page }) => {
    await page.clock.install()
    const { documentId, key } = await openLocalSheet(page, 'online-unresponsive')
    const secret = await currentLocalKey(page)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    let failing = false
    let holdNextHeartbeat = true
    let heartbeatReady = false
    let heartbeatStatus: number | undefined
    let heartbeatConsumed = false
    await page.exposeFunction('heartbeatConsumed', () => {
      heartbeatConsumed = true
    })
    await page.evaluate((id) => {
      const observed = window as typeof window & { heartbeatConsumed: () => Promise<void> }
      const fetch = window.fetch.bind(window)
      let first = true
      window.fetch = async (input, init) => {
        const response = await fetch(input, init)
        if (first && input === `/api/documents/${id}/edit-lease` && init?.method === 'PUT') {
          first = false
          const json = response.json.bind(response)
          response.json = async () => {
            const result: unknown = await json()
            // 被动观察真实正文消费；下一任务开始前，本次请求校验/连接发布的微任务已结算。
            setTimeout(() => {
              void observed.heartbeatConsumed()
            }, 0)
            return result
          }
        }
        return response
      }
    }, documentId)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      if (holdNextHeartbeat && request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`) {
        holdNextHeartbeat = false
        const response = await route.fetch()
        heartbeatStatus = response.status()
        heartbeatReady = true
        await held
        await route.fulfill({ response })
      }
      else if (failing) {
        await route.abort('failed')
      }
      else {
        await route.continue()
      }
    })
    try {
      await page.clock.fastForward(10_000)
      await expect.poll(() => heartbeatReady).toBe(true)
      expect(heartbeatStatus).toBe(200)
      await setCellValue(page, 'A1', '网络失败期间仍保留')
      failing = true
      await saveButton(page).click()
      await expect(saveStatus(page)).toHaveText('网络没有回应，正在重试')
      expect(await page.evaluate(() => navigator.onLine)).toBe(true)
      await expect.poll(async () => {
        const draft = (await readLocalDisk(page, key)).draft
        return draft === null ? undefined : valueAt(diskSnapshot(draft, secret))
      }).toBe('网络失败期间仍保留')
      expect(writes.saves).toHaveLength(1)
      release()
      await expect.poll(() => heartbeatConsumed).toBe(true)
      await expect(saveStatus(page)).toHaveText('网络没有回应，正在重试')
      expect(writes.saves).toHaveLength(1)
      failing = false
      // 没有新的编辑，也没有伪造 online 事件：正常复核和退避让原上传继续。
      await expect(saveStatus(page)).toHaveText('已保存到云端')
      expect(writes.saves).toHaveLength(2)
      expect(saveParam(writes.saves[1], 'requestId')).toBe(saveParam(writes.saves[0], 'requestId'))
      await expect.poll(async () => (await readLocalDisk(page, key)).draft).toBeNull()
      expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('网络失败期间仍保留')
    }
    finally {
      failing = false
      release()
    }
  })

  test('A 已落盘时新的未提交输入 B 仍只在本页，离开保护继续生效', async ({ page, context }) => {
    const { key } = await openLocalSheet(page, 'offline-current-input')
    try {
      await context.setOffline(true)
      await typeInCell(page, 'A1', '已经落盘的 A')
      await expect(localStatus(page)).toHaveText('已离线，修改已保存在本机')
      const before = (await readLocalDisk(page, key)).draft!
      await typeInCell(page, 'B1', '还没提交的 B', false)
      await expect(localStatus(page)).toHaveText('较早的修改已落盘，最新输入仍在本页')
      expect((await readLocalDisk(page, key)).draft?.draftSeq).toBe(before.draftSeq)
      const dialogs: string[] = []
      page.on('dialog', (dialog) => {
        dialogs.push(dialog.type())
        void dialog.dismiss()
      })
      await page.close({ runBeforeUnload: true })
      await expect.poll(() => dialogs).toEqual(['beforeunload'])
      expect(page.isClosed()).toBe(false)
      await expect(localStatus(page)).not.toHaveText('已离线，修改已保存在本机')
    }
    finally {
      await context.setOffline(false)
    }
  })
})

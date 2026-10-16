// 真实离线草稿与服务端失效事实，生产镜像也覆盖。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { DOCUMENT_LIST_DEFAULT_LIMIT } from '@nerve-office/contracts'
import { captureRejection } from '../../support/auth-rejection.ts'
import { localSessionSummary } from '../../support/cleanup-fault.ts'
import { createDocuments, createUser, expireSessions, revisionOf } from '../../support/database.ts'
import { actualLocalDraft } from '../../support/draft-catalog.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, expectFoundOnce, openAndEnterEditing, typeInCell } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })
type Draft = Awaited<ReturnType<typeof actualLocalDraft>>

async function adminFor(page: Page) {
  await loginThroughApi(page, await createUser('cleanup-admin', '清理验证管理员', { systemRole: 'admin' }))
}

/** 只安排真实请求的发送顺序；不替换响应、Cookie 或应用的认证处理。 */
async function holdRequests(page: Page, paths: readonly string[]) {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = 0
  await page.route(url => paths.includes(url.pathname), async (route) => {
    held += 1
    await released
    await route.continue()
  })
  return { release, held: () => held }
}

for (const { name, reason, invalidate } of [
  { name: '普通登录过期', reason: 'expired', invalidate: async (h: Draft, _page: Page) => expireSessions(h.owner) },
  { name: '管理员重置密码', reason: 'password_reset', invalidate: async (h: Draft, page: Page) => {
    await adminFor(page)
    await actAs(page, 'POST', `/api/admin/users/${h.owner.id}/password-reset`)
  } },
  { name: '另一设备修改密码', reason: 'password_changed', invalidate: async (h: Draft, page: Page) => {
    await loginThroughApi(page, h.owner)
    await actAs(page, 'PUT', '/api/auth/password', { currentPassword: h.owner.password, newPassword: 'cleanup brand new password' })
  } },
]) {
  test(`US-M4-09 ${name}仅停止本机写入：重新确认会话后原草稿逐字节保留，云端不变`, async ({ page, anotherDevice }) => {
    const h = await actualLocalDraft(page, '认证失效也不能擅自删除')
    // 先借公开页读取同源原件；这里不采纳会话，后台目录不会抢先消费首次过期响应并清掉 Cookie。
    await page.goto('/reset-password')
    const original = await readLocalDisk(page, h.key)
    await invalidate(h, anotherDevice)
    const rejected = await captureRejection(page, '/api/auth/session')
    await page.goto('/')
    await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
    expect(rejected()).toMatchObject({ status: 401, body: { error: { code: 'SESSION_EXPIRED', details: { reason, userId: h.owner.id } } } })
    // 登录页沿既有通用失效说明；具体已验证事实供本机清理分类使用。
    expect(new URL(page.url()).searchParams.get('reason')).toBe('expired')
    expect(await readLocalDisk(page, h.key)).toEqual(original)
    expect(await revisionOf(h.documentId)).toBe(1)
  })
}

async function triggerRejectedRequest(page: Page, trigger: 'query' | 'request' | 'editor-query', documentId: string): Promise<void> {
  if (trigger === 'editor-query')
    await page.goto(`/documents/${documentId}`)
  else if (trigger === 'query')
    await page.goto('/')
  else
    await page.getByRole('button', { name: '加载更多' }).click()
}

async function prepareRejectedRequest(page: Page, trigger: 'query' | 'request' | 'editor-query', h: Draft) {
  if (trigger !== 'request') {
    await page.goto('/reset-password')
    return undefined
  }
  const background = await holdRequests(page, ['/api/documents/draft-facts', '/api/local-key'])
  await createDocuments(h.owner, '用于下一页请求', DOCUMENT_LIST_DEFAULT_LIMIT)
  await page.goto('/?view=list')
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible()
  return background
}

for (const trigger of ['query', 'request', 'editor-query'] as const) {
  test(`US-M4-09 账户明确停用（${trigger}）：原请求确证停用后删除本人草稿和写入者，云端不变`, async ({ page, anotherDevice }) => {
    const h = await actualLocalDraft(page, '停用后应清理的本机内容')
    // 初查从公开页开始；普通请求则让指定入口先收到停用。后台先收到的相反顺序另有真实故事。
    const background = await prepareRejectedRequest(page, trigger, h)
    try {
      expect((await readLocalDisk(page, h.key)).draft).not.toBeNull()
      const rejected = await captureRejection(page, trigger === 'request' ? '/api/documents' : '/api/auth/session')
      await adminFor(anotherDevice)
      await actAs(anotherDevice, 'POST', `/api/admin/users/${h.owner.id}/disable`)
      await triggerRejectedRequest(page, trigger, h.documentId)
      await expect.poll(rejected).toMatchObject({ status: 401, body: { error: { code: 'SESSION_EXPIRED', details: { reason: 'account_disabled', userId: h.owner.id } } } })
      background?.release()
      await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
      expect(new URL(page.url()).searchParams.get('reason')).toBe('account_disabled_confirmed')
      await expect(page.getByText('你的账户已被停用。请联系系统管理员确认账户状态。')).toBeVisible()
      await expect.poll(async () => readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
      expect(await revisionOf(h.documentId)).toBe(1)
    }
    finally {
      background?.release()
    }
  })
}

for (const pathname of ['/api/documents/draft-facts', '/api/local-key']) {
  test(`US-M4-09 后台请求首先确证账户停用（${pathname}）：平台说明原因并清理，云端不变`, async ({ page, anotherDevice }, testInfo) => {
    const h = await actualLocalDraft(page, '后台首先得知停用也不能漏掉原因')
    await adminFor(anotherDevice)
    const rejected = await captureRejection(page, pathname)
    const background = await holdRequests(page, [pathname])
    try {
      await page.goto('/?view=list')
      await expect.poll(background.held).toBe(1)
      await actAs(anotherDevice, 'POST', `/api/admin/users/${h.owner.id}/disable`)
      background.release()
      await expect.poll(rejected).toMatchObject({ status: 401, body: { error: { code: 'SESSION_EXPIRED', details: { reason: 'account_disabled', userId: h.owner.id } } } })
      await expect(page.getByRole('form', { name: '登录' })).toBeVisible()
      expect(new URL(page.url()).searchParams.get('reason')).toBe('account_disabled_confirmed')
      await expect(page.getByText('你的账户已被停用。请联系系统管理员确认账户状态。')).toBeVisible()
      await expect.poll(async () => readLocalDisk(page, h.key)).toEqual({ draft: null, writer: null })
      expect(await revisionOf(h.documentId)).toBe(1)
    }
    finally {
      background.release()
      await testInfo.attach('local-session-after-background-disabled', { body: JSON.stringify(await localSessionSummary(page)), contentType: 'application/json' })
    }
  })
}

test('US-M4-09 开着的离线编辑页得知停用：说明原因并清理落盘原件，内存修改保留且不上传', async ({ page, context, anotherDevice }, testInfo) => {
  const owner = await createUser('disabled-editor')
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  const key = { userId: owner.id, documentId }
  const secret = await currentLocalKey(page)
  await openAndEnterEditing(page, documentId)
  try {
    await context.setOffline(true)
    await typeInCell(page, 'A1', '停用前尚未同步的修改')
    await expect.poll(async () => {
      const draft = (await readLocalDisk(page, key)).draft
      return draft === null ? undefined : cellOf(JSON.parse(diskSnapshot(draft, secret)) as Workbook, 'A1')?.v
    }).toBe('停用前尚未同步的修改')
    await adminFor(anotherDevice)
    await actAs(anotherDevice, 'POST', `/api/admin/users/${owner.id}/disable`)
    await context.setOffline(false)
    await expect(page.getByRole('alert').filter({ hasText: '你的账户已被停用。请联系系统管理员确认账户状态。' })).toBeVisible()
    await expect(page.getByText('本页的修改仍留在内存中，关闭页面会丢失。账户重新启用并登录后才能继续保存。')).toBeVisible()
    await expect.poll(async () => readLocalDisk(page, key)).toEqual({ draft: null, writer: null })
    // 生产镜像没有编辑器探针；通过公开查找核对仍留在本页的内容。
    await expectFoundOnce(page, '停用前尚未同步的修改')
    expect(await revisionOf(documentId)).toBe(1)
  }
  finally {
    await context.setOffline(false)
    await testInfo.attach('local-session-after-disabled', { body: JSON.stringify(await localSessionSummary(page)), contentType: 'application/json' })
  }
})

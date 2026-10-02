// 个人空间的文档列表（P3，US-M1-03）：只含本人的文档；加载中、空列表、加载失败都有明确的显示；加载更多。
import { DOCUMENT_LIST_DEFAULT_LIMIT } from '@nerve-office/contracts'
import { createDocument, createDocuments, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 文档列表的请求（任何空间、任何一页） */
function isDocumentList(url: URL): boolean {
  return url.pathname === '/api/documents'
}

test.describe('US-M1-03 个人空间的文档列表', () => {
  test('只列出本人个人空间里的文档', async ({ page }) => {
    const owner = await createUser('list-owner')
    const other = await createUser('list-other')
    await createDocument(owner, '我的周报')
    await createDocument(owner, '我的预算表')
    await createDocument(other, '别人的机密表格')

    await loginThroughApi(page, owner)
    await page.goto('/')
    const list = page.getByRole('list', { name: '文档列表' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list).toContainText('我的周报')
    await expect(list).toContainText('我的预算表')
    await expect(page.getByText('别人的机密表格')).toBeHidden()
  })

  test('空的个人空间：明确的说明', async ({ page }) => {
    await loginThroughApi(page, await createUser('list-empty'))
    await page.goto('/')
    await expect(page.getByText('这里还没有文档')).toBeVisible()
  })

  test('按钮里的图标按设计的尺寸显示：按钮 16px，小按钮与做成小按钮样子的链接 14px（M2-P6 复核第四批：选择器写坏时都是 lucide 默认的 24px）', async ({ page }) => {
    await loginThroughApi(page, await createUser('list-icons'))
    await page.goto('/')
    const newSheet = page.getByRole('button', { name: '新建表格', exact: true }).locator('svg')
    await expect(newSheet).toBeVisible()
    expect(await newSheet.boundingBox()).toMatchObject({ width: 16, height: 16 })
    // 窄屏时页头的"修改密码"只留图标：它是做成小按钮样子的链接，没有自己写图标的尺寸
    await page.setViewportSize({ width: 375, height: 700 })
    const changePassword = page.getByRole('banner').getByRole('link', { name: '修改密码', exact: true }).locator('svg')
    await expect(changePassword).toBeVisible()
    expect(await changePassword.boundingBox()).toMatchObject({ width: 14, height: 14 })
  })

  test('加载中显示列表自己的骨架屏，加载完成后显示文档', async ({ page }) => {
    const owner = await createUser('list-loading')
    await createDocument(owner, '慢慢加载的文档')
    await loginThroughApi(page, owner)
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // 列表按空间取（M2-P2）：地址带查询串，按路径拦
    await page.route(isDocumentList, async (route) => {
      await released
      await route.continue()
    })
    await page.goto('/')
    // 名称与"正在确认登录状态"的骨架屏不同：断言的确实是列表自己的加载态（审查 B10）
    const skeleton = page.getByRole('status', { name: '正在加载文档列表…' })
    await expect(skeleton).toBeVisible()
    await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
    release()
    await expect(page.getByText('慢慢加载的文档')).toBeVisible()
    await expect(skeleton).toBeHidden()
  })

  test('加载失败：说明原因，可以重试', async ({ page }) => {
    const owner = await createUser('list-failure')
    await createDocument(owner, '重试之后才看到的文档')
    await loginThroughApi(page, owner)
    await page.route(isDocumentList, async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用', requestId: 'e2e' } }),
    }))
    await page.goto('/')
    // 5xx 自动重试一次之后才显示失败
    await expect(page.getByText('文档列表加载失败')).toBeVisible()
    await expect(page.getByText('服务暂时不可用，请稍后重试')).toBeVisible()

    await page.unroute(isDocumentList)
    await page.getByRole('button', { name: '重试' }).click()
    await expect(page.getByText('重试之后才看到的文档')).toBeVisible()
  })

  test('加载更多：用键盘加载下一页，焦点移到第一个新条目（审查 B13）', async ({ page }) => {
    const owner = await createUser('list-more')
    await createDocuments(owner, '分页的文档', DOCUMENT_LIST_DEFAULT_LIMIT + 5)
    await loginThroughApi(page, owner)
    await page.goto('/')
    const items = page.getByRole('list', { name: '文档列表' }).getByRole('listitem')
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT)
    const loadMore = page.getByRole('button', { name: '加载更多' })
    await loadMore.focus()
    await page.keyboard.press('Enter')
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT + 5)
    // 条目是打开编辑器页的链接：焦点在第一个新条目的链接上
    await expect(items.nth(DOCUMENT_LIST_DEFAULT_LIMIT).getByRole('link')).toBeFocused()
    // 没有下一页了，按钮不再显示
    await expect(loadMore).toBeHidden()
  })

  test('断网时加载更多：提示网络错误，已加载的列表保留；恢复后再点即可加载（审查 B4）', async ({ page, context }) => {
    const owner = await createUser('list-offline')
    await createDocuments(owner, '断网时的文档', DOCUMENT_LIST_DEFAULT_LIMIT + 5)
    await loginThroughApi(page, owner)
    await page.goto('/')
    const items = page.getByRole('list', { name: '文档列表' }).getByRole('listitem')
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT)
    await context.setOffline(true)
    await page.getByRole('button', { name: '加载更多' }).click()
    // 网络失败自动重试一次之后才显示
    await expect(page.getByRole('alert')).toHaveText('网络连接失败，请检查网络后重试')
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT)
    await context.setOffline(false)
    await page.getByRole('button', { name: '加载更多' }).click()
    await expect(items).toHaveCount(DOCUMENT_LIST_DEFAULT_LIMIT + 5)
  })
})

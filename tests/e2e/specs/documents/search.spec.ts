// 按标题搜索（M2-P4，US-M2-12）：页头的搜索框找到我能访问的文档，结果里带着它在哪里；回收站里的搜不到。
// 顺带核对页头的排布（审查 B3）：搜索框加进页头之后，当前用户那一组仍然贴着右边。
import type { Locator, Page } from '@playwright/test'
import { createDocumentIn, createFolderIn, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

/** 量一个元素在页面上的位置；量不到（没渲染出来）就让用例失败 */
async function boxOf(locator: Locator): Promise<{ readonly x: number, readonly width: number }> {
  const box = await locator.boundingBox()
  if (box === null)
    throw new Error('元素没有出现在页面上，量不到它的位置')
  return box
}

/** 视口的宽度 */
function viewportWidth(page: Page): number {
  const viewport = page.viewportSize()
  if (viewport === null)
    throw new Error('这个用例要在有视口的浏览器里跑')
  return viewport.width
}

test.describe('US-M2-12 按标题搜索', () => {
  test('搜到并打开：结果给出空间与文件夹路径；删掉的文档在回收站里，搜不到', async ({ page }) => {
    const owner = await createUser('search-owner')
    const folderId = await createFolderIn(owner.personalSpaceId, owner, '归档')
    const draftId = await createDocumentIn(owner.personalSpaceId, owner, '预算草稿', { folderId })
    await createDocumentIn(owner.personalSpaceId, owner, '年度预算表')

    await loginThroughApi(page, owner)
    await page.goto('/')

    // 页头的排布（M2-P4 审查 B3）：当前用户那一组贴着页头内容的右边，搜索框落在中间的空当里，右边不空出一大片。
    // 页头是居中的定宽容器，左右内边距相同，所以"内容的右边"就是视口宽度减去产品名称的左边
    const brand = await boxOf(page.getByRole('link', { name: 'NerveOffice', exact: true }))
    const searchBox = await boxOf(page.getByRole('search'))
    const signOut = await boxOf(page.getByRole('button', { name: '退出', exact: true }))
    expect(Math.abs(signOut.x + signOut.width - (viewportWidth(page) - brand.x))).toBeLessThanOrEqual(2)
    expect(searchBox.x - (brand.x + brand.width)).toBeGreaterThan(100)

    // 先把根目录下那一份删掉：回收站里的不该被搜到
    await page.getByRole('button', { name: '操作 年度预算表', exact: true }).click()
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByText('已把「年度预算表」移到回收站')).toBeVisible()

    const box = page.getByRole('search')
    await box.getByLabel('按标题搜索文档', { exact: true }).fill('预算')
    await box.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page).toHaveURL(/\/search\?q=/)
    await expect(page.getByRole('heading', { name: '“预算”的搜索结果' })).toBeVisible()
    // 排序如实写明是"最近更新在前"，不是"最佳匹配"
    await expect(page.getByText('按标题匹配，最近更新在前。')).toBeVisible()

    const results = page.getByRole('list', { name: '搜索结果' }).getByRole('listitem')
    await expect(results).toHaveCount(1)
    await expect(results.first()).toContainText('预算草稿')
    await expect(results.first()).toContainText('我的空间 / 归档')

    await results.first().getByRole('link').click()
    await expect(page).toHaveURL(`/documents/${draftId}`)
  })

  test('窄屏：页头各项互不重叠、不溢出——搜索框折到第二行，宽一些时回到中间、名字收窄（M2-P6 复核第三批 G-e，M2-P1 审查 B11）', async ({ page }) => {
    // 系统管理员（页头多一个"管理"）、显示名很长：最挤的情形
    const admin = await createUser('narrow-header', '一个很长很长很长很长很长很长很长很长的显示名', { systemRole: 'admin' })
    await loginThroughApi(page, admin)
    await page.goto('/')
    const header = page.getByRole('banner')
    const parts = {
      'brand': header.getByRole('link', { name: 'NerveOffice', exact: true }),
      'admin': header.getByRole('link', { name: '管理', exact: true }),
      'search': header.getByRole('search').getByLabel('按标题搜索文档', { exact: true }),
      'submit': header.getByRole('search').getByRole('button', { name: '搜索', exact: true }),
      'name': header.locator('[data-slot="person-name"]'),
      // 窄屏时只留图标，可读名称不变
      'change-password': header.getByRole('link', { name: '修改密码', exact: true }),
      'sign-out': header.getByRole('button', { name: '退出', exact: true }),
    }
    for (const width of [320, 360, 480, 639, 640, 768]) {
      await page.setViewportSize({ width, height: 700 })
      await expect(page.getByRole('heading', { level: 1, name: '我的空间' })).toBeVisible()
      const boxes = await Promise.all(Object.entries(parts).map(async ([part, locator]) => {
        const box = await locator.boundingBox()
        if (box === null)
          throw new Error(`${width}px 宽时页头里的 ${part} 没有出现`)
        return { part, box }
      }))
      for (const [index, { part, box }] of boxes.entries()) {
        // 不溢出：每一项都在视口之内
        expect(box.x, `${width}px：${part}`).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width, `${width}px：${part}`).toBeLessThanOrEqual(width + 0.5)
        // 互不重叠（原来 520px 以下"搜索"按钮挤出搜索框、盖到人名上）
        for (const other of boxes.slice(index + 1)) {
          const apart = box.x + box.width <= other.box.x + 0.5 || other.box.x + other.box.width <= box.x + 0.5
            || box.y + box.height <= other.box.y + 0.5 || other.box.y + other.box.height <= box.y + 0.5
          expect(apart, `${width}px：${part} 与 ${other.part} 重叠`).toBe(true)
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${width}px：页面横向溢出`).toBeLessThanOrEqual(width)
      // 名字收窄成省略号，可见的宽度不为 0；完整的名字在 title 里
      const name = boxes.find(({ part }) => part === 'name')?.box
      expect(name?.width ?? 0, `${width}px：名字被挤没了`).toBeGreaterThan(0)
    }
  })
})

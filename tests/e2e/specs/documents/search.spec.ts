// 按标题搜索（M2-P4，US-M2-12）：页头的搜索框找到我能访问的文档，结果里带着它在哪里；回收站里的搜不到。
import { createDocumentIn, createFolderIn, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('US-M2-12 按标题搜索', () => {
  test('搜到并打开：结果给出空间与文件夹路径；删掉的文档在回收站里，搜不到', async ({ page }) => {
    const owner = await createUser('search-owner')
    const folderId = await createFolderIn(owner.personalSpaceId, owner, '归档')
    const draftId = await createDocumentIn(owner.personalSpaceId, owner, '预算草稿', { folderId })
    await createDocumentIn(owner.personalSpaceId, owner, '年度预算表')

    await loginThroughApi(page, owner)
    await page.goto('/')
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
})

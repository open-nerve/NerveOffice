// 文件夹与文档的整理（M2-P4，US-M2-07）：新建文件夹、进入与面包屑、在里面新建表格、改名、移动、删除；
// 跨空间移动之后权限随之改变；查看者看不到这些入口。行内按钮的可读名称是"操作 对象"。
import type { Page } from '@playwright/test'
import { createDocumentIn, createFolderIn, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

const FOLDER_URL = /\/spaces\/[\da-f-]{36}\/folders\/[\da-f-]{36}$/

/** 展开某一行的操作面板（可读名称是"操作 对象"，P1 交接单的约定） */
async function openActions(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `操作 ${name}`, exact: true }).click()
}

/** 在当前位置新建一个文件夹 */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click()
  const form = page.getByRole('form', { name: '新建文件夹' })
  await form.getByLabel('文件夹名称', { exact: true }).fill(name)
  await form.getByRole('button', { name: '新建文件夹', exact: true }).click()
  await expect(form).toHaveCount(0)
}

test.describe('US-M2-07 文件夹与文档的整理', () => {
  test('新建文件夹、在里面新建表格，改名、移回空间根目录、删除，再从回收站恢复与永久删除（US-M2-09 的主链路）', async ({ page }) => {
    const owner = await createUser('org-main')
    await loginThroughApi(page, owner)
    await page.goto('/')
    await createFolder(page, '方案')

    // 进入文件夹：地址能直达，面包屑从空间名到当前文件夹
    await page.getByRole('list', { name: '文件夹列表' }).getByRole('link', { name: '方案', exact: true }).click()
    await expect(page).toHaveURL(FOLDER_URL)
    const folderUrl = page.url()
    const breadcrumb = page.getByRole('navigation', { name: '位置' })
    await expect(breadcrumb.getByRole('link', { name: '我的空间', exact: true })).toBeVisible()
    await expect(breadcrumb.getByText('方案', { exact: true })).toHaveAttribute('aria-current', 'page')

    // 在这个文件夹里新建表格：建好之后整页打开编辑器页，回到文件夹时它就在这一层
    await page.getByRole('button', { name: '新建表格', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[\da-f-]{36}$/)
    await page.goto(folderUrl)
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('未命名表格')

    // 改名（行内表单，不是弹窗）
    await openActions(page, '未命名表格')
    await page.getByRole('button', { name: '改名', exact: true }).click()
    await page.getByLabel('未命名表格 的新名称', { exact: true }).fill('季度方案')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('季度方案')

    // 移回空间的根目录：目标位置就是当前空间的根，说明里回述去处
    await openActions(page, '季度方案')
    await page.getByRole('button', { name: '移动', exact: true }).click()
    await page.getByRole('form', { name: '移动' }).getByRole('button', { name: '移动到这里', exact: true }).click()
    await expect(page.getByText('已把「季度方案」移动到我的空间')).toBeVisible()
    await expect(page.getByRole('list', { name: '文档列表' })).toHaveCount(0)

    // 删除：进回收站，说明里给出回收站的入口
    await page.getByRole('navigation', { name: '位置' }).getByRole('link', { name: '我的空间', exact: true }).click()
    await openActions(page, '季度方案')
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByText('已把「季度方案」移到回收站')).toBeVisible()
    await page.getByRole('link', { name: '打开回收站', exact: true }).click()

    // 回收站：恢复回原位置
    const row = page.getByRole('table', { name: '回收站列表' }).getByRole('row').filter({ hasText: '季度方案' })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: '恢复 季度方案', exact: true }).click()
    await expect(page.getByText('已恢复「季度方案」')).toBeVisible()
    await page.getByRole('link', { name: '返回空间', exact: true }).click()
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('季度方案')

    // 再删一次，这回永久删除（要确认）
    await openActions(page, '季度方案')
    await page.getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('link', { name: '打开回收站', exact: true }).click()
    await page.getByRole('button', { name: '永久删除 季度方案', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '永久删除', exact: true }).click()
    await expect(page.getByText('已永久删除「季度方案」')).toBeVisible()
    await expect(page.getByText('回收站里没有内容')).toBeVisible()
  })

  test('跨空间移动：文档换了空间，原空间的编辑者不再看得到、也打不开它', async ({ page, anotherDevice }) => {
    const lead = await createUser('org-move-lead')
    const mate = await createUser('org-move-mate')
    const from = await createTeamSpace('甲组', lead, [[lead, 'admin'], [mate, 'editor']])
    const to = await createTeamSpace('乙组', lead, [[lead, 'admin']])
    const documentId = await createDocumentIn(from.id, lead, '合同')

    // 编辑者在原空间里能改它
    await loginThroughApi(anotherDevice, mate)
    await anotherDevice.goto(`/spaces/${from.id}`)
    await openActions(anotherDevice, '合同')
    await expect(anotherDevice.getByRole('button', { name: '改名', exact: true })).toBeVisible()

    // 空间管理员把它移到乙组
    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${from.id}`)
    await openActions(page, '合同')
    await page.getByRole('button', { name: '移动', exact: true }).click()
    const form = page.getByRole('form', { name: '移动' })
    await form.getByLabel('目标空间', { exact: true }).selectOption({ label: to.name })
    await form.getByRole('button', { name: '移动到这里', exact: true }).click()
    await expect(page.getByText(`已把「合同」移动到${to.name}`)).toBeVisible()
    await page.goto(`/spaces/${to.id}`)
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('合同')

    // 原空间的编辑者：列表里没有了，直接打开也不行（权限跟着空间走）
    await anotherDevice.goto(`/spaces/${from.id}`)
    await expect(anotherDevice.getByText('这里还没有文档')).toBeVisible()
    await anotherDevice.goto(`/documents/${documentId}`)
    await expect(anotherDevice.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
  })

  test('查看者：没有新建文件夹与新建表格，文件夹那一行没有操作，文档只能复制', async ({ page }) => {
    const lead = await createUser('org-view-lead')
    const reader = await createUser('org-view-reader')
    const space = await createTeamSpace('公示栏', lead, [[lead, 'admin'], [reader, 'viewer']])
    const folderId = await createFolderIn(space.id, lead, '存档')
    await createDocumentIn(space.id, lead, '规章', { folderId })
    await createDocumentIn(space.id, lead, '通知')

    await loginThroughApi(page, reader)
    await page.goto(`/spaces/${space.id}`)
    await expect(page.getByRole('list', { name: '文件夹列表' }).getByRole('link', { name: '存档', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '新建表格', exact: true })).toHaveCount(0)
    // 一个操作都做不了的文件夹连"操作"都不显示
    await expect(page.getByRole('button', { name: '操作 存档', exact: true })).toHaveCount(0)
    // 文档能读就能复制（目标空间的新建权限另判），改名、移动、删除都没有
    await openActions(page, '通知')
    await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    for (const action of ['改名', '移动', '删除'])
      await expect(page.getByRole('button', { name: action, exact: true })).toHaveCount(0)
  })
})

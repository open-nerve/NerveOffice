// 文件夹与文档的整理（M2-P4，US-M2-07）：新建文件夹、进入与面包屑、在里面新建表格、改名、移动、删除；
// 跨空间移动之后权限随之改变；查看者看不到这些入口。行内按钮的可读名称是"操作 对象"。
// 选目标位置时按下的按钮随之卸载（"移动"、点进的文件夹、回到根目录时的"上一级"）：焦点交给"目标位置"这一行（DEF-049）。
import type { Page, Request } from '@playwright/test'
import { createDocument, createDocumentIn, createFolderIn, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

const FOLDER_URL = /\/spaces\/[\da-f-]{36}\/folders\/[\da-f-]{36}$/

/** 展开某一行的操作面板（可读名称是"操作 对象"，P1 交接单的约定） */
async function openActions(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `操作 ${name}`, exact: true }).click()
}

/**
 * 记下这个页面发出的"新建文档"与"移动文档"请求（路径）：
 * 在文件夹里新建是一次请求（带 folderId），用例据此核对没有跟着一次移动。
 */
function watchDocumentWrites(page: Page): { readonly paths: string[], readonly stop: () => void } {
  const paths: string[] = []
  const listener = (request: Request): void => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && (path === '/api/documents' || path.endsWith('/move')))
      paths.push(path)
  }
  page.on('request', listener)
  return { paths, stop: () => page.off('request', listener) }
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

    // 在这个文件夹里新建表格：一次请求就建在这一层（契约的 folderId），不再"先建到根目录、再移进来"；
    // 建好之后整页打开编辑器页，回到文件夹时它就在这一层
    const writes = watchDocumentWrites(page)
    await page.getByRole('button', { name: '新建表格', exact: true }).click()
    await expect(page).toHaveURL(/\/documents\/[\da-f-]{36}$/)
    expect(writes.paths).toEqual(['/api/documents'])
    writes.stop()
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

  test('文件夹改名；把文档、文件夹移进另一个文件夹；在文件夹里新建子文件夹（M2-P6 复核 M3：核心链路里源与目标不同的每一步）', async ({ page }) => {
    const owner = await createUser('org-into')
    await createFolderIn(owner.personalSpaceId, owner, '方案')
    await createFolderIn(owner.personalSpaceId, owner, '草稿')
    await createDocument(owner, '合同')
    await loginThroughApi(page, owner)
    await page.goto('/')
    const folders = page.getByRole('list', { name: '文件夹列表' })

    // 文件夹改名：列表里是新名称，旧名称不在了
    await openActions(page, '方案')
    await page.getByRole('button', { name: '改名', exact: true }).click()
    await page.getByLabel('方案 的新名称', { exact: true }).fill('季度方案')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(folders.getByRole('link', { name: '季度方案', exact: true })).toBeVisible()
    await expect(folders.getByRole('link', { name: '方案', exact: true })).toHaveCount(0)

    // 把文档移进"季度方案"：在目标位置里点进那个文件夹，再"移动到这里"
    await openActions(page, '合同')
    await page.getByRole('button', { name: '移动', exact: true }).click()
    const moveDocument = page.getByRole('form', { name: '移动' })
    await moveDocument.getByRole('button', { name: '进入 季度方案', exact: true }).click()
    await expect(moveDocument.getByText('目标位置：我的空间 / 季度方案')).toBeVisible()
    await moveDocument.getByRole('button', { name: '移动到这里', exact: true }).click()
    await expect(page.getByText('已把「合同」移动到我的空间 / 季度方案')).toBeVisible()
    await expect(page.getByRole('list', { name: '文档列表' })).toHaveCount(0)

    // 把文件夹"草稿"也移进"季度方案"：根目录下不再有它
    await openActions(page, '草稿')
    await page.getByRole('button', { name: '移动', exact: true }).click()
    const moveFolder = page.getByRole('form', { name: '移动' })
    await moveFolder.getByRole('button', { name: '进入 季度方案', exact: true }).click()
    await moveFolder.getByRole('button', { name: '移动到这里', exact: true }).click()
    await expect(page.getByText('已把「草稿」移动到我的空间 / 季度方案')).toBeVisible()
    await expect(folders.getByRole('link', { name: '草稿', exact: true })).toHaveCount(0)

    // 进到"季度方案"：文档与文件夹都在这一层
    await folders.getByRole('link', { name: '季度方案', exact: true }).click()
    await expect(page).toHaveURL(FOLDER_URL)
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('合同')
    await expect(folders.getByRole('link', { name: '草稿', exact: true })).toBeVisible()

    // 在文件夹里新建子文件夹：它在这一层，不在空间的根目录
    await createFolder(page, '子文件夹')
    await expect(folders.getByRole('link', { name: '子文件夹', exact: true })).toBeVisible()
    await page.getByRole('navigation', { name: '位置' }).getByRole('link', { name: '我的空间', exact: true }).click()
    await expect(folders.getByRole('link', { name: '季度方案', exact: true })).toBeVisible()
    await expect(folders.getByRole('link', { name: '子文件夹', exact: true })).toHaveCount(0)
  })

  test('只用键盘移动文档：打开"移动"、点进文件夹、按"上一级"（还在里面一层与回到根目录）之后，焦点都交给"目标位置"这一行，不交给页面的标题；最后移进文件夹（DEF-049）', async ({ page }) => {
    const owner = await createUser('org-keyboard')
    const plan = await createFolderIn(owner.personalSpaceId, owner, '方案')
    await createFolderIn(owner.personalSpaceId, owner, '二季度', plan)
    await createDocument(owner, '合同')
    await loginThroughApi(page, owner)
    await page.goto('/')
    await page.getByRole('button', { name: '操作 合同', exact: true }).press('Enter')
    // "移动"随面板换成表单而卸载：焦点交给目标位置（默认是它现在所在的地方）
    await page.getByRole('button', { name: '移动', exact: true }).press('Enter')
    const form = page.getByRole('form', { name: '移动' })
    const target = (label: string) => form.getByText(`目标位置：${label}`, { exact: true })
    await expect(target('我的空间')).toBeFocused()

    // 点进的文件夹不在新的一层里：焦点交给目标位置，读屏读到新的位置
    await form.getByRole('button', { name: '进入 方案', exact: true }).press('Enter')
    await expect(target('我的空间 / 方案')).toBeFocused()
    await form.getByRole('button', { name: '进入 二季度', exact: true }).press('Enter')
    await expect(target('我的空间 / 方案 / 二季度')).toBeFocused()

    // 还在里面一层："上一级"留着，焦点同样交给目标位置（换到的位置读屏听得到）
    const up = form.getByRole('button', { name: '上一级', exact: true })
    await up.press('Enter')
    await expect(target('我的空间 / 方案')).toBeFocused()
    // 回到根目录："上一级"随之卸载（DEF-049 登记的那一处），焦点交给目标位置，不交给页面的标题
    await up.press('Enter')
    await expect(up).toHaveCount(0)
    await expect(target('我的空间')).toBeFocused()

    await form.getByRole('button', { name: '进入 方案', exact: true }).press('Enter')
    await expect(target('我的空间 / 方案')).toBeFocused()
    await form.getByRole('button', { name: '移动到这里', exact: true }).press('Enter')
    await expect(page.getByText('已把「合同」移动到我的空间 / 方案')).toBeVisible()
    await expect(page.getByRole('list', { name: '文档列表' })).toHaveCount(0)
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

  test('删除的结果未知（服务端照常删了，回包换成代理的 502）：列表刷新、那一行消失，说明"列表已刷新"——打开着的那份文档再取元数据得到 404，不算没能刷新（M2-P6 复核第五批 S-1）', async ({ page }) => {
    const owner = await createUser('org-unknown')
    const id = await createDocument(owner, '要删除的周报')
    await loginThroughApi(page, owner)
    await page.goto('/')
    await page.route(`**/api/documents/${id}`, async (route) => {
      if (route.request().method() !== 'DELETE')
        return route.continue()
      await route.fetch()
      return route.fulfill({ status: 502, contentType: 'text/html', body: 'bad gateway' })
    })
    await openActions(page, '要删除的周报')
    await page.getByRole('button', { name: '删除', exact: true }).click()
    // 原来 WebKit 上元数据的 404 先回来，说成"列表没能刷新"，而那一行已经消失了
    await expect(page.getByText('没能确认「要删除的周报」是否已经删除（出了点问题，请稍后重试）。列表已刷新：它已经不在这里，就是已经移到回收站了；还在的话可以再删除一次。')).toBeVisible()
    await expect(page.getByRole('button', { name: '操作 要删除的周报', exact: true })).toHaveCount(0)
    await expect(page.getByText(/列表没能刷新/)).toHaveCount(0)
  })

  test('再次展开"操作"时重新取文档的权限失败：之前的操作照常列出，说明可以做的操作没能刷新；恢复之后按"重试"，说明消失、焦点交给面板里的"取消"（DEF-040）', async ({ page }) => {
    const owner = await createUser('org-detail')
    const id = await createDocument(owner, '季度预算')
    await loginThroughApi(page, owner)
    await page.goto('/')
    // 第一次展开取到权限；收起之后缓存里还有
    await openActions(page, '季度预算')
    await expect(page.getByRole('button', { name: '改名', exact: true })).toBeVisible()
    await openActions(page, '季度预算')
    await expect(page.getByRole('button', { name: '改名', exact: true })).toHaveCount(0)

    // 只拦这份文档的元数据（列表照常）：服务暂时不可用，查询自动重试一次之后才算失败
    const isDetail = (url: URL): boolean => url.pathname === `/api/documents/${id}`
    await page.route(isDetail, async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用', requestId: 'e2e' } }),
    }))
    await openActions(page, '季度预算')
    const problem = page.getByRole('alert').filter({ hasText: '可以做的操作没能刷新，显示的还是之前的内容' })
    await expect(problem).toBeVisible()
    await expect(problem).toContainText('服务暂时不可用，请稍后重试')
    for (const action of ['改名', '移动', '复制', '删除'])
      await expect(page.getByRole('button', { name: action, exact: true })).toBeVisible()

    await page.unroute(isDetail)
    await problem.getByRole('button', { name: '重试', exact: true }).press('Enter')
    await expect(problem).toHaveCount(0)
    await expect(page.getByRole('button', { name: '取消', exact: true })).toBeFocused()
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

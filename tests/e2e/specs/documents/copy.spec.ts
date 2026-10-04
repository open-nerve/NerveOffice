// 复制文档（M2-P4，US-M2-08）：副本与源逐字节一致（A10），之后两份各自编辑、互不影响。
// 只凭单独授权的人（不在源空间里）同样能复制、编辑者能改名（Codex 对抗评审 CX3）：入口在"与我共享"每一条的"操作"里，
// 与空间的文档列表同一个行内操作；复制的目标是自己能新建的空间，看不到源空间的目录结构；副本不带上源的授权。
// 目标空间的子文件夹第一次就没取到时用键盘按"重试"：进行中按钮不卸载，取到之后焦点交给"目标位置"这一行（规范 §2.4，DEF-046）。
import { createDocument, createDocumentIn, createFolderIn, createTeamSpace, createUser, grantDocument, grantsOn, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, saveAndWait, savedContent, typeInCell, waitForEditor } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M2-08 复制文档', () => {
  test('复制出的副本内容与源一致；之后两份各自编辑保存，互不影响', async ({ page }) => {
    const owner = await createUser('copy-owner')
    await loginThroughApi(page, owner)
    const sourceId = await createSheetThroughApi(page, '报价单')
    await openAndEnterEditing(page, sourceId)
    await typeInCell(page, 'A1', '共同的内容')
    await saveAndWait(page)

    // 在列表页复制：默认标题是"源标题 的副本"，说明里给出打开副本的链接
    await page.goto('/')
    await page.getByRole('button', { name: '操作 报价单', exact: true }).click()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await page.getByRole('form', { name: '复制' }).getByRole('button', { name: '复制到这里', exact: true }).click()
    await expect(page.getByText('已复制出「报价单 的副本」')).toBeVisible()
    const openCopy = page.getByRole('link', { name: '打开副本', exact: true })
    const copyId = (await openCopy.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    expect(copyId).not.toBe(sourceId)

    // 副本打开就带着源的内容（快照原样复制，不重新解析）。打开即阅读（M3-P2）：等只读的编辑器就绪再往下，之后重新打开、进入编辑
    await openCopy.click()
    await expect(page).toHaveURL(`/documents/${copyId}`)
    await expect(page.getByRole('link', { name: '我的空间', exact: true })).toBeVisible()
    await waitForEditor(page)
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('共同的内容')

    // 在副本里改一处并保存：源不受影响
    await openAndEnterEditing(page, copyId)
    await typeInCell(page, 'B1', '只在副本里')
    await saveAndWait(page)
    const source = await savedContent(page, sourceId)
    expect(cellOf(source.snapshot, 'A1')?.v).toBe('共同的内容')
    expect(cellOf(source.snapshot, 'B1')?.v).toBeUndefined()

    // 再在源里改一处并保存：副本不受影响
    await openAndEnterEditing(page, sourceId)
    await typeInCell(page, 'C1', '只在源里')
    await saveAndWait(page)
    const copy = await savedContent(page, copyId)
    expect(cellOf(copy.snapshot, 'B1')?.v).toBe('只在副本里')
    expect(cellOf(copy.snapshot, 'C1')?.v).toBeUndefined()
  })

  test('复制的结果未知（其实已经复制）→ 收起面板，过一会儿再复制到同一处：说明上一次其实已经完成、没有多出一份；再复制一次才是第二份（M2-P6 复核第二批 S-1）', async ({ page }) => {
    const owner = await createUser('copy-replayed')
    await createDocument(owner, '模板')
    await loginThroughApi(page, owner)
    await page.goto('/')
    let first = true
    await page.route('**/api/documents/*/copy', async (route) => {
      if (!first)
        return route.continue()
      first = false
      // 服务端照常复制，回包换成代理的 502：结果未知
      await route.fetch()
      return route.fulfill({ status: 502, contentType: 'text/html', body: 'bad gateway' })
    })
    const copyOnce = async (): Promise<void> => {
      await page.getByRole('button', { name: '操作 模板', exact: true }).click()
      await page.getByRole('button', { name: '复制', exact: true }).click()
      await page.getByRole('form', { name: '复制' }).getByRole('button', { name: '复制到这里', exact: true }).click()
    }
    const copies = async (): Promise<number> => withDatabase(async client => Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM documents WHERE space_id = $1 AND title = $2 AND status = \'active\'', [owner.personalSpaceId, '模板 的副本'])).rows[0]?.n))
    await copyOnce()
    await expect(page.getByText(/^没能确认是否已经复制/)).toBeVisible()
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('模板 的副本')
    // 看到副本已经在了，收起面板；过一会儿想再要一份
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await copyOnce()
    await expect(page.getByText('上一次复制其实已经完成（当时没能确认结果），这次没有再复制一份：副本就是「模板 的副本」。还要再复制一份时，再复制一次。')).toBeVisible()
    await expect(page.getByText('已复制出「模板 的副本」')).toHaveCount(0)
    expect(await copies()).toBe(1)

    // 这件事了结了：再复制一次是第二份
    await copyOnce()
    await expect(page.getByText('已复制出「模板 的副本」')).toBeVisible()
    expect(await copies()).toBe(2)
  })

  test('复制到另一个空间里的文件夹：副本在那个空间的那个文件夹里，源所在的空间没有多出副本（M2-P6 复核 M3）', async ({ page }) => {
    const owner = await createUser('copy-across')
    const team = await createTeamSpace('乙组', owner, [[owner, 'editor']])
    const inbox = await createFolderIn(team.id, owner, '收件')
    await createDocument(owner, '报价单')
    await loginThroughApi(page, owner)
    await page.goto('/')
    await page.getByRole('button', { name: '操作 报价单', exact: true }).click()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    const form = page.getByRole('form', { name: '复制' })
    await form.getByLabel('目标空间', { exact: true }).selectOption({ label: team.name })
    await form.getByRole('button', { name: '进入 收件', exact: true }).click()
    await expect(form.getByText(`目标位置：${team.name} / 收件`)).toBeVisible()
    await form.getByRole('button', { name: '复制到这里', exact: true }).click()
    await expect(page.getByText('已复制出「报价单 的副本」')).toBeVisible()

    // 源还在原处，我的空间里没有多出副本
    const mine = page.getByRole('list', { name: '文档列表' })
    await expect(mine).toContainText('报价单')
    await expect(mine.getByText('报价单 的副本')).toHaveCount(0)
    // 副本在乙组的"收件"里，不在乙组的根目录
    await page.goto(`/spaces/${team.id}/folders/${inbox}`)
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('报价单 的副本')
    await page.goto(`/spaces/${team.id}`)
    await expect(page.getByRole('list', { name: '文件夹列表' }).getByRole('link', { name: '收件', exact: true })).toBeVisible()
    await expect(page.getByText('报价单 的副本')).toHaveCount(0)
  })

  test('复制到另一个空间、它的子文件夹第一次就没取到之后用键盘按"重试"：重试期间说明与同一个按钮留着（不可用、说正在重试），焦点还在按钮上；取到之后焦点交给"目标位置"这一行，不落到 body（规范 §2.4，DEF-046）', async ({ page }) => {
    const owner = await createUser('copy-target-retry')
    const team = await createTeamSpace('丙组', owner, [[owner, 'editor']])
    await createFolderIn(team.id, owner, '收件')
    await createDocument(owner, '报价单')
    await loginThroughApi(page, owner)
    await page.goto('/')
    // 只拦丙组根目录下的子文件夹（首页取的是我的空间的，照常）：服务暂时不可用，查询自动重试一次之后才算失败
    const targetFolders = `/api/folders?${new URLSearchParams({ spaceId: team.id }).toString()}`
    const isTargetFolders = (url: URL): boolean => `${url.pathname}${url.search}` === targetFolders
    await page.route(isTargetFolders, async route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用', requestId: 'e2e' } }),
    }))
    await page.getByRole('button', { name: '操作 报价单', exact: true }).click()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    const form = page.getByRole('form', { name: '复制' })
    await form.getByLabel('目标空间', { exact: true }).selectOption({ label: team.name })
    const problem = form.getByRole('alert').filter({ hasText: '目标位置加载失败' })
    await expect(problem).toContainText('服务暂时不可用，请稍后重试')
    // 说明里只有这一个按钮：按名称找的话，它改说"正在重试…"之后就找不到了
    const retry = problem.getByRole('button')
    await expect(retry).toHaveText('重试')

    // 恢复之前先挂住重试的那一次请求，看进行中的样子；放开之后照常发给后端
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.unroute(isTargetFolders)
    await page.route(isTargetFolders, async (route) => {
      await released
      await route.continue()
    })
    await retry.focus()
    await page.keyboard.press('Enter')
    await expect(retry).toHaveText('正在重试…')
    await expect(retry).toHaveAttribute('aria-disabled', 'true')
    await expect(retry).toHaveAttribute('aria-busy', 'true')
    await expect(retry).toBeFocused()
    await expect(form.getByRole('status', { name: '正在加载目标位置…' })).toHaveCount(0)

    release()
    await expect(form.getByRole('button', { name: '进入 收件', exact: true })).toBeVisible()
    await expect(problem).toHaveCount(0)
    await expect(form.getByText(`目标位置：${team.name}`)).toBeFocused()
  })
})

/** 文档现在的标题（直接查库）：核对经界面的改名确实写进了库 */
async function titleOf(documentId: string): Promise<string | undefined> {
  return withDatabase(async client => (await client.query<{ title: string }>('SELECT title FROM documents WHERE id = $1', [documentId])).rows[0]?.title)
}

test.describe('US-M2-08 只凭单独授权在"与我共享"里复制与改名（Codex 对抗评审 CX3）', () => {
  test('US-M2-08 只凭授权的查看者在"与我共享"里复制到自己的个人空间：副本在个人空间、内容一致，两份各自保存互不影响；副本没有带上授权', async ({ page, anotherDevice }) => {
    const admin = await createUser('cp-grant-admin', '系统管理员', { systemRole: 'admin' })
    const lead = await createUser('cp-grant-lead', '空间管理员')
    const reader = await createUser('cp-grant-reader', '读者')
    const space = await createTeamSpace('复制来源部', admin, [[lead, 'admin']])
    const folderId = await createFolderIn(space.id, lead, '机密目录')
    const sourceId = await createDocumentIn(space.id, lead, '部门的报价单', { folderId })
    await grantDocument(sourceId, reader, 'viewer', lead)

    // 源里先写一份内容（空间管理员在编辑器里保存）
    await loginThroughApi(anotherDevice, lead)
    await openAndEnterEditing(anotherDevice, sourceId)
    await typeInCell(anotherDevice, 'A1', '共同的内容')
    await saveAndWait(anotherDevice)

    // 查看者只凭授权（不在源空间里）：在"与我共享"里展开这一条的"操作"——只有复制
    await loginThroughApi(page, reader)
    await page.goto('/shared')
    const item = page.getByRole('list', { name: '分享给我的文档' }).getByRole('listitem').filter({ hasText: '部门的报价单' })
    await item.getByRole('button', { name: '操作 部门的报价单', exact: true }).click()
    await expect(item.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    await expect(item.getByRole('button', { name: /^(?:改名|移动|删除|分享)$/ })).toHaveCount(0)
    await item.getByRole('button', { name: '复制', exact: true }).click()
    // 目标是自己能新建的空间（这里只有我的空间）：源空间不在候选里，它的目录结构也不出现
    const form = page.getByRole('form', { name: '复制' })
    await expect(form.getByText('目标位置：我的空间')).toBeVisible()
    await expect(form.getByText('这里没有子文件夹')).toBeVisible()
    await expect(page.getByText('机密目录')).toHaveCount(0)
    await expect(form.getByText(space.name)).toHaveCount(0)
    await form.getByRole('button', { name: '复制到这里', exact: true }).click()
    await expect(page.getByText('已复制出「部门的报价单 的副本」')).toBeVisible()
    const openCopy = page.getByRole('link', { name: '打开副本', exact: true })
    const copyId = (await openCopy.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    expect(copyId).not.toBe(sourceId)

    // 副本在我的空间里；副本没有带上授权，源的授权照旧
    await page.goto('/')
    await expect(page.getByRole('list', { name: '文档列表' }).getByRole('link', { name: /部门的报价单 的副本/ })).toBeVisible()
    expect(await grantsOn(copyId)).toEqual({})
    expect(await grantsOn(sourceId)).toEqual({ [reader.username]: 'viewer' })

    // 打开副本：内容与源一致；在副本里改一处并保存，源不受影响
    await openAndEnterEditing(page, copyId)
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('共同的内容')
    await typeInCell(page, 'B1', '只在副本里')
    await saveAndWait(page)
    const source = await savedContent(anotherDevice, sourceId)
    expect(cellOf(source.snapshot, 'A1')?.v).toBe('共同的内容')
    expect(cellOf(source.snapshot, 'B1')?.v).toBeUndefined()

    // 源里再改一处并保存：副本不受影响
    await openAndEnterEditing(anotherDevice, sourceId)
    await typeInCell(anotherDevice, 'C1', '只在源里')
    await saveAndWait(anotherDevice)
    const copy = await savedContent(page, copyId)
    expect(cellOf(copy.snapshot, 'B1')?.v).toBe('只在副本里')
    expect(cellOf(copy.snapshot, 'C1')?.v).toBeUndefined()
  })

  test('US-M2-08 只凭授权的编辑者在"与我共享"里改名：写进了库，这一页随即是新的标题，焦点回到这一条的"操作"', async ({ page }) => {
    const owner = await createUser('cp-rename-owner', '所有者')
    const writer = await createUser('cp-rename-writer', '写手')
    const documentId = await createDocument(owner, '要改名的表')
    await grantDocument(documentId, writer, 'editor', owner)

    await loginThroughApi(page, writer)
    await page.goto('/shared')
    await page.getByRole('button', { name: '操作 要改名的表', exact: true }).click()
    await expect(page.getByRole('button', { name: /^(?:移动|删除|分享)$/ })).toHaveCount(0)
    await page.getByRole('button', { name: '改名', exact: true }).click()
    await page.getByLabel('要改名的表 的新名称', { exact: true }).fill('改好名的表')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '操作 改好名的表', exact: true })).toBeFocused()
    await expect(page.getByRole('list', { name: '分享给我的文档' }).getByRole('link', { name: /改好名的表/ })).toBeVisible()
    expect(await titleOf(documentId)).toBe('改好名的表')
  })

  test('US-M2-08 只凭授权的查看者在"与我共享"里没有改名（只有复制）', async ({ page }) => {
    const owner = await createUser('cp-norename-owner', '所有者')
    const reader = await createUser('cp-norename-reader', '读者')
    const documentId = await createDocument(owner, '只能看的表')
    await grantDocument(documentId, reader, 'viewer', owner)

    await loginThroughApi(page, reader)
    await page.goto('/shared')
    await page.getByRole('button', { name: '操作 只能看的表', exact: true }).click()
    // 前提：面板里的操作已经按权限取到
    await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '改名', exact: true })).toHaveCount(0)
    expect(await titleOf(documentId)).toBe('只能看的表')
  })
})

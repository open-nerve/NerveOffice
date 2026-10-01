// 复制文档（M2-P4，US-M2-08）：副本与源逐字节一致（A10），之后两份各自编辑、互不影响。
import { createDocument, createFolderIn, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, openEditor, saveAndWait, savedContent, typeInCell } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test.describe('US-M2-08 复制文档', () => {
  test('复制出的副本内容与源一致；之后两份各自编辑保存，互不影响', async ({ page }) => {
    const owner = await createUser('copy-owner')
    await loginThroughApi(page, owner)
    const sourceId = await createSheetThroughApi(page, '报价单')
    await openEditor(page, sourceId)
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

    // 副本打开就带着源的内容（快照原样复制，不重新解析）
    await openCopy.click()
    await expect(page).toHaveURL(`/documents/${copyId}`)
    await expect(page.getByRole('link', { name: '我的空间', exact: true })).toBeVisible()
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('共同的内容')

    // 在副本里改一处并保存：源不受影响
    await openEditor(page, copyId)
    await typeInCell(page, 'B1', '只在副本里')
    await saveAndWait(page)
    const source = await savedContent(page, sourceId)
    expect(cellOf(source.snapshot, 'A1')?.v).toBe('共同的内容')
    expect(cellOf(source.snapshot, 'B1')?.v).toBeUndefined()

    // 再在源里改一处并保存：副本不受影响
    await openEditor(page, sourceId)
    await typeInCell(page, 'C1', '只在源里')
    await saveAndWait(page)
    const copy = await savedContent(page, copyId)
    expect(cellOf(copy.snapshot, 'B1')?.v).toBe('只在副本里')
    expect(cellOf(copy.snapshot, 'C1')?.v).toBeUndefined()
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
})

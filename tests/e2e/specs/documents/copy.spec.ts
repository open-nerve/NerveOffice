// 复制文档（M2-P4，US-M2-08）：副本与源逐字节一致（A10），之后两份各自编辑、互不影响。
import { createUser } from '../../support/database.ts'
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
})

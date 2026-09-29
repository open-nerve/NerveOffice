// 回收站（M2-P4，US-M2-09）：删一个文件夹连同里面的文档进同一个删除单元；原位置不在时恢复回空间的根目录并说明；
// 看得到空间内容的人都看得到这个列表，但只有删除者与空间管理员能动它。
import type { Page } from '@playwright/test'
import { createDocumentIn, createFolderIn, createTeamSpace, createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'

async function openActions(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `操作 ${name}`, exact: true }).click()
}

/** 在当前位置删掉一个对象（行内操作，删除是可恢复的，所以不另外确认） */
async function deleteItem(page: Page, name: string): Promise<void> {
  await openActions(page, name)
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText(`已把「${name}」移到回收站`)).toBeVisible()
}

function trashRow(page: Page, title: string) {
  return page.getByRole('table', { name: '回收站列表' }).getByRole('row').filter({ hasText: title })
}

test.describe('US-M2-09 回收站', () => {
  test('删文件夹连同里面的文档进同一个删除单元；原位置已经不在的对象恢复到空间的根目录并说明', async ({ page }) => {
    const owner = await createUser('trash-owner')
    const folderId = await createFolderIn(owner.personalSpaceId, owner, '归档')
    await createDocumentIn(owner.personalSpaceId, owner, '明细', { folderId })
    await loginThroughApi(page, owner)

    // 先单独删掉文件夹里的文档：它自己是一个删除单元，不会被随后的文件夹删除重组
    await page.goto(`/spaces/${owner.personalSpaceId}/folders/${folderId}`)
    await deleteItem(page, '明细')
    // 再删掉文件夹本身：它的原位置是空间的根目录，里面（正常状态的）文档已经没有了
    await page.goto(`/spaces/${owner.personalSpaceId}`)
    await deleteItem(page, '归档')

    await page.getByRole('link', { name: '打开回收站', exact: true }).click()
    const folderEntry = trashRow(page, '归档')
    await expect(folderEntry).toContainText('文件夹')
    await expect(folderEntry).toContainText('空间的根目录')
    await expect(folderEntry).toContainText(owner.displayName)
    const documentEntry = trashRow(page, '明细')
    await expect(documentEntry).toContainText('文档')
    await expect(documentEntry).toContainText('1 份文档')
    // 原来的父文件夹自己也在回收站里：恢复会回到空间的根目录
    await expect(documentEntry).toContainText('原位置已不存在')

    await documentEntry.getByRole('button', { name: '恢复 明细', exact: true }).click()
    await expect(page.getByText('「明细」原来的位置已经不在了，已恢复到空间的根目录')).toBeVisible()
    await page.getByRole('link', { name: '返回空间', exact: true }).click()
    await expect(page.getByRole('list', { name: '文档列表' })).toContainText('明细')
  })

  test('查看者看得到回收站的列表，却没有恢复与永久删除；空间管理员永久删除要先确认', async ({ page, anotherDevice }) => {
    const lead = await createUser('trash-lead')
    const reader = await createUser('trash-reader')
    const space = await createTeamSpace('项目组', lead, [[lead, 'admin'], [reader, 'viewer']])
    await createDocumentIn(space.id, lead, '旧方案')

    await loginThroughApi(page, lead)
    await page.goto(`/spaces/${space.id}`)
    await deleteItem(page, '旧方案')

    // 查看者：标题在删除之前他本来就看得到，所以列表看得到；能不能动由服务端给的权限决定
    await loginThroughApi(anotherDevice, reader)
    await anotherDevice.goto(`/spaces/${space.id}/trash`)
    await expect(trashRow(anotherDevice, '旧方案')).toHaveCount(1)
    await expect(anotherDevice.getByRole('button', { name: '恢复 旧方案', exact: true })).toHaveCount(0)
    await expect(anotherDevice.getByRole('button', { name: '永久删除 旧方案', exact: true })).toHaveCount(0)

    await page.getByRole('link', { name: '打开回收站', exact: true }).click()
    await page.getByRole('button', { name: '永久删除 旧方案', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('永久删除之后内容就找不回来了')
    await dialog.getByRole('button', { name: '永久删除', exact: true }).click()
    await expect(page.getByText('已永久删除「旧方案」')).toBeVisible()
    await expect(page.getByText('回收站里没有内容')).toBeVisible()
  })
})

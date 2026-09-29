// 重新生成只读用例的样本（M2-P3 设计 §4，P3 审查 B13）：只读用例"打开不产生改动"逐字节比较样本，其他用例在切换工作表之后
// 按内容比较，所以样本必须是收敛的——按生产档案打开、把每张表都画一遍之后保存，字节不变。
// SDK 升级或插件档案变更之后样本可能不再收敛（上面那些用例会失败），执行一次（与 E2E 用同一套服务：先 pnpm db:up、构建后端与
// web 的测试构建，同 pnpm test:e2e）：pnpm --filter @nerve-office/e2e run update:read-only-sample
// 做法与模板的更新（update-sheet-template.spec.ts）相同，只经产品本身：把现在的样本写成作者的一份文档，打开到 steady，
// 逐张切到每张看得见的工作表、等它画出来（SDK 画单元格图片时按单元格的大小改写模型里的尺寸，不经 mutation），保存；
// 重开再做一遍，直到连续两次保存的快照逐字节相同（收敛），把结果（文档的 unitId 换回占位符）写回 support/read-only-sample.json，
// 再用 ESLint 整理写法。随后跑 specs/editor/read-only.spec.ts 回归。
// 样本最初由 M0 的综合样本派生，派生时的几处改动见 support/read-only-sample.ts 的开头，这里不重做
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocument, createUser } from '../support/database.ts'
import { expect, test } from '../support/fixtures.ts'
import { readOnlySampleFor, SAMPLE_SHEETS, SAMPLE_UNIT_PLACEHOLDER } from '../support/read-only-sample.ts'
import { loginThroughApi } from '../support/session.ts'
import { openEditor, saveAndWait, savedContent, sheetTab } from '../support/sheet.ts'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const SAMPLE_FILE = resolve(import.meta.dirname, '../support/read-only-sample.json')
/** 收敛通常只要一两轮；多给几轮余量 */
const MAX_ROUNDS = 5

/** 看得见的工作表（隐藏的那张切不过去），最后回到打开时的那张 */
const VISIBLE_SHEETS = [SAMPLE_SHEETS.summary, SAMPLE_SHEETS.features, SAMPLE_SHEETS.filter, SAMPLE_SHEETS.data]

/** 等两个动画帧：切过去的工作表这时已经画过一遍 */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(async () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/** 打开、把每张看得见的工作表画一遍、保存；返回服务器上保存的快照 */
async function openDrawAndSave(page: Page, documentId: string): Promise<string> {
  await openEditor(page, documentId, 'steady')
  for (const sheet of VISIBLE_SHEETS) {
    await sheetTab(page, sheet.name).click()
    await expect(sheetTab(page, sheet.name)).toHaveAttribute('aria-selected', 'true')
    await nextFrames(page)
  }
  await saveAndWait(page)
  return (await savedContent(page, documentId)).text
}

/** 打开、保存，直到连续两次保存的快照相同；返回收敛的快照，MAX_ROUNDS 轮之内没有收敛时为 undefined */
async function saveUntilStable(page: Page, documentId: string): Promise<string | undefined> {
  let previous = (await savedContent(page, documentId)).text
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const saved = await openDrawAndSave(page, documentId)
    if (saved === previous)
      return saved
    previous = saved
  }
  return undefined
}

test('更新只读用例的样本', async ({ page }) => {
  test.setTimeout(MAX_ROUNDS * 60_000)
  const author = await createUser('ro-sample-update', '作者')
  await loginThroughApi(page, author)
  const documentId = await createDocument(author, '只读样本', readOnlySampleFor)
  const converged = await saveUntilStable(page, documentId)
  expect(converged, `${MAX_ROUNDS} 轮之内没有收敛`).toBeDefined()
  const snapshot = JSON.parse(converged ?? '{}') as { id: string }
  // 样本里凡是文档 unitId 的地方都写成占位符（写库时换上文档自己的，read-only-sample.ts 的 readOnlySampleFor）
  const text = JSON.stringify(snapshot, null, 2).replaceAll(snapshot.id, SAMPLE_UNIT_PLACEHOLDER)
  writeFileSync(SAMPLE_FILE, `${text}\n`)
  execFileSync('pnpm', ['exec', 'eslint', '--fix', SAMPLE_FILE], { cwd: REPO_ROOT, stdio: 'inherit' })
})

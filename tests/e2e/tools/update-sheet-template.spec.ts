// 更新表格的模板快照（P4 设计 §3.4）：只经产品本身，不另写测试钩子。
// 用 E2E 的服务新建一份文档，在编辑器页里打开到 steady、保存，看本页上传的快照：与打开的逐字节相同就是收敛。
// 看上传的正文、不看服务器上的（M3-P3 设计 §3.11）：内容相同（规范化之后）的保存服务端不存这次的字节，服务器上的字节不变不说明收敛。
// 不同时把上传的写成新的一份文档（直接写库）再打开、保存，直到相同；把结果（id 换回占位值）写回 contracts 的 sheet-template.ts，
// 再用 ESLint 整理写法。E2E 的"模板收敛"用例随后回归。
import type { Page } from '@playwright/test'
import type { TestUser } from '../support/database.ts'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SHEET_TEMPLATE_UNIT_ID } from '@nerve-office/contracts'
import { createDocument, createUser } from '../support/database.ts'
import { expect, test } from '../support/fixtures.ts'
import { loginThroughApi } from '../support/session.ts'
import { createSheetThroughApi, openAndEnterEditing, saveAndCapture, savedContent } from '../support/sheet.ts'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const TEMPLATE_FILE = resolve(REPO_ROOT, 'packages/contracts/src/documents/sheet-template.ts')
/** 手写的快照第二次保存才稳定（M0-P2 报告 §2.2）；多给几轮余量 */
const MAX_ROUNDS = 5

/** sheet-template.ts 的全文：对象字面量按 JSON 写出（ESLint 之后改成项目的写法），顶层的 id 用占位常量 */
function renderModule(template: Record<string, unknown>): string {
  const body = JSON.stringify({ ...template, id: '__UNIT_ID__' }, null, 2).replace('"__UNIT_ID__"', 'SHEET_TEMPLATE_UNIT_ID')
  return `// 新建表格用的模板快照（P4 设计 §3.4）：按生产档案"打开 → 保存"收敛之后的空白工作簿，新建时换上文档自己的 unitId。
// 由更新脚本生成，不要手改：SDK 升级或插件档案变更时重新生成（pnpm --filter @nerve-office/e2e run update:sheet-template），
// E2E 回归"新建的文档打开后立即保存，快照与模板逐字节相同（id 除外）"。

/** 模板里的占位 unitId：实例化时换成文档自己的。 */
export const SHEET_TEMPLATE_UNIT_ID = '${SHEET_TEMPLATE_UNIT_ID}'

/** 收敛的空白工作簿（Univer 的 IWorkbookData）。键的顺序就是 SDK 保存时的顺序，序列化的结果与 SDK 保存的字节相同。 */
export const SHEET_TEMPLATE = ${body} as const

/** 一份新表格的快照 JSON：模板换上文档的 unitId。模板本身就是 JSON.stringify 的输出，只有 id 不同（单元测试核对）。 */
export function sheetSnapshotFor(unitId: string): string {
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId })
}
`
}

/** 快照换上另一个 unitId：只有顶层的 id 是它（与模板的 sheetSnapshotFor 相同）；展开再覆盖已有的键，键的位置不变 */
function withUnitId(text: string, unitId: string): string {
  return JSON.stringify({ ...JSON.parse(text) as Record<string, unknown>, id: unitId })
}

/** 打开到 steady、保存，返回本页上传的快照 */
async function openAndUpload(page: Page, documentId: string): Promise<string> {
  await openAndEnterEditing(page, documentId, 'steady')
  return (await saveAndCapture(page)).uploaded
}

/** 从新建的文档出发，打开、保存，直到上传的与打开的逐字节相同；返回收敛的快照，MAX_ROUNDS 轮之内没有收敛时为 undefined */
async function saveUntilStable(page: Page, author: TestUser): Promise<string | undefined> {
  let documentId = await createSheetThroughApi(page)
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const opened = (await savedContent(page, documentId)).text
    const uploaded = await openAndUpload(page, documentId)
    if (uploaded === opened)
      return uploaded
    // 下一轮打开上传的这一份：直接写成新的文档（它与打开的内容相同时服务端不存这次的字节）
    documentId = await createDocument(author, '模板', unitId => withUnitId(uploaded, unitId))
  }
  return undefined
}

test('更新表格的模板快照', async ({ page }) => {
  test.setTimeout(MAX_ROUNDS * 60_000)
  const author = await createUser('template-update')
  await loginThroughApi(page, author)
  const converged = await saveUntilStable(page, author)
  expect(converged, `${MAX_ROUNDS} 轮之内没有收敛`).toBeDefined()
  writeFileSync(TEMPLATE_FILE, renderModule(JSON.parse(converged ?? '{}') as Record<string, unknown>))
  execFileSync('pnpm', ['exec', 'eslint', '--fix', TEMPLATE_FILE], { cwd: REPO_ROOT, stdio: 'inherit' })
})

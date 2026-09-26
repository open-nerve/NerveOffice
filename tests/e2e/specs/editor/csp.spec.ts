// 编辑器在定稿的 CSP 下工作（US-M1-09 的编辑器部分，P4 设计 §3.10）：编辑器页、编辑器脚本与公式 Worker 都带策略；
// 键入值与公式、加粗、打开菜单都没有违规（夹具在每个用例结束时断言）；公式由 Worker 算出；外链的 IMAGE() 不发请求、显示 #VALUE!。
import { createUser } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, openEditor, saveAndWait, savedContent, selectCell, typeInCell } from '../../support/sheet.ts'

/** M0 定稿的策略（00 号计划书 §11.3），与 security/csp.spec.ts 相同 */
const CONTENT_SECURITY_POLICY = 'default-src \'self\'; img-src \'self\' data: blob:; connect-src \'self\'; font-src \'self\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\'; worker-src \'self\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\''

test.describe('US-M1-09 编辑器在定稿的 CSP 下工作', () => {
  test('编辑器页、编辑器脚本与公式 Worker 的响应都带定稿的 CSP', async ({ page }) => {
    await loginThroughApi(page, await createUser('editor-csp-headers'))
    const documentId = await createSheetThroughApi(page)
    const policies = new Map<string, string | undefined>()
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (/^\/documents\/|^\/assets\/(?:editor|formula\.worker)-[\w-]+\.js$/.test(path))
        policies.set(path, response.headers()['content-security-policy'])
    })
    await openEditor(page, documentId)
    const paths = [...policies.keys()]
    expect(paths.some(path => path.startsWith('/documents/'))).toBe(true)
    expect(paths.some(path => path.startsWith('/assets/editor-'))).toBe(true)
    expect(paths.some(path => path.startsWith('/assets/formula.worker-'))).toBe(true)
    for (const [path, policy] of policies)
      expect(policy, path).toBe(CONTENT_SECURITY_POLICY)
  })

  test('键入值与公式、加粗、打开菜单：没有违规，公式由 Worker 算出', async ({ page }) => {
    await loginThroughApi(page, await createUser('editor-csp-edit'))
    const documentId = await createSheetThroughApi(page)
    await openEditor(page, documentId, 'steady')
    await typeInCell(page, 'A1', '20')
    await typeInCell(page, 'A2', '=A1+22')
    await selectCell(page, 'A1')
    await page.getByRole('button', { name: '粗体' }).click()
    for (const tab of ['插入', '公式', '数据', '视图', '开始'])
      await page.getByRole('tab', { name: tab, exact: true }).click()
    await selectCell(page, 'C3', { button: 'right' })
    await page.keyboard.press('Escape')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A2')).toMatchObject({ f: '=A1+22', v: 42 })
  })

  test('外链的 IMAGE()：不发请求，显示 #VALUE!', async ({ page }) => {
    await loginThroughApi(page, await createUser('editor-csp-image'))
    const documentId = await createSheetThroughApi(page)
    const external: string[] = []
    page.on('request', (request) => {
      if (!request.url().startsWith('data:') && new URL(request.url()).origin !== e2eOrigin())
        external.push(request.url())
    })
    await openEditor(page, documentId, 'steady')
    await typeInCell(page, 'A1', '=IMAGE("https://example.com/picture.png")')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')).toMatchObject({ v: '#VALUE!' })
    expect(external).toEqual([])
  })
})

// 打开自检（M3-P4 设计 §3.11–§3.13，US-M3-15：文档数据不完整时不能编辑）。
// - 无误报（§3.17）：误报会让一份文档谁也编辑不了。新建的模板、只读样本（六项内容资源都非空，五张表、图片、批注、筛选、条件格式、数据验证、
//   定义名称）与大表，打开（阅读）与进入编辑时编辑器的打开自检都通过（经测试构建的探针读出），页头有"编辑"，没有上报。这是资源守卫的登记里
//   写的回归用例之一（internal-api/registry.ts 的 createResourceLoadGuard）：SDK 升级改了资源 hook 的注册时机、名字或加载路径时，这组先失败；
// - 数据没能完整载入（写库造损坏的资源，database.ts 绕过服务端的快照检查）：解析失败（筛选截成一半）、资源被清空（条件格式截成一半，插件吞掉错误）、
//   加载抛错（数据验证的规则表不是数组）、序列化抛错（"筛选"表的筛选不是对象：载入不报错、写不出来；放在不是打开时当前表的那张，
//   否则筛选的控制器在订阅里异步抛错）——只能阅读、页头说明、上报（请求体只有种类、资源名与异常的构造器名，没有内容），服务端收下；
// - ?edit=new 的"先取后放"：只能先取得编辑权、按它以可编辑新建，自检失败就释放（租约结束的原因是 released）、以只读重建，没有保存请求；
// - 档案不全（测试构建的故障开关 profileFault，不注册指定的插件组）：说明编辑器没有完整载入、请重新加载页面。
// 数据的几条不依赖测试构建（页面上看得到的与请求），容器 E2E 里照样跑；用到探针与故障开关的标 @test-build（外部模式按标签排除）
import type { Page, Request } from '@playwright/test'
import type { SnapshotFor } from '../../support/database.ts'
import { sheetSnapshotFor } from '@nerve-office/contracts'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createDocument, createUser, editLeaseEndReason, revisionOf } from '../../support/database.ts'
import { probeOpenCheck } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { largeSheetFor } from '../../support/large-sheet.ts'
import { readOnlySampleFor, SAMPLE_SHEETS } from '../../support/read-only-sample.ts'
import { loginThroughApi } from '../../support/session.ts'
import { EDITOR_TEST_TIMEOUT, enterEditButton, enterEditing, isSaveRequest, openReader, saveStatus, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const CF = 'SHEET_CONDITIONAL_FORMATTING_PLUGIN'
const DV = 'SHEET_DATA_VALIDATION_PLUGIN'
const FILTER = 'SHEET_FILTER_PLUGIN'
const NOTE = 'SHEET_NOTE_PLUGIN'

/** 快照里的资源（name、data） */
type Resources = { name: string, data: string }[]

/** 在 base 的快照上改资源 */
function withResources(base: SnapshotFor, edit: (resources: Resources) => void): SnapshotFor {
  return (unitId) => {
    const snapshot = JSON.parse(base(unitId)) as { resources: Resources }
    edit(snapshot.resources)
    return JSON.stringify(snapshot)
  }
}

function resourceNamed(resources: Resources, name: string): { name: string, data: string } {
  const entry = resources.find(item => item.name === name)
  if (entry === undefined)
    throw new Error(`样本里没有 ${name}`)
  return entry
}

/** 这项资源的 data 换成 data */
function setData(name: string, data: string): (resources: Resources) => void {
  return (resources) => {
    resourceNamed(resources, name).data = data
  }
}

/** 这项资源的 data 截成一半（非法的 JSON） */
function truncated(name: string): (resources: Resources) => void {
  return (resources) => {
    const entry = resourceNamed(resources, name)
    entry.data = entry.data.slice(0, Math.floor(entry.data.length / 2))
  }
}

/** 这个页面发出的打开自检的上报（POST /api/documents/{id}/open-check-failures） */
function recordReports(page: Page): Request[] {
  const reports: Request[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/open-check-failures'))
      reports.push(request)
  })
  return reports
}

/** 上报的请求体与服务端的回答 */
async function reportsOf(requests: readonly Request[]): Promise<{ readonly status: number | undefined, readonly body: unknown }[]> {
  return Promise.all(requests.map(async request => ({ status: (await request.response())?.status(), body: request.postDataJSON() as unknown })))
}

interface ExpectedFailure {
  readonly kind: string
  readonly resource: string
  readonly error?: string
}

/**
 * 期望的请求体：修订号、打开方式、起因、失败清单与页面的构建与格式，此外什么也没有（不带快照、资源的 data、异常的 message）。
 * 镜像里的页面的构建另附 +提交号（support/client-format.ts）
 */
function expectedReport(access: 'read' | 'edit', trigger: string, failures: readonly ExpectedFailure[], revision = 1): unknown {
  return {
    revision,
    access,
    trigger,
    failures,
    ...CURRENT_CLIENT,
    clientBuild: expect.stringMatching(new RegExp(`^${CURRENT_CLIENT.clientBuild.replaceAll('.', '\\.')}(?:\\+[\\w.-]+)?$`)),
  }
}

/** 页头下面打开自检失败的说明（提示条） */
function damagedNotice(page: Page) {
  return page.locator('#editor-chrome').getByRole('alert').filter({ hasText: /已阻止编辑|没有完整载入/ })
}

const DOCUMENTS: readonly (readonly [name: string, snapshotFor: SnapshotFor])[] = [
  ['新建的模板', sheetSnapshotFor],
  ['只读样本', readOnlySampleFor],
  ['大表', largeSheetFor],
]

test.describe('打开自检无误报：模板、只读样本与大表', { tag: '@test-build' }, () => {
  for (const [name, snapshotFor] of DOCUMENTS) {
    test(`US-M3-15 ${name}：打开（阅读）与进入编辑时，打开自检都通过；页头有"编辑"，没有上报`, async ({ page }) => {
      const owner = await createUser('open-check')
      const id = await createDocument(owner, `打开自检 ${name}`, snapshotFor)
      const reports = recordReports(page)
      await loginThroughApi(page, owner)
      await openReader(page, id)
      expect(await probeOpenCheck(page)).toEqual({ ok: true })
      await expect(enterEditButton(page)).toBeVisible()
      // 模式切换一律重建：可编辑的编辑器另做一次自检
      await enterEditing(page)
      expect(await probeOpenCheck(page)).toEqual({ ok: true })
      expect(reports).toEqual([])
    })
  }
})

/** "功能"表与"筛选"表（只读样本） */
const FEATURES = SAMPLE_SHEETS.features.id
const FILTER_SHEET = SAMPLE_SHEETS.filter.id

/** 条件格式截成一半：插件吞掉错误、装成空的 */
const CF_FAILURES: readonly ExpectedFailure[] = [{ kind: 'parse-swallowed', resource: CF }, { kind: 'resource-emptied', resource: CF }]

/** 筛选截成一半（非法的 JSON）：插件解析时抛错，加载之后是空的 */
const FILTER_TRUNCATED: readonly ExpectedFailure[] = [{ kind: 'parse-threw', resource: FILTER, error: 'SyntaxError' }, { kind: 'resource-emptied', resource: FILTER }]

const DAMAGED: readonly { readonly name: string, readonly snapshotFor: SnapshotFor, readonly part: string, readonly failures: readonly ExpectedFailure[] }[] = [
  {
    name: '解析失败（筛选的数据截成一半：插件解析时抛错）',
    snapshotFor: withResources(readOnlySampleFor, truncated(FILTER)),
    part: '筛选',
    failures: FILTER_TRUNCATED,
  },
  {
    name: '资源被清空（条件格式的数据截成一半：插件吞掉错误、装成空的）',
    snapshotFor: withResources(readOnlySampleFor, truncated(CF)),
    part: '条件格式',
    failures: CF_FAILURES,
  },
  {
    name: '加载抛错（数据验证的规则表不是数组）',
    snapshotFor: withResources(readOnlySampleFor, setData(DV, JSON.stringify({ [FEATURES]: { a: 1 } }))),
    part: '数据验证',
    failures: [{ kind: 'load-threw', resource: DV, error: 'TypeError' }, { kind: 'resource-emptied', resource: DV }],
  },
  {
    name: '序列化抛错（"筛选"表的筛选不是对象：载入不报错、写不出来，这样的文档之后每次保存都会失败）',
    snapshotFor: withResources(readOnlySampleFor, setData(FILTER, JSON.stringify({ [FILTER_SHEET]: 5 }))),
    part: '筛选',
    failures: [{ kind: 'serialize-threw', resource: FILTER, error: 'TypeError' }],
  },
]

test.describe('US-M3-15 文档数据不完整时不能编辑', () => {
  for (const { name, snapshotFor, part, failures } of DAMAGED) {
    test(`US-M3-15 ${name}：只能阅读——没有"编辑"，页头只能查看，说明已阻止编辑与没能载入的部分；上报一次（只读、打开、修订号 1、失败清单，没有内容），服务端收下`, async ({ page }) => {
      const owner = await createUser('oc-damaged')
      const id = await createDocument(owner, `数据不完整 ${part}`, snapshotFor)
      const reports = recordReports(page)
      await loginThroughApi(page, owner)
      await openReader(page, id, 'steady')
      await expect(saveStatus(page)).toHaveText('只能查看')
      await expect(enterEditButton(page)).toHaveCount(0)
      const notice = damagedNotice(page)
      await expect(notice).toContainText('文档数据不完整，已阻止编辑')
      await expect(notice).toContainText(`部分数据没能载入（${part}），继续编辑会让它们丢失。已通知管理员`)
      expect(await reportsOf(reports)).toEqual([{ status: 204, body: expectedReport('read', 'open', failures) }])
    })
  }

  // 样本用新建的模板（?edit=new 本来就是新建之后的跳转）带一份截断的筛选。不用只读样本：它在不是当前表的"功能"表上有数据验证，
  // SDK 渲染完成时给它排一个不取消的空闲回调（DEF-056），先取后放刚建好就销毁的那个可编辑的编辑器，回调到来时拿不到工作簿，
  // 成为一条没处理的拒绝（页面异常）——那是登记过的 SDK 缺陷，不是这条用例要核对的
  test('US-M3-15 ?edit=new（新建之后直接编辑）而内容没能完整载入：先取得编辑权、以可编辑新建，自检失败随即释放（租约结束的原因是 released）、以只读重建、只能阅读，地址里去掉 ?edit=new；没有保存请求；两个编辑器各上报一次（编辑、只读，起因都是进入编辑）', async ({ page }) => {
    const owner = await createUser('oc-edit-new')
    const id = await createDocument(owner, '先取后放', withResources(sheetSnapshotFor, setData(FILTER, '{"sheet-1":{"ref":{"startRow":0,"startColumn":0')))
    const reports = recordReports(page)
    const saves: Request[] = []
    page.on('request', (request) => {
      if (isSaveRequest(request))
        saves.push(request)
    })
    await loginThroughApi(page, owner)
    await page.goto(`/documents/${id}?edit=new`)
    await waitForEditorAccess(page, 'read', 'steady')
    await expect(damagedNotice(page)).toContainText('文档数据不完整，已阻止编辑')
    await expect(enterEditButton(page)).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/documents/${id}$`))
    await expect.poll(async () => editLeaseEndReason(id), { message: '取得的编辑权随即释放' }).toBe('released')
    expect(await reportsOf(reports)).toEqual([
      { status: 204, body: expectedReport('edit', 'enter', FILTER_TRUNCATED) },
      { status: 204, body: expectedReport('read', 'enter', FILTER_TRUNCATED) },
    ])
    expect(saves, '失败的编辑器绝不保存').toEqual([])
    expect(await revisionOf(id)).toBe(1)
  })

  test('US-M3-15 档案不全（测试构建的故障开关：批注的插件不注册）：只能阅读——说明编辑器没有完整载入、已阻止编辑、请重新加载页面；上报（缺了批注的 hook，样本里的批注随之不在了）；"重新加载"整页重新加载', { tag: '@test-build' }, async ({ page }) => {
    const owner = await createUser('oc-profile')
    const id = await createDocument(owner, '档案不全', readOnlySampleFor)
    const reports = recordReports(page)
    await loginThroughApi(page, owner)
    // 故障开关的参数名见 apps/web/src/editor/testing/profile-fault.ts 的 PROFILE_FAULT_PARAM（它引用档案、带着 Univer，这里不引用）
    await page.goto(`/documents/${id}?profileFault=note`)
    await waitForEditorAccess(page, 'read', 'steady')
    await expect(saveStatus(page)).toHaveText('只能查看')
    await expect(enterEditButton(page)).toHaveCount(0)
    const notice = damagedNotice(page)
    await expect(notice).toContainText('编辑器没有完整载入，已阻止编辑。请重新加载页面')
    expect(await reportsOf(reports)).toEqual([{ status: 204, body: expectedReport('read', 'open', [{ kind: 'profile-missing-hook', resource: NOTE }, { kind: 'resource-missing', resource: NOTE }]) }])
    await Promise.all([page.waitForEvent('load'), notice.getByRole('button', { name: '重新加载', exact: true }).click()])
    await waitForEditorAccess(page, 'read')
    await expect(damagedNotice(page)).toContainText('编辑器没有完整载入')
    await expect.poll(() => reports.length, { message: '重新加载的页面同样上报' }).toBe(2)
  })
})

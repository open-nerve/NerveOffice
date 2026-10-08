// 页面自检在 Playwright 的浏览器里（M3-P2 设计 §3.5，US-M2-11；M3-P4 设计 §3.15 的捕获时机复核）：真实 Safari 的复核用的是编辑器页里
// 编译进测试构建的自检（apps/web/src/editor/testing/selftest.ts 与 selftest-capture.ts，驱动脚本 tests/e2e/safari/selftest.ts 在本机按需运行，
// 不进 CI）。这里在三个浏览器里跑同样的自检、同样的入口页与结果的交回，核对每项检查都通过：
// - 自检本身是对的——它与 read-only.spec.ts 共用入口清单与预期，合成的事件与按角色找元素的办法、观察真实的自动保存（M3-P4 S7）与
//   按定义的公式核对在这里校准过，真实 Safari 上的不通过才说明 Safari 不同，而不是自检写错了；
// - 自检不会悄悄地坏掉：CI 每次都跑（驱动脚本只在本机按需运行）；
// - 真实 Safari 的复核报告与 Playwright 的 WebKit 对照时，用的就是这里的结果（附件 selftest-report）。
// 每一步一份文档；服务器上另核对（support/selftest-plan.ts 的 storedProblems）：只看不改的几步没有保存过，enter-exit 恰好保存了一次、
// 内容里有自检改的那一格；自动保存照常运行的几步至少保存了一次、存下的内容按定义核对；hidden-save 保存了两次（Playwright 的页面不会真的
// 隐藏：这里在第一次上传之后模拟可见性变成 hidden，与 reading-updates.spec.ts 同一个办法；真的隐藏由驱动脚本在真实 Safari 上另开标签页做到）。
// 自动保存（M3-P4 S7 审查 B1）：入口页在打开编辑器页之前写下"暂停定时的上传"（真实 Safari 里也是这样），自检开始时再暂停一次、
// 捕获时机的场景按自己的需要放开——结果不依赖打开时的状态。这里显式写明打开时暂停（与入口页一致，不靠夹具的默认值）；
// E2E_AUTOSAVE=running 时打开即照常（夹具在每个文档载入之前去掉入口页写的那一项），用来核对两种打开时的状态都通过
// 结果的交回与驱动脚本相同（整页跳到 next，结果在查询参数里）：next 是本机的地址（自检只把结果交给本机，M3-P2 复核 B7），
// 用被测站点自己的源加一个没有的路径，这里拦下那次导航、读出结果。
// 交接的复核（M3-P5 S8，设计 §3.14）照驱动脚本的编排（support/selftest-handover.ts，共用）：
// - takeover：A 存上第一格之后模拟它隐藏（真实 Safari 里是另开的 B 遮住它），同一个上下文里另开 B（直接打开编辑器页）；B 交回之后模拟 A 回到
//   前台。A 照常回应：先保存再交出（B answered，A handed-over）——真实 Safari 27 上实测也是这样（隐藏 8 秒的 A 没有被暂停）；另一对的 A 收不到
//   交接频道的消息（takeover-holder-deaf：编辑器页的挂接装上吞消息的频道，与 S6 的 E2E 的 deafenHandover 同一个办法），模拟被暂停、冻结的 A：
//   B 3 秒之后本人接管并抢锁（silent），A 失去编辑权、另存为副本（lost）。两条都按库里的时间线与后端日志核对租约的变化；
// - refresh-save：先让这份文档的保存在服务端停 10 秒（support/selftest-handover.ts 的 slowDownSave：改写内容行时 pg_sleep）再打开，页面自己刷新、
//   接手。location.reload 时三个浏览器都先取消在途的请求、再派发 pagehide（结果未知；S6 用 Playwright 的 page.reload 时 Chromium 系 pagehide 时
//   还在途）——两种都不释放、留下记号（7a759da），页面交回的时间线里看得出是哪一种
// 请求编辑的两条路（M3-P6 设计 §3.10，DEF-062）照驱动脚本的编排（support/selftest-request.ts，共用）：作者在浏览器里，协作者经接口扮演另一方——
// - request-waiter（路 1）：协作者编辑、心跳带来请求之后这里模拟请求方隐藏、协作者交出；请求方在"后台"停在交给了我、不申请，模拟回到前台之后才进入；
// - paused-holder（路 2）：作者编辑、存上第一格之后这里模拟隐藏、拦住它的心跳与交出（Playwright 模拟不了 Safari 的暂停：页面照常跑，只是服务端
//   听不到它）；协作者请求、续期，持有者那一代按时间到期（真等一个有效期）之后接手；放开、模拟回到前台之后持有者得知失去编辑权、另存为副本
// 用到测试构建（自检的入口页与编辑器页里的自检）：标签 @test-build，外部模式测生产镜像时排除
import type { Page, Route } from '@playwright/test'
import type { SelftestReport } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import type { TestUser } from '../../support/database.ts'
import type { Judgement } from '../../support/selftest-handover.ts'
import type { SelftestStep, SelftestStepDefinition } from '../../support/selftest-plan.ts'
import type { RequestRun, RequestStage } from '../../support/selftest-request.ts'
import process from 'node:process'
import { decodeSelftestReport, HANDOVER_SCENARIOS, REQUEST_SCENARIOS, RESULT_PARAM } from '../../../../apps/web/src/editor/testing/selftest-report.ts'
import { revisionOf } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { REFRESH_SLOW_SAVE_SECONDS, refreshJudgement, serverRequestsOf, slowDownSave, takeoverJudgement, watchDocument } from '../../support/selftest-handover.ts'
import { problemsOf, SELFTEST_STEPS, selftestPageUrl, selftestScene, serverProblemsOf } from '../../support/selftest-plan.ts'
import { runPausedHolder, runWaiter } from '../../support/selftest-request.ts'
import { EDITOR_TEST_TIMEOUT } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

// 打开编辑器页时暂停定时的自动保存（与入口页写的相同）；E2E_AUTOSAVE=running 时照常，核对自检不依赖打开时的状态（见文件开头）
test.use({ autosave: process.env.E2E_AUTOSAVE === 'running' ? 'running' : 'held' })

/** 结果交回的地址：本机的源（被测站点自己的源）加一个没有的路径，导航由这里拦下、不会发到后端 */
function collector(): string {
  return `${e2eOrigin()}/selftest-collector`
}

/** 自检要等编辑器到 steady（渲染完成后 3 秒）再逐项检查，场景的总时限 180 秒：给足时限，失败时看附件里的页面 */
const REPORT_TIMEOUT_MS = 200_000

/** 打开入口页，交回的结果由这里拦下：返回已经交回的地址（解开用 reportOf） */
async function startSelftest(page: Page, step: SelftestStep): Promise<string[]> {
  const delivered: string[] = []
  await page.route(`${collector()}/**`, async (route) => {
    delivered.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '自检的结果已收到' })
  })
  await page.goto(selftestPageUrl(e2eOrigin(), step, `${collector()}/report?step=${step.id}`))
  return delivered
}

/** 等结果交回，解开 */
async function reportOf(delivered: readonly string[]): Promise<SelftestReport> {
  await expect.poll(() => delivered.length, { message: '等自检把结果交回', timeout: REPORT_TIMEOUT_MS }).toBe(1)
  const encoded = new URL(delivered[0] ?? '').searchParams.get(RESULT_PARAM)
  expect(encoded, '交回的地址里有结果').not.toBeNull()
  return decodeSelftestReport(encoded ?? '')
}

/** 造这一步的样本与账户（账户名前缀：用户名最长 32 个字符，后面还要加角色与随机后缀） */
async function stepOf(definition: SelftestStepDefinition): Promise<SelftestStep> {
  const [step] = (await selftestScene(`st${SELFTEST_STEPS.indexOf(definition)}`, [definition])).steps
  if (step === undefined)
    throw new Error(`没有 ${definition.id} 这一步`)
  return step
}

/**
 * 结果的要点：场景、页面怎么打开的、有没有检查、问题（页面上的检查之外，驱动脚本另外核对的）与服务器上的文档（交接的几步带上走的路）。
 * 没有豁免的问题：主线程模式在计算中重建（formula-timing-main 的 formula.rebuild-during-calc）在 M3-P4 S5 规避之后同样要求通过
 */
async function summaryOf(report: SelftestReport, step: SelftestStep, path?: string): Promise<unknown> {
  return {
    scenario: report.scenario,
    page: report.page,
    hasChecks: report.checks.length > 0,
    problems: problemsOf(report),
    server: (await serverProblemsOf(step, path)).problems,
  }
}

/**
 * 只读打开的场景（查看者，与作者的 enter-exit：它从阅读开始，自己点"编辑""退出编辑"；交接里另开的 B 与刷新的那一步也从阅读开始；请求编辑的请求方
 * 也从阅读开始）
 */
const READ_ONLY_SCENARIOS: ReadonlySet<string> = new Set(['read-only', 'read-only-formulas', 'enter-exit', 'takeover-taker', 'refresh-save', 'request-waiter'])

function passed(step: SelftestStep): unknown {
  return { scenario: step.scenario, page: { state: 'ready', readOnly: READ_ONLY_SCENARIOS.has(step.scenario) }, hasChecks: true, problems: [], server: [] }
}

/** hidden-save（Playwright 里模拟隐藏，单独一条用例） */
const HIDDEN_SAVE = SELFTEST_STEPS.filter(item => item.scenario === 'hidden-save')

/** 照常一步一条用例的（hidden-save、交接与请求编辑的几步另有编排） */
const PLAIN_STEPS = SELFTEST_STEPS.filter(item => item.scenario !== 'hidden-save' && !([...HANDOVER_SCENARIOS, ...REQUEST_SCENARIOS] as readonly string[]).includes(item.scenario))

/** 定义里的一步 */
function definitionOf(id: string): SelftestStepDefinition {
  const definition = SELFTEST_STEPS.find(item => item.id === id)
  if (definition === undefined)
    throw new Error(`没有 ${id} 这一步`)
  return definition
}

/** takeover 的一对（A 与 B，同一份文档）：holderId 是 A 那一步，B 是共用它的文档的那一步 */
async function takeoverSteps(prefix: string, holderId: string): Promise<{ readonly holder: SelftestStep, readonly taker: SelftestStep }> {
  const taker = SELFTEST_STEPS.find(item => item.sharesDocumentOf === holderId)
  if (taker === undefined)
    throw new Error(`没有与 ${holderId} 共用文档的那一步`)
  const [holder, other] = (await selftestScene(prefix, [definitionOf(holderId), taker])).steps
  return pairOf(holder, other)
}

function pairOf(holder: SelftestStep | undefined, taker: SelftestStep | undefined): { readonly holder: SelftestStep, readonly taker: SelftestStep } {
  if (holder === undefined || taker === undefined || holder.documentId !== taker.documentId)
    throw new Error('takeover 的两步不全，或者不是同一份文档')
  return { holder, taker }
}

/** 模拟页面的可见性变化（Playwright 的页面一直可见：与 reading-updates.spec.ts 同一个办法） */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/**
 * takeover 的编排（与驱动脚本相同，模拟隐藏）：打开 A、等第一格存上 → A 隐藏 → 另开 B → 等 B 交回 → A 回到前台 → 等 A 交回。
 * 交回两边的结果与按库里的时间线（另开 B 的时刻算起）的判定
 */
async function runTakeover(page: Page, other: Page, steps: { readonly holder: SelftestStep, readonly taker: SelftestStep }): Promise<{ readonly holder: SelftestReport, readonly taker: SelftestReport, readonly judgement: Judgement }> {
  const since = Date.now()
  const watch = await watchDocument(steps.holder.documentId)
  let openedTakerAt: number | undefined
  let holder: SelftestReport
  let taker: SelftestReport
  try {
    const holderDelivered = await startSelftest(page, steps.holder)
    await expect.poll(async () => revisionOf(steps.holder.documentId), { message: '等 A 存上第一格', timeout: REPORT_TIMEOUT_MS }).toBe(2)
    await setVisibility(page, 'hidden')
    openedTakerAt = Date.now()
    taker = await reportOf(await startSelftest(other, steps.taker))
    await setVisibility(page, 'visible')
    holder = await reportOf(holderDelivered)
    // 后端的日志是异步写进文件的：等一会儿再读
    await sleep(1_000)
  }
  finally {
    await watch.stop()
  }
  const requests = serverRequestsOf(steps.holder.documentId, since)
  return { holder, taker, judgement: takeoverJudgement({ taker, holder, states: watch.states(), requests, openedTakerAt }) }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** refresh-save 这一步（自己一份文档） */
async function refreshStep(): Promise<SelftestStep> {
  const [step] = (await selftestScene('st-refresh', [definitionOf('refresh-save')])).steps
  if (step === undefined)
    throw new Error('没有 refresh-save 这一步')
  return step
}

/**
 * refresh-save 的编排（与驱动脚本相同）：让这份文档的保存在服务端停 10 秒 → 打开 → 看到保存停着 → 等它做完 → 撤掉登记 → 等交回。
 * 交回结果、按页面、库里的时间线与后端日志的判定，与证据（库里的时间线、这份文档的请求）
 */
async function runRefreshSave(page: Page, step: SelftestStep): Promise<{ readonly report: SelftestReport, readonly judgement: Judgement, readonly evidence: Readonly<Record<string, unknown>> }> {
  const since = Date.now()
  const slow = await slowDownSave(step.documentId, REFRESH_SLOW_SAVE_SECONDS)
  const watch = await watchDocument(step.documentId)
  let blockedAt: number | undefined
  let finishedAt: number | undefined
  let report: SelftestReport
  try {
    let delivered: string[]
    try {
      delivered = await startSelftest(page, step)
      blockedAt = await slow.blockedSince(Date.now() + REPORT_TIMEOUT_MS)
      if (blockedAt !== undefined)
        finishedAt = await slow.finishedSince(blockedAt + (REFRESH_SLOW_SAVE_SECONDS + 10) * 1000)
    }
    finally {
      await slow.dispose()
    }
    report = await reportOf(delivered)
    // 后端的日志是异步写进文件的：等一会儿再读
    await sleep(1_000)
  }
  finally {
    await watch.stop()
  }
  const states = watch.states()
  const requests = serverRequestsOf(step.documentId, since)
  return { report, judgement: refreshJudgement({ report, states, requests, blockedAt, finishedAt }), evidence: { blockedAt, finishedAt, states, requests } }
}

/** 请求编辑的一步（自己一份文档）与它的场景：作者在浏览器里，协作者（peer）经接口扮演另一方 */
async function requestScene(prefix: string, id: string): Promise<{ readonly step: SelftestStep, readonly author: TestUser, readonly peer: TestUser }> {
  const scene = await selftestScene(prefix, [definitionOf(id)])
  const [step] = scene.steps
  if (step === undefined)
    throw new Error(`没有 ${id} 这一步`)
  return { step, author: scene.author, peer: scene.peer }
}

/** 等结果交回（到 deadline），解开；交不回时 undefined（判定里记下，用例随之不通过） */
async function reportBefore(delivered: readonly string[], deadline: number): Promise<SelftestReport | undefined> {
  while (delivered.length === 0 && Date.now() < deadline)
    await sleep(250)
  const encoded = delivered[0] === undefined ? null : new URL(delivered[0]).searchParams.get(RESULT_PARAM)
  return encoded === null ? undefined : decodeSelftestReport(encoded)
}

/** 编排完的一条路交给用例看：页面交回的结果与判定、库里的时间线、后端日志与协作者的调用（附件，失败时看） */
async function attachRun(testInfo: Parameters<Parameters<typeof test>[2]>[1], run: RequestRun): Promise<void> {
  await testInfo.attach('selftest-report', { body: JSON.stringify(run.report ?? null, null, 2), contentType: 'application/json' })
  await testInfo.attach('request-evidence', { body: JSON.stringify({ judgement: run.judgement, marks: run.marks, notes: run.notes, states: run.states, requests: run.requests, calls: run.calls }, null, 2), contentType: 'application/json' })
}

/** 路 2 的"暂停"在 Playwright 里的模拟：拦住这份文档的心跳（PUT …/edit-lease）与交出（POST …/edit-lease/handover），别的照常（申请、释放、保存） */
async function holdHolderBack(route: Route): Promise<void> {
  const request = route.request()
  const path = new URL(request.url()).pathname
  if ((request.method() === 'PUT' && path.endsWith('/edit-lease')) || (request.method() === 'POST' && path.endsWith('/edit-lease/handover')))
    await route.abort('internetdisconnected')
  else
    await route.fallback()
}

test.describe('US-M2-11 页面自检（真实 Safari 复核用）在 Playwright 的浏览器里每项都通过', { tag: '@test-build' }, () => {
  for (const definition of PLAIN_STEPS) {
    test(`步骤 ${definition.id}`, async ({ page }, testInfo) => {
      const step = await stepOf(definition)
      const report = await reportOf(await startSelftest(page, step))
      await testInfo.attach('selftest-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
      expect(await summaryOf(report, step)).toEqual(passed(step))
    })
  }

  for (const definition of HIDDEN_SAVE) {
    test(`步骤 ${definition.id}：第一次上传之后页面变成隐藏（这里模拟），自动保存在隐藏的那一刻捕获、上传留着的第二格，服务器上有两次保存`, async ({ page }, testInfo) => {
      const step = await stepOf(definition)
      const delivered = await startSelftest(page, step)
      await expect.poll(async () => revisionOf(step.documentId), { message: '等第一次上传', timeout: REPORT_TIMEOUT_MS }).toBe(2)
      // Playwright 的页面一直可见（无头浏览器另开标签页也不变）：与 reading-updates.spec.ts 同一个办法模拟可见性变成 hidden
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const report = await reportOf(delivered)
      await testInfo.attach('selftest-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
      expect(await summaryOf(report, step)).toEqual(passed(step))
    })
  }

  test('步骤 takeover（M3-P5 设计 §3.14）：A 编辑、存上第一格、隐藏（这里模拟）时上传第二格、之后写第三格；B 等 8 秒点"在此编辑"——Playwright 里 A 照常回应：先保存（第三格也存上）再交出（B answered、A handed-over），库里 A 那一代不释放、B 以本人接管换代（审查 B4）', async ({ page, context }, testInfo) => {
    const steps = await takeoverSteps('st-takeover', 'takeover-holder')
    const { holder, taker, judgement } = await runTakeover(page, await context.newPage(), steps)
    await testInfo.attach('selftest-report-holder', { body: JSON.stringify(holder, null, 2), contentType: 'application/json' })
    await testInfo.attach('selftest-report-taker', { body: JSON.stringify(taker, null, 2), contentType: 'application/json' })
    expect([taker.path, holder.path]).toEqual(['answered', 'handed-over'])
    expect(await summaryOf(taker, steps.taker, taker.path)).toEqual(passed(steps.taker))
    expect(await summaryOf(holder, steps.holder, taker.path)).toEqual(passed(steps.holder))
    expect(judgement.problems).toEqual([])
  })

  test('步骤 takeover-deaf：A 不回应（takeover-holder-deaf：编辑器页的挂接让 A 收不到交接频道的消息，模拟被暂停、冻结的 A）——B 3 秒之后本人接管并抢锁（silent），A 失去编辑权（本浏览器的另一个标签页接手了），第三格没存上、另存为副本；库里 A 那一代没有释放、B 的一代记着本人接管', async ({ page, context }, testInfo) => {
    const steps = await takeoverSteps('st-takeover-deaf', 'takeover-deaf-holder')
    const { holder, taker, judgement } = await runTakeover(page, await context.newPage(), steps)
    await testInfo.attach('selftest-report-holder', { body: JSON.stringify(holder, null, 2), contentType: 'application/json' })
    await testInfo.attach('selftest-report-taker', { body: JSON.stringify(taker, null, 2), contentType: 'application/json' })
    expect([taker.path, holder.path]).toEqual(['silent', 'lost'])
    expect(await summaryOf(taker, steps.taker, taker.path)).toEqual(passed(steps.taker))
    expect(await summaryOf(holder, steps.holder, taker.path)).toEqual(passed(steps.holder))
    expect(judgement.problems).toEqual([])
  })

  test('步骤 refresh-save（M3-P5 设计 §3.7 的 R1，7a759da）：保存停在服务端时页面刷新——不释放、留下记号；刷新之后"在此编辑"先等，那次保存提交了才以本人接管进入编辑；服务器上有那次保存，接手之前没有释放的请求', async ({ page }, testInfo) => {
    const step = await refreshStep()
    const { report, judgement, evidence } = await runRefreshSave(page, step)
    await testInfo.attach('selftest-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
    await testInfo.attach('refresh-evidence', { body: JSON.stringify({ judgement, ...evidence }, null, 2), contentType: 'application/json' })
    expect(report.path).toBe('committed')
    expect(await summaryOf(report, step, report.path)).toEqual(passed(step))
    expect(judgement.problems).toEqual([])
  })

  test('步骤 request-waiter（M3-P6 设计 §3.10，DEF-062 路 1）：协作者经接口在编辑，作者点"请求编辑"；心跳带来请求之后作者的页面隐藏（这里模拟）、协作者交出——作者在后台续期得知交给了它，停在交给了我、不申请；回到前台之后才以普通申请进入编辑、写一格存上', async ({ page }, testInfo) => {
    const { step, author, peer } = await requestScene('st-waiter', 'request-waiter')
    let delivered: string[] = []
    const stage: RequestStage = {
      open: async () => {
        delivered = await startSelftest(page, step)
      },
      hide: async () => setVisibility(page, 'hidden'),
      show: async () => setVisibility(page, 'visible'),
      report: async deadline => reportBefore(delivered, deadline),
    }
    const run = await runWaiter({ origin: e2eOrigin(), documentId: step.documentId, holder: peer, waiter: author, stage, deadline: Date.now() + REPORT_TIMEOUT_MS })
    await attachRun(testInfo, run)
    expect(run.report?.path).toBe('entered-on-return')
    expect(run.report === undefined ? undefined : await summaryOf(run.report, step, run.report.path)).toEqual(passed(step))
    expect(run.judgement.problems).toEqual([])
  })

  test('步骤 paused-holder（M3-P6 设计 §3.10，DEF-062 路 2）：作者编辑、存上第一格之后页面隐藏（这里模拟）、被"暂停"（这里拦住它的心跳与交出），隐藏的那一刻上传第二格、之后写第三格；协作者经接口请求、续期，作者那一代按时间到期（真等一个有效期）之后接手；回到前台之后作者得知失去编辑权（协作者在编辑）、第三格另存为副本；库里作者那一代没有交出、没有释放', async ({ page }, testInfo) => {
    // 真等一个有效期（90 秒）再加打开、接手与另存为副本
    test.setTimeout(EDITOR_TEST_TIMEOUT + 180_000)
    const { step, author, peer } = await requestScene('st-paused', 'paused-holder')
    const pattern = `**/api/documents/${step.documentId}/edit-lease**`
    let delivered: string[] = []
    const stage: RequestStage = {
      open: async () => {
        delivered = await startSelftest(page, step)
      },
      hide: async () => {
        await setVisibility(page, 'hidden')
        await page.route(pattern, holdHolderBack)
      },
      show: async () => {
        // 先回到前台、再放开：放开之后的第一次心跳才得知失去编辑权（与真实 Safari 一样在回来之后）
        await setVisibility(page, 'visible')
        await page.unroute(pattern, holdHolderBack)
      },
      report: async deadline => reportBefore(delivered, deadline),
    }
    const run = await runPausedHolder({ origin: e2eOrigin(), documentId: step.documentId, holder: author, requester: peer, stage, deadline: Date.now() + REPORT_TIMEOUT_MS + 120_000, expectSuspended: false })
    await attachRun(testInfo, run)
    expect(run.report?.path).toBe('lost-after-pause')
    expect(run.report === undefined ? undefined : await summaryOf(run.report, step, run.report.path)).toEqual(passed(step))
    expect(run.judgement.problems).toEqual([])
  })
})

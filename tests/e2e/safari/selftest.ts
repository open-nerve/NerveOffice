// 真实 Safari 的页面自检的驱动脚本（M3-P2 设计 §3.5，DEF-003 的阅读模式部分）。Playwright 只能驱动它自带的 WebKit，驱动不了真实 Safari：
// 检查由编辑器页里编译进测试构建的自检自己做（apps/web/src/editor/testing/selftest.ts，与 E2E 共用入口清单），这里只负责：
// 1. 起 E2E 的后端：与 Playwright 同一个服务脚本（support/serve.ts：本次运行专用的库、迁移、托管测试构建），端口按次挑选，
//    库名带本进程的进程号（服务脚本停下时删库；本进程被强制结束时，下一次 E2E 或自检启动时按进程号清理）；
// 2. 写库造场景（support/selftest-plan.ts：查看者、作者，每一步一份文档——只读样本、去掉公式缓存值的样本、模板、公式样本与 5 万行的大表）；
// 3. 起收集端（本机的另一个端口）：每一步做完，页面整页跳到收集端，结果在查询参数里（页面的 CSP 只许同源连接、E2E 的后端是生产的后端，
//    没有收结果的接口；顶层跳转不受 CSP 限制）。收集端收下这一步的结果，把页面带到下一步的入口页，最后停在结束页；
// 4. open -g -a Safari 在后台打开第一步的入口页（M0 的做法），--front 时 open -a Safari 把 Safari 带到前台：不改 Safari 的设置，
//    不用"允许远程自动化"；
// 5. 等全部的结果（总时限，--timeout 秒），核对服务器上的文档（support/selftest-plan.ts 的 storedProblems：只看不改的几步没有保存过；
//    enter-exit 恰好保存了一次、内容里有改的那一格；自动保存照常运行的几步至少保存了一次、存下的内容按定义核对），
//    写 tests/e2e/test-results/safari/<时间>.json（Safari 与 macOS 的版本、每步每项的结果、页面错误、计时与时间线），打印汇总；
//    上一步带过去的最后一步 hidden-save（M3-P4 S1；S7 起由自动保存上传）由这里编排：在库里看到它第一次上传（修订号 2）之后，open -a Safari
//    另开收集端的空白页（HIDE_PATH），编辑器页随之真的变成隐藏，自动保存在隐藏的那一刻捕获、上传留着的第二格；按库里的证据判定（修订号 3、
//    内容里有两格）与用时，页面在后台交不回结果也不算超时；
//    之后是交接的复核（M3-P5 S8，设计 §3.14），各另开一个标签页（support/selftest-handover.ts 的编排，与 Playwright 的校准共用）：
//    · takeover（两对：A 照常；A 收不到交接频道的消息，模拟被暂停的标签页）：另开 A（作者，进入编辑）；库里有了 A 的第一格（修订号 2）就另开 B（同一个会话，直接打开编辑器页），A 随之隐藏、自动保存
//      上传第二格；B 等 8 秒点"在此编辑"、进入编辑、交回之后去关掉自己的页（CLOSE_PATH），Safari 回到 A，A 交回（交不回只记下）。
//      期间每 100 毫秒记下库里的修订号与编辑租约；按 B 走的路判定服务器上的内容与租约的变化（support/selftest-handover.ts 的 takeoverJudgement）；
//    · refresh-save：先让这份文档的保存在服务端停 10 秒（support/selftest-handover.ts 的 slowDownSave：改写内容行之前 pg_sleep），再另开它；
//      页面发出保存、1.5 秒之后刷新，刷新之后"在此编辑"、等那次保存；按页面交回的、库里的时间线与后端日志里这份文档的请求判定
//      （refreshJudgement：刷新之前那一代没被释放、接手是本人接管、修订号在接手之前前进、接手之前没有释放的请求）；
//    最后是请求编辑的两条路（M3-P6 设计 §3.10，DEF-062；support/selftest-request.ts 的编排，与 Playwright 的校准共用）：被复核的一方（作者）在 Safari 里，
//    另一方（场景的协作者）由这里经接口扮演——
//    · request-waiter（路 1）：协作者申请编辑权、心跳；另开作者的页面，点"请求编辑"；协作者的心跳带来请求之后另开遮住它的标签页（SHADE_PATH）、
//      协作者交出；后端日志里作者在交出之后续期了（它在后台得知交给了它），再停 12 秒，让遮住它的标签页关掉自己，作者回到前台之后才进入编辑
//      （waiterJudgement：停着的时候没有申请、回到前台之后普通申请）；
//    · paused-holder（路 2，盖屏）：另开作者的页面（进入编辑，存上第一格）；用 osascript 自己的窗口盖住每一块屏幕（./desktop.ts，写明用途、按 Esc 或
//      点它就中止，到了自己的时限也会关掉），作者的页面隐藏、约 50 秒后被 Safari 暂停；协作者请求、续期，作者那一代按时间到期之后申请；移走盖屏，
//      作者回来、得知失去编辑权、另存为副本（pausedHolderJudgement：那一代没有交出、没有释放，最后一次续租到协作者申请不短于 90 秒，页面的计时器停过）；
// 6. 停后端、删库。Safari 里留下停在结束页的标签页（与 M0 相同），可以关掉；盖屏的窗口与 osascript 跑完一定不在（核对进程号）。
// 只在用户空闲时跑（--idle，默认 120 秒；开头检查，等不到就不跑；屏幕锁着时不跑）：跑的时候每秒看一次用户回来没有（./desktop.ts），回来了这一次作废
// （退出码 4），盖着屏就随即移走；在盖屏的窗口上按 Esc 或点它同样中止、作废。
// 退出码：0 全部通过；1 有不通过的检查、页面错误或服务器上的核对不对；2 超时（有的步没有交回结果）；3 准备阶段失败（没有构建、
// 库连不上、Safari 打不开、用户一直在用电脑、屏幕锁着）；4 作废（用户回来了、中止了）。
// 用法：pnpm --filter @nerve-office/e2e run safari:selftest [--front] [--timeout 秒] [--steps 标识,标识…] [--idle 秒] [--idle-wait 秒]（命令先构建后端与
// 测试构建；--steps 只跑这几步，例如 takeover-holder,takeover-taker,refresh-save——B 要与 A 一起选；request-waiter,paused-holder 是请求编辑的两条路；
// --idle 是开始之前用户要空闲多久，--idle-wait 是最多等多久）。不进 CI（CI 上没有 Safari）。
// 与 Playwright 的 E2E 共用 test-results/ 下的服务日志（e2e-server.log）与控制文件：不要与 pnpm test:e2e 在同一个检出里同时跑。
// 自检的页面要看得见：Safari 不给隐藏的标签页（窗口被挡住、不在前面的标签页、屏幕锁定）动画帧，几秒之后连计时器也停了
// （2026-10-04 本机 Safari 27.0 实测：Safari 的窗口不在前面时，open -g 打开的标签页一开始就是 hidden，动画帧 0 帧，计时器约 6 秒之后
// 不再触发），编辑器画不出来。页面开始时是隐藏的，自检马上交回"页面在后台"（不等超时）；这时让 Safari 的窗口露出来再跑，或者加 --front
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { TestUser } from '../support/database.ts'
import type { DocumentState, Judgement, ServerRequest } from '../support/selftest-handover.ts'
import type { SelftestStep } from '../support/selftest-plan.ts'
import type { RequestRun, RequestStage } from '../support/selftest-request.ts'
import type { ActivityWatch, Cover, CoverOutcome } from './desktop.ts'
import type { ChainLink, Received, StepOutcome } from './run-plan.ts'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { decodeSelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { revisionOf } from '../support/database.ts'
import { databaseUrl, E2E_DATABASE_PREFIX, pickFreePort } from '../support/environment.ts'
import { REFRESH_SLOW_SAVE_SECONDS, refreshJudgement, serverRequestsOf, slowDownSave, takeoverJudgement, watchDocument } from '../support/selftest-handover.ts'
import { SELFTEST_STEPS, selftestScene, serverProblemsOf } from '../support/selftest-plan.ts'
import { runPausedHolder, runWaiter } from '../support/selftest-request.ts'
import { hidIdleSeconds, processAlive, screenLocked, startCover, waitForIdle, watchActivity } from './desktop.ts'
import { chainOf, CLOSE_PATH, DONE_PATH, exitCodeOf, HIDE_PATH, nextAfter, outcomeOf, parseReportRequest, resultFileName, selectSteps, serverJudgedOutcome, SHADE_COMMAND_PATH, SHADE_PAGE, SHADE_PATH, timingLines, VOIDED_EXIT_CODE } from './run-plan.ts'

const SERVE_SCRIPT = fileURLToPath(new URL('../support/serve.ts', import.meta.url))
const SELFTEST_PAGE = fileURLToPath(new URL('../../../apps/web/dist-e2e/selftest.html', import.meta.url))
const RESULTS_DIR = fileURLToPath(new URL('../test-results/safari/', import.meta.url))

/** 准备阶段失败 */
const SETUP_FAILED = 3

/** 开始之前用户要空闲多久（秒，--idle）：P5 的复核里用户切回来挡住 Safari 的窗口，这次之后改为空闲满 1.5–4 分钟再跑 */
const DEFAULT_IDLE_SECONDS = 120

/** 等用户空闲最多等多久（秒，--idle-wait）：等不到就不跑 */
const DEFAULT_IDLE_WAIT_SECONDS = 1800

/** 后端起来最多等多久（迁移、初始化管理员、启动） */
const SERVER_READY_TIMEOUT_MS = 120_000

/** 收集端接受的请求行最长多少字节：结果在查询参数里（压缩之后一般几 KiB） */
const MAX_REQUEST_HEADER_BYTES = 4 * 1024 * 1024

function say(message: string): void {
  process.stdout.write(`真实 Safari 的自检：${message}\n`)
}

/** 本机 Safari 的版本（Safari.app 的 CFBundleShortVersionString） */
function safariVersion(): string {
  return execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
}

function macosVersion(): string {
  return execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
}

class SetupError extends Error {
  override readonly name = 'SetupError'
}

/** 起服务脚本（Playwright 的 webServer 也是它）：标准输入一直开着，关掉它或者发 SIGTERM 时停后端、删库 */
function startServer(port: number, database: string): ChildProcess {
  const child = spawn(process.execPath, [SERVE_SCRIPT], {
    env: { ...process.env, E2E_PORT: String(port), E2E_DATABASE_URL: database },
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  return child
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  await exited
  clearTimeout(timer)
}

async function waitUntilReady(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new SetupError(`服务脚本退出了（退出码 ${child.exitCode}）：先构建后端与测试构建（pnpm --filter "@nerve-office/api..." run build、pnpm --filter @nerve-office/web run build:e2e），看 test-results/e2e-server.log`)
    try {
      if ((await fetch(`${origin}/api/health/ready`)).ok)
        return
    }
    catch {
      // 还没起来
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new SetupError(`${SERVER_READY_TIMEOUT_MS / 1000} 秒内后端没有就绪`)
}

/** 收集端：收下每一步的结果，把页面带到下一步 */
interface Collector {
  readonly origin: string
  readonly received: Map<number, Received>
  /** 每一步与它的入口地址、交回之后去哪 */
  readonly chain: readonly ChainLink[]
  /** 请求编辑的路 1（M3-P6）：遮住请求方的那一页（SHADE_PATH）问 SHADE_COMMAND_PATH 时回答什么——close 时它关掉自己 */
  readonly shade: { command: 'wait' | 'close' }
  readonly close: () => Promise<void>
}

async function startCollector(chainFor: (collector: string) => readonly ChainLink[]): Promise<Collector> {
  const received = new Map<number, Received>()
  const shade: Collector['shade'] = { command: 'wait' }
  let chain: readonly ChainLink[] = []
  let origin = ''
  const server = createServer({ maxHeaderSize: MAX_REQUEST_HEADER_BYTES }, (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname === SHADE_COMMAND_PATH) {
      // 遮住请求方的那一页每 300 毫秒问一次：不记日志
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(shade.command)
      return
    }
    say(`收集端收到 ${request.method ?? ''} ${url.pathname}（地址 ${String(request.url?.length ?? 0)} 个字符）`)
    if (url.pathname === SHADE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(SHADE_PAGE)
      return
    }
    if (url.pathname === DONE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end('<!doctype html><meta charset="utf-8"><title>页面自检结束</title><p>页面自检结束，结果已交给驱动脚本。可以关掉这个标签页。</p>')
      return
    }
    if (url.pathname === HIDE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end('<!doctype html><meta charset="utf-8"><title>让编辑器页隐藏</title><p>页面自检（hidden-save）：这个标签页让编辑器页变成隐藏。驱动脚本结束之后可以关掉。</p>')
      return
    }
    if (url.pathname === CLOSE_PATH) {
      // 另开的 B 交回之后：关掉自己（Safari 随之回到 A）。关不掉时说明，A 就一直在后台（它的结果交不回，按库里的证据判定）
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end('<!doctype html><meta charset="utf-8"><title>关掉这个标签页</title><p id="note">页面自检（takeover）：B 已交回结果，这个标签页关掉之后回到 A。</p><script>setTimeout(() => { window.close(); setTimeout(() => { document.getElementById("note").textContent = "这个标签页没能自己关掉：请切回 A 的标签页（或者关掉这一个）。" }, 1000) }, 300)</script>')
      return
    }
    const parsed = parseReportRequest(url, chain.length)
    if ('error' in parsed) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(parsed.error)
      return
    }
    void decodeSelftestReport(parsed.encoded)
      .then((report): Received => report, (error: unknown): Received => ({ undecodable: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        if (received.has(parsed.step)) {
          say(`第 ${parsed.step + 1} 步又交回了一次结果，留着第一次的`)
        }
        else {
          received.set(parsed.step, result)
          const step = chain[parsed.step]?.step
          const verdict = 'undecodable' in result ? `结果解不开：${result.undecodable}` : `${result.checks.filter(check => check.pass).length}/${result.checks.length} 项通过`
          say(`第 ${parsed.step + 1} 步（${step?.scenario ?? '?'}）交回：${verdict}`)
        }
        response.writeHead(303, { 'location': nextAfter(chain, parsed.step, origin), 'cache-control': 'no-store' }).end()
      })
  })
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    // 浏览器预先建好、没用上就断开的连接（ECONNRESET）不是问题；别的（例如地址超长）说出来
    if (error.code !== 'ECONNRESET')
      say(`收集端没能读出一个请求：${error.message}`)
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  chain = chainFor(origin)
  return {
    origin,
    received,
    chain,
    shade,
    close: async () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/** 等前 steps 步的结果都交回（或者到 deadline） */
async function waitForResults(collector: Collector, steps: number, deadline: number): Promise<void> {
  const delivered = (): boolean => Array.from({ length: steps }, (_, index) => index).every(index => collector.received.has(index))
  while (!delivered() && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 500))
}

/** 等这份文档的修订号到 revision（每 100 毫秒查一次库）；到了返回那一刻（Date.now()），到 deadline 还没到返回 undefined */
async function waitForRevision(documentId: string, revision: number, deadline: number): Promise<number | undefined> {
  while (Date.now() < deadline) {
    if (((await revisionOf(documentId)) ?? 0) >= revision)
      return Date.now()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return undefined
}

/** hidden-save 等第一次上传最多多久（这一步的页面要登录、打开、进入编辑、上传第一格） */
const HIDDEN_FIRST_SAVE_TIMEOUT_MS = 120_000

/** 另开标签页之后，等自动保存在隐藏时上传的那一版最多多久（Safari 约 6 秒之后停隐藏页面的计时器：上传要在那之前发出） */
const HIDDEN_SAVE_TIMEOUT_MS = 60_000

/** 隐藏时上传的那一版存下之后，再等页面交回结果多久（交不回也不算失败：页面在后台） */
const HIDDEN_REPORT_GRACE_MS = 30_000

/**
 * 编排 hidden-save（最后一步）：等它第一次上传（修订号 2）→ open -a Safari 另开收集端的空白页，编辑器页随之变成隐藏 →
 * 等自动保存在隐藏时上传的那一版（修订号 3）→ 再等一会儿页面的结果。返回证据的说明
 */
async function driveHiddenSave(collector: Collector, step: SelftestStep, index: number, deadline: number): Promise<string> {
  const first = await waitForRevision(step.documentId, 2, Math.min(deadline, Date.now() + HIDDEN_FIRST_SAVE_TIMEOUT_MS))
  if (first === undefined)
    return `${HIDDEN_FIRST_SAVE_TIMEOUT_MS / 1000} 秒内没有等到第一次上传（修订号 2），没有另开标签页`
  say('hidden-save：库里有了第一次上传，另开标签页让编辑器页隐藏')
  const opened = Date.now()
  try {
    execFileSync('open', ['-a', 'Safari', new URL(HIDE_PATH, collector.origin).href])
  }
  catch (error) {
    return `另开标签页失败：${error instanceof Error ? error.message : String(error)}`
  }
  const second = await waitForRevision(step.documentId, 3, Math.min(deadline, opened + HIDDEN_SAVE_TIMEOUT_MS))
  if (second === undefined)
    return `另开标签页之后 ${HIDDEN_SAVE_TIMEOUT_MS / 1000} 秒内库里没有自动保存在隐藏时上传的那一版（修订号 3）`
  say(`hidden-save：另开标签页之后 ${second - opened} ms 库里有了自动保存在隐藏时上传的那一版`)
  await waitForResults(collector, index + 1, Math.min(deadline, Date.now() + HIDDEN_REPORT_GRACE_MS))
  return `库里看到第一次上传之后另开标签页；另开之后 ${second - opened} ms 库里有了自动保存在隐藏时上传的那一版（每 100 毫秒查一次库）；页面的结果${collector.received.has(index) ? '交回了' : `在 ${HIDDEN_REPORT_GRACE_MS / 1000} 秒内没有交回（页面在后台）`}`
}

/** 在 Safari 里另开一个标签页（带到前台）打开 url */
function openInSafari(url: string): void {
  execFileSync('open', ['-a', 'Safari', url])
}

/** 等第 index 步交回结果（或者到 deadline） */
async function waitForResult(collector: Collector, index: number, deadline: number): Promise<void> {
  while (!collector.received.has(index) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 500))
}

/** 收到的结果（解开了的）；没有、解不开时 undefined */
function reportAt(collector: Collector, index: number): Exclude<Received, { readonly undecodable: string }> | undefined {
  const received = collector.received.get(index)
  return received === undefined || 'undecodable' in received ? undefined : received
}

/** 交接的一步编排完的样子：判定、库里的时间线与后端日志里这份文档的请求 */
interface HandoverRun {
  readonly judgement: Judgement
  readonly states: readonly DocumentState[]
  readonly requests: readonly ServerRequest[]
  readonly notes: readonly string[]
}

/** 本人接管的一对：A（takeover-holder 或 takeover-holder-deaf）与共用它的文档的 B 在步骤里的序号 */
interface TakeoverPair {
  readonly holder: number
  readonly taker: number
}

function takeoverPairsOf(steps: readonly SelftestStep[]): TakeoverPair[] {
  return steps.flatMap((step, holder) => {
    const taker = steps.findIndex(item => item.scenario === 'takeover-taker' && item.sharesDocumentOf === step.id)
    return taker >= 0 ? [{ holder, taker }] : []
  })
}

/** takeover：A 存上第一格最多等多久（登录、打开、进入编辑、写第一格） */
const TAKEOVER_FIRST_SAVE_TIMEOUT_MS = 120_000

/** takeover：另开 B 之后等 A 隐藏时上传的第二格（修订号 3）最多多久 */
const TAKEOVER_HIDDEN_SAVE_TIMEOUT_MS = 60_000

/** takeover：另开 B 之后等 B 交回最多多久（载入、等 8 秒、接手、核对） */
const TAKEOVER_TAKER_TIMEOUT_MS = 150_000

/** takeover：B 交回之后再等 A 交回多久（B 的标签页关掉、A 回到前台；交不回也不算失败：按库里的证据判定） */
const TAKEOVER_HOLDER_GRACE_MS = 90_000

/**
 * 编排 takeover（见文件头）：另开 A → 库里有了第一格 → 另开 B（A 隐藏）→ 等 B 交回 → 等 A 交回。期间记下库里的修订号与编辑租约，
 * 按 B 走的路判定（takeoverJudgement）
 */
async function driveTakeover(collector: Collector, holderIndex: number, takerIndex: number, deadline: number): Promise<HandoverRun> {
  const holder = collector.chain[holderIndex]
  const taker = collector.chain[takerIndex]
  if (holder === undefined || taker === undefined)
    throw new SetupError('takeover 的两步不全')
  const documentId = holder.step.documentId
  const notes: string[] = []
  const since = Date.now()
  const watch = await watchDocument(documentId)
  let openedTakerAt: number | undefined
  try {
    say(`takeover（${holder.step.id}）：另开标签页打开 A（作者，进入编辑${holder.step.scenario === 'takeover-holder-deaf' ? '；收不到交接频道的消息' : ''}）`)
    openInSafari(holder.url)
    const first = await waitForRevision(documentId, 2, Math.min(deadline, Date.now() + TAKEOVER_FIRST_SAVE_TIMEOUT_MS))
    if (first === undefined) {
      notes.push(`${TAKEOVER_FIRST_SAVE_TIMEOUT_MS / 1000} 秒内 A 没有存上第一格（修订号 2），没有另开 B`)
      await waitForResult(collector, holderIndex, Math.min(deadline, Date.now() + 5_000))
    }
    else {
      say(`takeover（${holder.step.id}）：库里有了 A 的第一格，另开 B（同一个会话，直接打开编辑器页），A 随之隐藏`)
      openedTakerAt = Date.now()
      openInSafari(taker.url)
      const second = await waitForRevision(documentId, 3, Math.min(deadline, openedTakerAt + TAKEOVER_HIDDEN_SAVE_TIMEOUT_MS))
      notes.push(second === undefined ? `另开 B 之后 ${TAKEOVER_HIDDEN_SAVE_TIMEOUT_MS / 1000} 秒内库里没有 A 隐藏时上传的第二格（修订号 3）` : `另开 B 之后 ${second - openedTakerAt} ms 库里有了 A 隐藏时上传的第二格（每 100 毫秒查一次库）`)
      await waitForResult(collector, takerIndex, Math.min(deadline, openedTakerAt + TAKEOVER_TAKER_TIMEOUT_MS))
      say(`takeover（${holder.step.id}）：B ${collector.received.has(takerIndex) ? '交回了' : '没有交回'}，等 A 回到前台、交回`)
      await waitForResult(collector, holderIndex, Math.min(deadline, Date.now() + TAKEOVER_HOLDER_GRACE_MS))
      if (!collector.received.has(holderIndex))
        notes.push(`B 交回之后 ${TAKEOVER_HOLDER_GRACE_MS / 1000} 秒内 A 没有交回结果（还在后台？）`)
    }
    // 后端的日志是异步写进文件的：等一会儿再读
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  finally {
    await watch.stop()
  }
  const states = watch.states()
  const requests = serverRequestsOf(documentId, since)
  const judgement = takeoverJudgement({ taker: reportAt(collector, takerIndex), holder: reportAt(collector, holderIndex), states, requests, openedTakerAt })
  return { judgement: { problems: judgement.problems, evidence: [judgement.evidence, ...notes].join('；') }, states, requests, notes }
}

/** refresh-save：另开之后等保存停在服务端最多多久（登录、打开、进入编辑、写一格、发出保存） */
const REFRESH_BLOCK_TIMEOUT_MS = 120_000

/** refresh-save：停完之后等页面交回最多多久（接手、进入编辑、核对） */
const REFRESH_REPORT_TIMEOUT_MS = 120_000

/**
 * 编排 refresh-save（见文件头）：让这份文档的保存在服务端停 10 秒（slowDownSave）→ 另开 → 看到保存停着 → 等它做完 → 撤掉登记 → 等交回；
 * 按页面、库里与后端日志判定（refreshJudgement）
 */
async function driveRefreshSave(collector: Collector, index: number, deadline: number): Promise<HandoverRun> {
  const link = collector.chain[index]
  if (link === undefined)
    throw new SetupError('没有 refresh-save 这一步')
  const documentId = link.step.documentId
  const since = Date.now()
  const slow = await slowDownSave(documentId, REFRESH_SLOW_SAVE_SECONDS)
  const watch = await watchDocument(documentId)
  const notes: string[] = []
  let blockedAt: number | undefined
  let finishedAt: number | undefined
  try {
    try {
      say(`refresh-save：这份文档的保存在服务端要停 ${REFRESH_SLOW_SAVE_SECONDS} 秒，另开标签页打开它`)
      openInSafari(link.url)
      blockedAt = await slow.blockedSince(Math.min(deadline, Date.now() + REFRESH_BLOCK_TIMEOUT_MS))
      if (blockedAt === undefined) {
        notes.push(`${REFRESH_BLOCK_TIMEOUT_MS / 1000} 秒内没有看到保存停在服务端`)
      }
      else {
        say('refresh-save：保存停在服务端了，等它做完')
        finishedAt = await slow.finishedSince(blockedAt + (REFRESH_SLOW_SAVE_SECONDS + 10) * 1000)
      }
    }
    finally {
      await slow.dispose()
    }
    await waitForResult(collector, index, Math.min(deadline, Date.now() + REFRESH_REPORT_TIMEOUT_MS))
    // 后端的日志是异步写进文件的：等一会儿再读
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  finally {
    await watch.stop()
  }
  const states = watch.states()
  const requests = serverRequestsOf(documentId, since)
  const judgement = refreshJudgement({ report: reportAt(collector, index), states, requests, blockedAt, finishedAt })
  return { judgement: { problems: judgement.problems, evidence: [judgement.evidence, ...notes].join('；') }, states, requests, notes }
}

/** 请求编辑的两条路（M3-P6）要的：被测站点的源、作者（Safari 里）与协作者（经接口），跑的时候用户回来没有 */
interface RequestContext {
  readonly origin: string
  readonly author: TestUser
  readonly peer: TestUser
  readonly returned: () => string | undefined
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 盖屏最多盖多久（秒）：协作者请求之后至多 240 秒等到持有者那一代到期，加上等第二格、接手与移走的余量。正常时驱动脚本在协作者接手之后两秒就移走它；
 * 驱动脚本死掉时它到点自己关掉
 */
const COVER_MAX_SECONDS = 330

/** 正盖着屏的 osascript（收到 SIGINT、SIGTERM 时一并结束） */
let activeCover: Cover | undefined

/**
 * 编排 request-waiter（路 1，见文件头）：作者的页面另开；遮住它的标签页（SHADE_PATH）另开在它右边，叫它关掉时 Safari 回到作者的那一页
 */
async function driveWaiter(collector: Collector, index: number, context: RequestContext, deadline: number): Promise<RequestRun> {
  const link = collector.chain[index]
  if (link === undefined)
    throw new SetupError('没有 request-waiter 这一步')
  collector.shade.command = 'wait'
  const stage: RequestStage = {
    open: async () => openInSafari(link.url),
    hide: async () => openInSafari(new URL(SHADE_PATH, collector.origin).href),
    show: async () => {
      collector.shade.command = 'close'
      // 它每 300 毫秒问一次；关掉之后 Safari 回到作者的那一页
      await sleep(1_000)
    },
    report: async (until) => {
      await waitForResult(collector, index, until)
      return reportAt(collector, index)
    },
    voided: context.returned,
    say,
  }
  return runWaiter({ origin: context.origin, documentId: link.step.documentId, holder: context.peer, waiter: context.author, stage, deadline })
}

/** 路 2 编排完的样子：另带盖屏怎样结束的、跑完之后 osascript 还在不在（应当不在） */
interface PausedRun extends RequestRun {
  readonly cover: CoverOutcome | undefined
  readonly coverLeft: boolean
}

/**
 * 编排 paused-holder（路 2，见文件头）：盖屏用 ./desktop.ts 的 startCover；在盖屏的窗口上按了 Esc、点了它，或者用户回来了，就中止（随即移走、作废）。
 * 移走之后把 Safari 带回前台（作废时不带：别抢回来了的用户的焦点）
 */
async function drivePausedHolder(collector: Collector, index: number, context: RequestContext, deadline: number): Promise<PausedRun> {
  const link = collector.chain[index]
  if (link === undefined)
    throw new SetupError('没有 paused-holder 这一步')
  let cover: Cover | undefined
  let ended: CoverOutcome | undefined
  const voided = (): string | undefined => {
    const outcome = cover?.outcome()
    if (outcome === 'escape' || outcome === 'click')
      return `在盖屏的窗口上${outcome === 'escape' ? '按了 Esc' : '点了一下'}`
    if (outcome === 'timeout' || outcome === 'failed')
      return outcome === 'timeout' ? '盖屏到了它自己的时限' : '盖屏的 osascript 出错'
    return context.returned()
  }
  const stage: RequestStage = {
    open: async () => openInSafari(link.url),
    hide: async () => {
      cover = startCover(COVER_MAX_SECONDS)
      activeCover = cover
      // 窗口铺开，Safari 的页面随之隐藏
      await sleep(500)
    },
    show: async () => {
      ended = await cover?.stop()
      activeCover = undefined
      if (voided() === undefined)
        execFileSync('open', ['-a', 'Safari'])
    },
    report: async (until) => {
      await waitForResult(collector, index, until)
      return reportAt(collector, index)
    },
    voided,
    say,
  }
  const run = await runPausedHolder({ origin: context.origin, documentId: link.step.documentId, holder: context.author, requester: context.peer, stage, deadline, expectSuspended: true })
  return { ...run, cover: ended, coverLeft: processAlive(cover?.pid) }
}

/** 服务器上的核对（每一步的文档，support/selftest-plan.ts 的 storedProblems；交接的几步带上走的路，共用文档的那一步随它共用的那一步核对） */
async function checkServer(steps: readonly SelftestStep[], pathOf: (step: SelftestStep) => string | undefined): Promise<{ readonly revisions: Readonly<Record<string, number | undefined>>, readonly problems: string[] }> {
  const revisions: Record<string, number | undefined> = {}
  const problems: string[] = []
  for (const step of steps) {
    const checked = await serverProblemsOf(step, pathOf(step))
    revisions[step.documentId] = checked.revision
    problems.push(...checked.problems.map(problem => `${step.id}：${problem}`))
  }
  return { revisions, problems }
}

const STATUS_TEXT = { passed: '通过', failed: '不通过', missing: '没有结果' } as const

function printSummary(outcomes: readonly StepOutcome[], serverProblems: readonly string[]): void {
  for (const outcome of outcomes) {
    const checks = outcome.report?.checks ?? []
    say(`${STATUS_TEXT[outcome.status]}：${outcome.id}（${checks.filter(check => check.pass).length}/${checks.length} 项）`)
    if (outcome.evidence !== undefined)
      say(`  库里的证据：${outcome.evidence}`)
    for (const problem of outcome.problems)
      say(`  - ${problem}`)
    for (const line of timingLines(outcome.report?.timings ?? []))
      say(`  ${line}`)
  }
  for (const problem of serverProblems)
    say(`服务器上：${problem}`)
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    'timeout': { type: 'string', default: '1800' },
    'front': { type: 'boolean', default: false },
    'steps': { type: 'string' },
    'idle': { type: 'string', default: String(DEFAULT_IDLE_SECONDS) },
    'idle-wait': { type: 'string', default: String(DEFAULT_IDLE_WAIT_SECONDS) },
  } })
  const timeoutMs = Number(values.timeout) * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new SetupError(`--timeout 要是正的秒数：${values.timeout}`)
  const idleSeconds = Number(values.idle)
  const idleWaitSeconds = Number(values['idle-wait'])
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0 || !Number.isFinite(idleWaitSeconds) || idleWaitSeconds < 0)
    throw new SetupError(`--idle、--idle-wait 要是不小于 0 的秒数：${values.idle}、${values['idle-wait']}`)
  const selection = selectSteps(SELFTEST_STEPS, values.steps)
  if ('error' in selection)
    throw new SetupError(selection.error)
  if (!existsSync(SELFTEST_PAGE))
    throw new SetupError(`找不到 ${SELFTEST_PAGE}：先构建测试构建（pnpm --filter @nerve-office/web run build:e2e）`)
  if (screenLocked())
    throw new SetupError('屏幕锁着（或者这次登录不在控制台上）：Safari 的页面都是隐藏的，跑不了')
  const startedAt = new Date()
  const safari = safariVersion()
  const macos = macosVersion()
  const port = await pickFreePort()
  const origin = `http://127.0.0.1:${port}`
  const database = databaseUrl(`${E2E_DATABASE_PREFIX}${process.pid}`)
  // 写库的辅助（support/database.ts）从环境变量取本次运行的库
  process.env.E2E_DATABASE_URL = database
  say(`Safari ${safari}（macOS ${macos}），起后端 ${origin}`)
  const server = startServer(port, database)
  const stop = (signal: NodeJS.Signals): void => {
    say(`收到 ${signal}，移走盖屏（如果盖着）、停后端`)
    void activeCover?.stop()
    void stopServer(server).then(() => process.exit(130))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let collector: Collector | undefined
  let activity: ActivityWatch | undefined
  try {
    await waitUntilReady(origin, server)
    const scene = await selftestScene('safari', selection.definitions)
    const { steps } = scene
    collector = await startCollector(collectorOrigin => chainOf(steps, origin, collectorOrigin))
    // 只在用户空闲时跑（用户在用电脑时 Safari 的窗口会被挡住；请求编辑的路 2 还要盖屏）：等他空闲满 --idle 秒，之后每秒看一次他回来没有
    if (!await waitForIdle(idleSeconds, idleWaitSeconds, say))
      throw new SetupError(`等了 ${idleWaitSeconds} 秒，用户一直在用电脑（要空闲满 ${idleSeconds} 秒才跑）`)
    if (screenLocked())
      throw new SetupError('屏幕锁着（或者这次登录不在控制台上）：Safari 的页面都是隐藏的，跑不了')
    say(`用户已空闲 ${(hidIdleSeconds() ?? 0).toFixed(0)} 秒，开始（之后用户一回来这一次就作废）`)
    const watching = watchActivity()
    activity = watching
    const returned = (): string | undefined => {
      const at = watching.returnedAt()
      return at === undefined ? undefined : `用户在 ${new Date(at).toISOString()} 回来了（键盘、鼠标有了操作）`
    }
    // 由上一步带过去的第一步（只选了交接的几步时没有：它们由下面的编排各自另开）
    const first = collector.chain.find(link => !link.opened)
    say(`收集端 ${collector.origin}；在 Safari 里（${values.front ? '带到前台' : '后台'}）打开第一步，共 ${steps.length} 步，最多等 ${timeoutMs / 1000} 秒`)
    try {
      if (first !== undefined)
        execFileSync('open', [...(values.front ? [] : ['-g']), '-a', 'Safari', first.url])
    }
    catch (error) {
      throw new SetupError(`Safari 打不开：${error instanceof Error ? error.message : String(error)}`)
    }
    const deadline = Date.now() + timeoutMs
    // hidden-save 是上一步带过去的最后一步：之前的各步交回之后由这里编排它（页面在后台，按库里的证据判定）；之后是交接的复核（各另开一个标签页）
    const chained = collector.chain.filter(link => !link.opened).length
    const hiddenIndex = steps.findIndex(step => step.scenario === 'hidden-save')
    if (hiddenIndex >= 0 && hiddenIndex !== chained - 1)
      throw new SetupError('hidden-save 要是上一步带过去的最后一步')
    await waitForResults(collector, hiddenIndex >= 0 ? hiddenIndex : chained, deadline)
    const hiddenStep = steps[hiddenIndex]
    const evidence = hiddenStep === undefined ? undefined : await driveHiddenSave(collector, hiddenStep, hiddenIndex, deadline)
    // 本人接管的每一对（A 与共用它的文档的 B）依次编排
    const pairs = takeoverPairsOf(steps)
    const takeovers = new Map<number, HandoverRun>()
    for (const pair of pairs)
      takeovers.set(pair.holder, await driveTakeover(collector, pair.holder, pair.taker, deadline))
    const refreshIndex = steps.findIndex(step => step.scenario === 'refresh-save')
    const refresh = refreshIndex >= 0 ? await driveRefreshSave(collector, refreshIndex, deadline) : undefined
    // 请求编辑的两条路（M3-P6）：路 1 先、路 2（盖屏）最后；用户已经回来了就不再盖屏
    const context: RequestContext = { origin, author: scene.author, peer: scene.peer, returned }
    const waiterIndex = steps.findIndex(step => step.scenario === 'request-waiter')
    const waiter = waiterIndex >= 0 ? await driveWaiter(collector, waiterIndex, context, deadline) : undefined
    const pausedIndex = steps.findIndex(step => step.scenario === 'paused-holder')
    if (pausedIndex >= 0 && returned() !== undefined)
      say(`没有跑 paused-holder（不盖屏）：${returned() ?? ''}`)
    const paused = pausedIndex >= 0 && returned() === undefined ? await drivePausedHolder(collector, pausedIndex, context, deadline) : undefined
    watching.stop()
    const active = collector
    const { received } = active
    // 交接的几步在服务器上该是什么样子随走的路：A 的文档按 B 走的路，refresh-save 与请求编辑的两步按它自己交回的
    const pathOf = (step: SelftestStep): string | undefined => {
      const pair = pairs.find(item => item.holder === steps.indexOf(step))
      return reportAt(active, pair === undefined ? steps.indexOf(step) : pair.taker)?.path
    }
    const stored = await checkServer(steps, pathOf)
    const storedOf = (step: SelftestStep): string[] => stored.problems.filter(problem => problem.startsWith(`${step.id}：`))
    const requestRuns = new Map<number, RequestRun>([...(waiter === undefined ? [] : [[waiterIndex, waiter] as const]), ...(paused === undefined ? [] : [[pausedIndex, paused] as const])])
    const outcomes = steps.map((step, index) => {
      if (index === hiddenIndex)
        return serverJudgedOutcome(step, received.get(index), storedOf(step), evidence ?? '')
      const takeover = takeovers.get(index)
      if (takeover !== undefined)
        return serverJudgedOutcome(step, received.get(index), [...storedOf(step), ...takeover.judgement.problems], takeover.judgement.evidence)
      if (index === refreshIndex && refresh !== undefined)
        return serverJudgedOutcome(step, received.get(index), [...storedOf(step), ...refresh.judgement.problems], refresh.judgement.evidence)
      const request = requestRuns.get(index)
      if (request !== undefined)
        return serverJudgedOutcome(step, received.get(index), [...storedOf(step), ...request.judgement.problems], request.judgement.evidence)
      return outcomeOf(step, received.get(index))
    })
    // 作废：用户回来了（任何一步跑的时候）、在盖屏的窗口上按了 Esc 或点了它、盖屏到了时限；跑完之后盖屏的 osascript 还在也说出来
    const voided = returned() ?? waiter?.voided ?? paused?.voided
    if (paused?.coverLeft === true)
      stored.problems.push('盖屏的 osascript 跑完之后还在')
    const exitCode = voided === undefined ? exitCodeOf(outcomes, stored.problems) : VOIDED_EXIT_CODE
    mkdirSync(RESULTS_DIR, { recursive: true })
    const file = `${RESULTS_DIR}${resultFileName(startedAt)}`
    const requestSummary = (run: RequestRun | undefined): unknown => run === undefined ? undefined : { states: run.states, requests: run.requests, calls: run.calls, marks: run.marks, notes: run.notes, voided: run.voided }
    writeFileSync(file, `${JSON.stringify({
      tool: 'tests/e2e/safari/selftest.ts',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      safari,
      macos,
      origin,
      exitCode,
      voided,
      server: stored,
      steps: outcomes,
      // 交接的复核：库里的时间线（修订号与编辑租约每次变化的时刻）与 refresh-save 这份文档在后端日志里的请求
      handover: {
        takeover: Object.fromEntries([...takeovers].map(([index, run]) => [steps[index]?.id ?? String(index), { states: run.states, requests: run.requests }])),
        refresh: refresh === undefined ? undefined : { states: refresh.states, requests: refresh.requests },
      },
      // 请求编辑的两条路（M3-P6）：库里的时间线、后端日志里这份文档的请求、协作者的调用、各步的时刻；路 2 另有盖屏怎样结束的
      request: {
        waiter: requestSummary(waiter),
        paused: paused === undefined ? undefined : { ...requestSummary(paused) as object, cover: paused.cover, coverLeft: paused.coverLeft },
      },
    }, null, 2)}\n`)
    printSummary(outcomes, stored.problems)
    if (voided !== undefined)
      say(`这一次作废：${voided}`)
    say(`结果写在 ${file}；退出码 ${exitCode}`)
    return exitCode
  }
  finally {
    activity?.stop()
    await activeCover?.stop()
    await collector?.close()
    await stopServer(server)
  }
}

main().then(code => process.exit(code), (error: unknown) => {
  say(error instanceof SetupError ? error.message : `出错：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(SETUP_FAILED)
})

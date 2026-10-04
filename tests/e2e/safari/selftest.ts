// 真实 Safari 的页面自检的驱动脚本（M3-P2 设计 §3.5，DEF-003 的阅读模式部分）。Playwright 只能驱动它自带的 WebKit，驱动不了真实 Safari：
// 检查由编辑器页里编译进测试构建的自检自己做（apps/web/src/editor/testing/selftest.ts，与 E2E 共用入口清单），这里只负责：
// 1. 起 E2E 的后端：与 Playwright 同一个服务脚本（support/serve.ts：本次运行专用的库、迁移、托管测试构建），端口按次挑选，
//    库名带本进程的进程号（服务脚本停下时删库；本进程被强制结束时，下一次 E2E 或自检启动时按进程号清理）；
// 2. 写库造场景（support/selftest-plan.ts：查看者、作者、只读样本与去掉公式缓存值的样本）；
// 3. 起收集端（本机的另一个端口）：每一步做完，页面整页跳到收集端，结果在查询参数里（页面的 CSP 只许同源连接、E2E 的后端是生产的后端，
//    没有收结果的接口；顶层跳转不受 CSP 限制）。收集端收下这一步的结果，把页面带到下一步的入口页，最后停在结束页；
// 4. open -g -a Safari 在后台打开第一步的入口页（M0 的做法），--front 时 open -a Safari 把 Safari 带到前台：不改 Safari 的设置，
//    不用"允许远程自动化"；
// 5. 等全部的结果（总时限，--timeout 秒），核对服务器上的文档（只读的几步没有保存过；enter-exit 恰好保存了一次、内容里有改的那一格），
//    写 tests/e2e/test-results/safari/<时间>.json（Safari 与 macOS 的版本、每步每项的结果、页面错误、切换的耗时），打印汇总；
// 6. 停后端、删库。Safari 里留下一个停在结束页的标签页（与 M0 相同），可以关掉。
// 退出码：0 全部通过；1 有不通过的检查、页面错误或服务器上的核对不对；2 超时（有的步没有交回结果）；3 准备阶段失败（没有构建、
// 库连不上、Safari 打不开）。
// 用法：pnpm --filter @nerve-office/e2e run safari:selftest [--front] [--timeout 秒]（命令先构建后端与测试构建）。不进 CI（CI 上没有 Safari）。
// 与 Playwright 的 E2E 共用 test-results/ 下的服务日志（e2e-server.log）与控制文件：不要与 pnpm test:e2e 在同一个检出里同时跑。
// 自检的页面要看得见：Safari 不给隐藏的标签页（窗口被挡住、不在前面的标签页、屏幕锁定）动画帧，几秒之后连计时器也停了
// （2026-10-04 本机 Safari 27.0 实测：Safari 的窗口不在前面时，open -g 打开的标签页一开始就是 hidden，动画帧 0 帧，计时器约 6 秒之后
// 不再触发），编辑器画不出来。页面开始时是隐藏的，自检马上交回"页面在后台"（不等超时）；这时让 Safari 的窗口露出来再跑，或者加 --front
import type { ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import type { SelftestStep } from '../support/selftest-plan.ts'
import type { ChainLink, Received, StepOutcome } from './run-plan.ts'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { decodeSelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { databaseUrl, E2E_DATABASE_PREFIX, pickFreePort } from '../support/environment.ts'
import { selftestScene, selftestSteps, serverProblemsOf } from '../support/selftest-plan.ts'
import { chainOf, DONE_PATH, exitCodeOf, nextAfter, outcomeOf, parseReportRequest, resultFileName, timingLines } from './run-plan.ts'

const SERVE_SCRIPT = fileURLToPath(new URL('../support/serve.ts', import.meta.url))
const SELFTEST_PAGE = fileURLToPath(new URL('../../../apps/web/dist-e2e/selftest.html', import.meta.url))
const RESULTS_DIR = fileURLToPath(new URL('../test-results/safari/', import.meta.url))

/** 准备阶段失败 */
const SETUP_FAILED = 3

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
  readonly close: () => Promise<void>
}

async function startCollector(chainFor: (collector: string) => readonly ChainLink[]): Promise<Collector & { readonly chain: readonly ChainLink[] }> {
  const received = new Map<number, Received>()
  let chain: readonly ChainLink[] = []
  let origin = ''
  const server = createServer({ maxHeaderSize: MAX_REQUEST_HEADER_BYTES }, (request, response) => {
    const url = new URL(request.url ?? '/', origin)
    say(`收集端收到 ${request.method ?? ''} ${url.pathname}（地址 ${String(request.url?.length ?? 0)} 个字符）`)
    if (url.pathname === DONE_PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end('<!doctype html><meta charset="utf-8"><title>页面自检结束</title><p>页面自检结束，结果已交给驱动脚本。可以关掉这个标签页。</p>')
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
    close: async () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

async function waitForResults(collector: Collector, steps: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (collector.received.size < steps && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 500))
}

/** 服务器上的核对（每一步的文档）：只读的几步没有保存过（修订号仍是 1）；enter-exit 恰好保存了一次、内容里有改的那一格 */
async function checkServer(steps: readonly SelftestStep[]): Promise<{ readonly revisions: Readonly<Record<string, number | undefined>>, readonly problems: string[] }> {
  const revisions: Record<string, number | undefined> = {}
  const problems: string[] = []
  for (const step of steps) {
    const checked = await serverProblemsOf(step)
    revisions[step.documentId] = checked.revision
    problems.push(...checked.problems.map(problem => `${step.id}：${problem}`))
  }
  return { revisions, problems }
}

const STATUS_TEXT = { passed: '通过', failed: '不通过', missing: '没有结果' } as const

function printSummary(outcomes: readonly StepOutcome[], serverProblems: readonly string[]): void {
  for (const outcome of outcomes) {
    const checks = outcome.report?.checks ?? []
    say(`${STATUS_TEXT[outcome.status]}：${outcome.scenario}（${checks.filter(check => check.pass).length}/${checks.length} 项）`)
    for (const problem of outcome.problems)
      say(`  - ${problem}`)
    for (const line of timingLines(outcome.report?.timings ?? []))
      say(`  ${line}`)
  }
  for (const problem of serverProblems)
    say(`服务器上：${problem}`)
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { timeout: { type: 'string', default: '900' }, front: { type: 'boolean', default: false } } })
  const timeoutMs = Number(values.timeout) * 1000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new SetupError(`--timeout 要是正的秒数：${values.timeout}`)
  if (!existsSync(SELFTEST_PAGE))
    throw new SetupError(`找不到 ${SELFTEST_PAGE}：先构建测试构建（pnpm --filter @nerve-office/web run build:e2e）`)
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
    say(`收到 ${signal}，停后端`)
    void stopServer(server).then(() => process.exit(130))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  let collector: Awaited<ReturnType<typeof startCollector>> | undefined
  try {
    await waitUntilReady(origin, server)
    const scene = await selftestScene('safari')
    const steps = selftestSteps(scene)
    collector = await startCollector(collectorOrigin => chainOf(steps, origin, collectorOrigin))
    const first = collector.chain[0]
    if (first === undefined)
      throw new SetupError('没有要跑的步骤')
    say(`收集端 ${collector.origin}；在 Safari 里（${values.front ? '带到前台' : '后台'}）打开第一步，共 ${steps.length} 步，最多等 ${timeoutMs / 1000} 秒`)
    try {
      execFileSync('open', [...(values.front ? [] : ['-g']), '-a', 'Safari', first.url])
    }
    catch (error) {
      throw new SetupError(`Safari 打不开：${error instanceof Error ? error.message : String(error)}`)
    }
    await waitForResults(collector, steps.length, timeoutMs)
    const { received } = collector
    const outcomes = steps.map((step, index) => outcomeOf(step, received.get(index)))
    const stored = await checkServer(steps)
    const exitCode = exitCodeOf(outcomes, stored.problems)
    mkdirSync(RESULTS_DIR, { recursive: true })
    const file = `${RESULTS_DIR}${resultFileName(startedAt)}`
    writeFileSync(file, `${JSON.stringify({
      tool: 'tests/e2e/safari/selftest.ts',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      safari,
      macos,
      origin,
      exitCode,
      server: stored,
      steps: outcomes,
    }, null, 2)}\n`)
    printSummary(outcomes, stored.problems)
    say(`结果写在 ${file}；退出码 ${exitCode}`)
    return exitCode
  }
  finally {
    await collector?.close()
    await stopServer(server)
  }
}

main().then(code => process.exit(code), (error: unknown) => {
  say(error instanceof SetupError ? error.message : `出错：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(SETUP_FAILED)
})

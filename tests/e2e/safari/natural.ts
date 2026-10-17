// 原生窗口条件下的自然调度观察；不发 STOP、不改页面可见性、不拦截心跳。
// NODE_OPTIONS=--conditions=@nerve-office/source node safari/natural.ts --mode minimize|hide|space --profile-proof <json> --owned-pages <json> --from <精确当前任务URL> --output <新目录>
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { ActivityWatch } from './desktop.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { selftestEditorUrl } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { databaseUrl, e2eDatabaseName, pickFreePort } from '../support/environment.ts'
import { createNaturalObservation } from '../support/natural-observation.ts'
import { PAUSE_CLOUD_HASH, PAUSE_CONTENT_HASH, pauseCloudState, pauseRequestEvidence } from '../support/pause-evidence.ts'
import { selftestScene, serverProblemsOf } from '../support/selftest-plan.ts'
import { runPausedHolder } from '../support/selftest-request.ts'
import { settleCrashCleanup } from './crash-cleanup.ts'
import { hidIdleSeconds, screenLocked, watchActivity } from './desktop.ts'
import { startPauseProxy } from './pause-proxy.ts'
import { captureProfilePage, compileProfileNative, parseProfileProof } from './profile-adapter.ts'
import { claimProfile } from './profile-claim.ts'
import { createProfileContinuity, parseOwnedPages } from './profile-continuity.ts'
import { identifyProfilePage } from './profile-process.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const { values } = parseArgs({ options: Object.fromEntries(['mode', 'profile-proof', 'owned-pages', 'from', 'output'].map(key => [key, { type: 'string' as const }])), strict: true })
function inputs(): Record<string, string> {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'tests/e2e/support', 'tests/e2e/safari', 'tests/shared', 'pnpm-lock.yaml', 'package.json'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  for (const directory of ['apps/web/dist-e2e', 'apps/api/dist', 'packages/contracts/dist']) {
    for (const file of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (file.isFile())
        paths.push(relative(root, join(file.parentPath, file.name)))
    }
  }
  return Object.fromEntries([...new Set(paths)].filter(Boolean).sort().map(path => [path, hash(readFileSync(join(root, path)))]))
}
const navigate = `function run(a) {
  const s=Application('Safari'), windows=s.windows();
  if(windows.length!==1) throw Error('not exclusive');
  const w=windows[0], tabs=w.tabs();
  if(w.id()!==Number(a[0]) || !w.name().startsWith(a[1]+' — ') || tabs.length!==1 || tabs[0].url()!==a[2]) throw Error('binding changed');
  tabs[0].url=a[3]; s.activate();
  return JSON.stringify({windowId:w.id(),from:a[2],to:a[3],at:Date.now()});
}`

async function main(): Promise<void> {
  const { mode, from } = values
  const uid = process.getuid?.()
  if (process.platform !== 'darwin' || uid === undefined || mode === undefined || !['minimize', 'hide', 'space'].includes(mode) || from === undefined || values['profile-proof'] === undefined || values['owned-pages'] === undefined || values.output === undefined || process.env.NERVE_TEST_DATABASE_URL === undefined)
    throw new Error('需要明确自然条件、专用场景/页面清单、当前任务 URL、新目录与测试数据库')
  const output = resolve(values.output)
  mkdirSync(output, { mode: 0o700 })
  const proofBytes = readFileSync(values['profile-proof'])
  const profile = parseProfileProof(JSON.parse(proofBytes.toString('utf8')))
  const ledgerPath = resolve(values['owned-pages'])
  let ledger = parseOwnedPages(JSON.parse(readFileSync(ledgerPath, 'utf8')))
  if (!ledger.valid || !ledger.urls.includes(from))
    throw new Error('当前页不在有效任务清单中')
  const continuity = createProfileContinuity(profile, ledger)
  const originalInputs = inputs()
  writeFileSync(join(output, 'inputs.json'), JSON.stringify(originalInputs), { mode: 0o600 })
  const runId = randomUUID()
  const report: Record<string, unknown> = { kind: 'real-safari-natural-observation', runId, mode, startedAt: Date.now(), outcome: 'unverified', profile, profileProofSha256: hash(proofBytes), signalsSent: 0, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
  const writeReport = (): void => writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  writeReport()
  const deadline = Date.now() + 15 * 60_000
  const binary = join(output, 'profile-native')
  const fixtureBinary = join(output, 'natural-window')
  let proxy: Awaited<ReturnType<typeof startPauseProxy>> | undefined
  let backend: ChildProcess | undefined
  let fixture: ChildProcess | undefined
  let fixtureExit: Promise<number | null> | undefined
  const fixtureEvents: Record<string, unknown>[] = []
  let watcher: ActivityWatch | undefined
  let session: ReturnType<typeof createNaturalObservation> | undefined
  let claim: ReturnType<typeof claimProfile> | undefined
  let invalid: string | undefined
  let restored = false
  let continuous = false
  let checkContinuity: (() => void) | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  const interrupt = (): void => {
    invalid ??= '本次运行被中止'
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const guard = (): void => {
    if (Date.now() >= deadline || (backend !== undefined && (backend.exitCode !== null || backend.signalCode !== null)))
      invalid ??= '超过时限或后端提前退出'
    if (watcher !== undefined && (watcher.returnedAt() !== undefined || screenLocked() || (hidIdleSeconds() ?? 0) < 120))
      invalid ??= '用户活动、锁屏或空闲证据失效'
    if (session?.snapshot().phase === 'failed' || fixtureEvents.some(event => ['failed', 'deadline', 'restore-failed'].includes(String(event.kind))))
      invalid ??= '页面或窗口条件失败'
    if (invalid !== undefined)
      throw new Error(invalid)
    checkContinuity?.()
  }
  const stopFixture = async (): Promise<void> => {
    if (fixture === undefined || restored)
      return
    fixture.stdin?.end('restore\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    const code = await Promise.race([fixtureExit, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('窗口恢复回执超时')), 30_000)
    })]).finally(() => clearTimeout(timer))
    restored = true
    if (code !== 0 || !fixtureEvents.some(event => event.kind === 'restored') || !fixtureEvents.some(event => event.kind === 'finished' && event.success === true))
      throw new Error('窗口没有完整恢复')
  }
  try {
    claim = claimProfile(ledgerPath, runId)
    compileProfileNative(binary)
    execFileSync('swiftc', [join(root, 'tests/e2e/safari/natural-window.swift'), '-o', fixtureBinary], { timeout: 60_000 })
    report.fixtureSha256 = hash(readFileSync(fixtureBinary))
    report.safariVersion = execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
    report.macosVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    const mainPids = execFileSync('pgrep', ['-x', 'Safari'], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
    if (mainPids.length !== 1 || mainPids[0] === undefined || !Number.isSafeInteger(mainPids[0]) || mainPids[0] <= 1)
      throw new Error('Safari 主进程不唯一')
    const mainPid = mainPids[0]
    const port = await pickFreePort()
    const backendOrigin = `http://127.0.0.1:${port}`
    proxy = await startPauseProxy({ runId, backendOrigin })
    process.env.E2E_DATABASE_URL = databaseUrl(e2eDatabaseName(process.pid))
    backend = spawn(process.execPath, [fileURLToPath(new URL('../support/serve.ts', import.meta.url))], { env: { ...process.env, E2E_PORT: String(port), E2E_BASE_URL: proxy.origin }, stdio: ['pipe', 'ignore', 'inherit'] })
    backend.on('error', () => {
      invalid ??= '后端启动失败'
    })
    const readyDeadline = Date.now() + 60_000
    for (;;) {
      guard()
      try {
        if ((await fetch(`${backendOrigin}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).ok)
          break
      }
      catch { /* 独立时限与退出检查。 */ }
      if (Date.now() >= readyDeadline)
        throw new Error('后端未就绪')
      await delay(500)
    }
    const scene = await selftestScene('sf-natural', [{ id: 'paused-local-holder', scenario: 'paused-local-holder', role: 'author', sample: 'template' }])
    const step = scene.steps[0]!
    const controlUrl = `${proxy.origin}${proxy.controlPath}`
    session = createNaturalObservation({ runId, documentId: step.documentId, userId: scene.author.id, contentHash: PAUSE_CONTENT_HASH, cloudHash: PAUSE_CLOUD_HASH, deadline, waitForWindow: mode === 'space' })
    const currentSession = session
    proxy.configure({ documentId: step.documentId, entryFragment: new URLSearchParams({ user: scene.author.username, password: scene.author.password, document: step.documentId, scenario: step.scenario, next: controlUrl }).toString(), receive: (message, at) => currentSession.receive(message, at) })
    const context = { url: selftestEditorUrl(proxy.origin, step.documentId, step.scenario, controlUrl), uid, mainPid, profile, deadline }
    report.documentId = step.documentId
    report.userId = scene.author.id
    report.url = context.url
    ledger = { ...ledger, urls: [...new Set([...ledger.urls, proxy.startUrl, `${proxy.origin}${proxy.entryPath}`, `${proxy.origin}/selftest.html`, context.url])] }
    const saveLedger = (): void => writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    saveLedger()
    const capture = (url = context.url) => {
      const snapshot = captureProfilePage(binary, { ...context, url }, () => watcher?.returnedAt() !== undefined, ledger.urls)
      if (!continuity.accept(snapshot.windows)) {
        ledger = { ...ledger, valid: false }
        saveLedger()
        throw new Error('任务场景连续性失效')
      }
      return snapshot
    }
    capture(from)
    report.navigation = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', navigate, String(profile.windowId), profile.name, from, proxy.startUrl], { encoding: 'utf8', timeout: 5000 }))
    process.stdout.write(`Safari 自然观察 ${mode}：等待已绑定页面与 120 秒空闲\n`)
    for (;;) {
      guard()
      const landing = capture(proxy.startUrl)
      if (identifyProfilePage({ ...context, url: proxy.startUrl }, landing, Date.now()).kind === 'identified') {
        report.landing = landing
        break
      }
      await delay(1000)
    }
    watcher = watchActivity()
    let lastCapture = 0
    checkContinuity = () => {
      if (Date.now() - lastCapture >= 1000) {
        capture()
        lastCapture = Date.now()
      }
    }
    monitor = setInterval(() => {
      try {
        guard()
      }
      catch {
        invalid ??= '连续条件失效'
      }
    }, 1000)
    const currentProxy = proxy
    const run = await runPausedHolder({ origin: proxy.origin, documentId: step.documentId, holder: scene.author, requester: scene.peer, deadline, expectSuspended: true, stage: {
      open: async () => {
        guard()
        currentProxy.arm()
      },
      hide: async () => {
        guard()
        fixture = spawn(fixtureBinary, [mode, profile.name, String(profile.windowId), String(mainPid), context.url], { stdio: ['pipe', 'pipe', 'inherit'] })
        fixtureExit = new Promise(resolve => fixture!.once('exit', code => resolve(code)))
        fixture.on('error', () => {
          invalid ??= '窗口夹具无法启动'
        })
        let pending = ''
        fixture.stdout?.on('data', (bytes: Buffer) => {
          pending += bytes.toString('utf8')
          for (;;) {
            const lineEnd = pending.indexOf('\n')
            if (lineEnd < 0)
              break
            try {
              fixtureEvents.push(JSON.parse(pending.slice(0, lineEnd)) as Record<string, unknown>)
            }
            catch {
              invalid ??= '窗口回执无法解析'
            }
            pending = pending.slice(lineEnd + 1)
          }
        })
        const until = Date.now() + 20_000
        while (!fixtureEvents.some(event => event.kind === 'hidden')) {
          guard()
          if (Date.now() > until || fixture.exitCode !== null)
            throw new Error('未确认自然窗口条件')
          await delay(100)
        }
        if (mode === 'space' && !currentSession.confirmWindowReady(Date.now()))
          throw new Error('真实 Space 完成回执未被会话接受')
      },
      show: stopFixture,
      report: async (until) => {
        while (currentSession.snapshot().report === undefined && Date.now() < until) {
          guard()
          await delay(100)
        }
        return currentSession.snapshot().report
      },
      voided: () => {
        try {
          guard()
        }
        catch {
          invalid ??= '本轮条件失效'
        }
        return invalid
      },
      say: message => process.stdout.write(`${message}\n`),
    } })
    report.request = pauseRequestEvidence(run)
    guard()
    report.cloudAfter = await pauseCloudState(step.documentId)
    if (typeof run.report?.facts?.copyDocumentId === 'string')
      report.copy = await pauseCloudState(run.report.facts.copyDocumentId)
    // 自然观察沿用旧持有者的两条服务端判据；不放宽正式受控暂停只接受失权的定义。
    const server = await serverProblemsOf({ ...step, scenario: 'paused-holder' }, run.report?.path)
    const problems = [...run.judgement.problems, ...server.problems, ...currentProxy.evidence().problems]
    if (currentSession.snapshot().local === undefined || currentSession.snapshot().report === undefined)
      problems.push('缺少本机写成或页面完整报告')
    report.problems = problems
    const finalSnapshot = capture()
    continuous = identifyProfilePage(context, finalSnapshot, Date.now()).kind === 'identified'
    report.finalSnapshot = finalSnapshot
    if (problems.length > 0 || !continuous)
      throw new Error('独立页面/数据库/HTTP/最终窗口证据不完整')
    report.outcome = 'observed'
  }
  catch {
    report.failure = invalid ?? '本轮准备、窗口或结果核对失败；查看原始回执'
    process.exitCode = 1
  }
  finally {
    if (monitor !== undefined)
      clearInterval(monitor)
    const cleanup = await settleCrashCleanup([
      { name: '恢复任务窗口', run: stopFixture },
      { name: '活动监测', run: () => watcher?.stop() },
      { name: '同源代理', run: async () => proxy?.close() },
      { name: '独占后端', run: async () => {
        if (backend === undefined)
          return
        let forced = false
        if (backend.exitCode === null && backend.signalCode === null) {
          const ended = new Promise<void>(resolve => backend!.once('exit', () => resolve()))
          backend.stdin?.end()
          const timer = setTimeout(() => {
            forced = true
            backend!.kill('SIGKILL')
          }, 30_000)
          await ended
          clearTimeout(timer)
        }
        report.backendStop = { exitCode: backend.exitCode, signal: backend.signalCode, forced }
        copyFileSync(fileURLToPath(new URL('../test-results/e2e-server.log', import.meta.url)), join(output, 'server.log'))
        if (backend.exitCode !== 0 || forced)
          throw new Error('后端没有正常退出')
      } },
      { name: '输入摘要', run: () => {
        report.sourceUnchanged = JSON.stringify(inputs()) === JSON.stringify(originalInputs)
        if (report.sourceUnchanged !== true)
          throw new Error('实测期间输入发生改变')
      } },
    ])
    report.cleanupFailures = cleanup
    report.fixtureEvents = fixtureEvents
    report.session = session?.snapshot()
    report.finishedAt = Date.now()
    if (cleanup.length > 0) {
      report.outcome = 'unverified'
      process.exitCode = 1
    }
    writeReport()
    try {
      report.profileClaimReleased = claim?.release({ completed: report.outcome === 'observed', continuous, cleanupSucceeded: cleanup.length === 0 }) ?? false
    }
    catch {
      report.profileClaimReleaseFailed = true
      report.outcome = 'unverified'
      process.exitCode = 1
    }
    writeReport()
    process.stdout.write(`${JSON.stringify({ output, outcome: report.outcome, failure: report.failure, sourceUnchanged: report.sourceUnchanged, cleanupFailures: cleanup })}\n`)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}
main().catch(() => {
  process.stderr.write('Safari 自然观察无法初始化；核对参数、专用场景与新输出目录。\n')
  process.exitCode = 1
})

// 真实 Safari 的本机保存正式测量。只导航已经绑定的任务页，不发送进程信号。
// NODE_OPTIONS=--conditions=@nerve-office/source node safari/local-save.ts --sample 1m|5m|perf-50k --network online|offline --profile-proof <json> --owned-pages <json> --from <精确任务URL> --output <新目录>
import type { LocalSaveConfig } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import type { ActivityWatch } from './desktop.ts'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, totalmem } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { summarizeLocalSaves } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import { selftestEditorUrl } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { bulkSampleFor, perfSampleFor } from '../support/capture-samples.ts'
import { createDocument, createUser } from '../support/database.ts'
import { createLocalSaveDriver } from '../support/local-save-driver.ts'
import { startLocalSaveEnvironment } from '../support/local-save-environment.ts'
import { readLocalSaveCloud } from '../support/local-save-evidence.ts'
import { createLocalSaveSession } from '../support/local-save-session.ts'
import { managedOutputPath, requireManagedReport } from '../support/managed-output.ts'
import { settleCrashCleanup } from './crash-cleanup.ts'
import { hidIdleSeconds, screenLocked, watchActivity } from './desktop.ts'
import { captureProfilePage, compileProfileNative, parseProfileProof } from './profile-adapter.ts'
import { claimProfile } from './profile-claim.ts'
import { createProfileContinuity, parseOwnedPages } from './profile-continuity.ts'
import { identifyProfilePage } from './profile-process.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const { values } = parseArgs({ options: Object.fromEntries(['sample', 'network', 'profile-proof', 'owned-pages', 'from', 'output'].map(key => [key, { type: 'string' as const }])), strict: true })
function inputs(): Record<string, string> {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'tests/e2e/support', 'tests/e2e/safari', 'tests/shared', 'pnpm-lock.yaml', 'package.json'], { cwd: root, encoding: 'utf8' }).split('\0')
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
  const { sample, network, from } = values
  const uid = process.getuid?.()
  if (process.platform !== 'darwin' || uid === undefined || sample === undefined || !['1m', '5m', 'perf-50k'].includes(sample) || (network !== 'online' && network !== 'offline') || from === undefined || values['profile-proof'] === undefined || values['owned-pages'] === undefined || values.output === undefined)
    throw new Error('需要三种指定样本之一、网络条件、专用场景/页面清单、精确当前任务 URL 和新输出目录')
  if (screenLocked())
    throw new Error('屏幕锁定，不能开始真实 Safari 操作')
  const config: LocalSaveConfig = { sample: sample as LocalSaveConfig['sample'], network, rounds: 20 }
  const output = resolve(values.output)
  requireManagedReport(output)
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
  const report: Record<string, unknown> = {
    kind: 'real-safari-local-save',
    runId,
    config,
    startedAt: Date.now(),
    outcome: 'unverified',
    profile,
    profileProofSha256: hash(proofBytes),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    host: { arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version },
  }
  const writeReport = (): void => writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  writeReport()
  const deadline = Date.now() + 45 * 60_000
  const binary = join(output, 'profile-native')
  let environment: Awaited<ReturnType<typeof startLocalSaveEnvironment>> | undefined
  let watcher: ActivityWatch | undefined
  let session: ReturnType<typeof createLocalSaveSession> | undefined
  let driver: ReturnType<typeof createLocalSaveDriver> | undefined
  let claim: ReturnType<typeof claimProfile> | undefined
  let invalid: string | undefined
  let continuous = false
  let checkContinuity: (() => void) | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  let lastCheck = 0
  const desktop: { at: number, idleSeconds: number, locked: boolean }[] = []
  const interrupt = (): void => {
    invalid ??= '本次运行被中止'
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const guard = (): void => {
    if (Date.now() >= deadline || (environment !== undefined && !environment.healthy()))
      invalid ??= '超过总时限或独占后端提前退出'
    if (watcher !== undefined && Date.now() - lastCheck >= 1000) {
      lastCheck = Date.now()
      const idleSeconds = hidIdleSeconds() ?? -1
      const locked = screenLocked()
      desktop.push({ at: Date.now(), idleSeconds, locked })
      if (watcher.returnedAt() !== undefined || locked || idleSeconds < 120)
        invalid ??= '用户活动、锁屏或空闲证据失效'
      checkContinuity?.()
    }
    if (invalid !== undefined)
      throw new Error(invalid)
  }
  try {
    report.stage = 'compile-and-profile'
    claim = claimProfile(ledgerPath, runId)
    compileProfileNative(binary)
    report.nativeSha256 = hash(readFileSync(binary))
    report.safariVersion = execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
    report.macosVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    const mainPids = execFileSync('pgrep', ['-x', 'Safari'], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
    if (mainPids.length !== 1 || mainPids[0] === undefined || !Number.isSafeInteger(mainPids[0]) || mainPids[0] <= 1)
      throw new Error('Safari 主进程不唯一')
    const mainPid = mainPids[0]
    report.stage = 'environment-and-fixtures'
    environment = await startLocalSaveEnvironment(runId)
    const { proxy } = environment
    const author = await createUser('sf-local-save')
    const snapshotFor = config.sample === 'perf-50k' ? perfSampleFor : bulkSampleFor(config.sample === '1m' ? 1024 * 1024 : 5 * 1024 * 1024)
    const documentId = await createDocument(author, 'S4 Safari 本机保存实测', snapshotFor)
    const baseline = await readLocalSaveCloud(documentId)
    const controlUrl = `${proxy.origin}${proxy.controlPath}`
    const scenario = `local-save-${network}` as const
    session = createLocalSaveSession({ runId, documentId, userId: author.id, config, baseRevision: baseline.revision, baseHash: baseline.snapshotHash, deadline })
    const currentSession = session
    driver = createLocalSaveDriver({ config, documentId, userId: author.id, baseline, session, proxy })
    proxy.configure({ documentId, entryFragment: new URLSearchParams({ user: author.username, password: author.password, document: documentId, scenario, next: controlUrl }).toString(), receive: (message, at) => currentSession.receive(message, at) })
    const context = { url: selftestEditorUrl(proxy.origin, documentId, scenario, controlUrl), uid, mainPid, profile, deadline }
    report.documentId = documentId
    report.userId = author.id
    report.baseline = baseline
    report.templateBytes = new TextEncoder().encode(snapshotFor('measure-unit')).byteLength
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
    report.stage = 'navigate-owned-page'
    capture(from)
    if (screenLocked())
      throw new Error('导航之前屏幕锁定')
    report.navigation = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', navigate, String(profile.windowId), profile.name, from, proxy.startUrl], { encoding: 'utf8', timeout: 5000 }))
    process.stdout.write(`Safari ${sample} ${network}：等待已绑定任务页和连续空闲 120 秒\n`)
    report.stage = 'idle-and-landing'
    const idleDeadline = Date.now() + 30 * 60_000
    for (;;) {
      guard()
      if (screenLocked())
        throw new Error('空闲准备期间屏幕锁定')
      const landing = capture(proxy.startUrl)
      const idle = hidIdleSeconds()
      if (idle !== undefined && idle >= 120 && identifyProfilePage({ ...context, url: proxy.startUrl }, landing, Date.now()).kind === 'identified') {
        report.landing = landing
        report.idleAtStart = idle
        break
      }
      if (Date.now() >= idleDeadline)
        throw new Error('未在准备时限内取得空闲与任务页证明')
      await delay(1000)
    }
    watcher = watchActivity()
    checkContinuity = () => {
      capture()
    }
    monitor = setInterval(() => {
      try {
        guard()
      }
      catch { invalid ??= '桌面或窗口连续监测失败' }
    }, 1000)
    guard()
    report.measureStartedAt = Date.now()
    report.stage = 'measurement'
    report.monitorIntervalMs = 1000
    report.loadBefore = loadavg()
    proxy.arm()
    await driver.run(Math.min(deadline, Date.now() + 15 * 60_000), guard)
    guard()
    report.loadAfter = loadavg()
    report.measureFinishedAt = Date.now()
    const state = session.snapshot()
    if (state.phase !== 'passed')
      throw new Error('页面、逐轮数据库或应用传输核对未通过')
    report.stage = 'final-binding'
    const finalSnapshot = capture()
    continuous = identifyProfilePage(context, finalSnapshot, Date.now()).kind === 'identified'
    report.finalSnapshot = finalSnapshot
    if (!continuous)
      throw new Error('最终任务窗口身份没有得到确认')
    report.summary = summarizeLocalSaves(state.samples)
    report.stage = 'complete'
    report.outcome = 'passed'
  }
  catch {
    report.failure = invalid ?? '本轮准备、页面或独立核对失败；查看原始回执'
    process.exitCode = 1
  }
  finally {
    if (monitor !== undefined)
      clearInterval(monitor)
    report.session = session?.snapshot()
    report.hostEvidence = driver?.snapshot()
    report.desktop = desktop
    const cleanup = await settleCrashCleanup([
      { name: '活动监测', run: () => watcher?.stop() },
      { name: '本组应用代理与后端', run: async () => environment?.close() },
      { name: '后端日志', run: () => {
        if (environment !== undefined)
          copyFileSync(managedOutputPath('e2e-server.log'), join(output, 'server.log'))
      } },
      { name: '输入摘要', run: () => {
        report.sourceUnchanged = JSON.stringify(inputs()) === JSON.stringify(originalInputs)
        if (report.sourceUnchanged !== true)
          throw new Error('实测期间输入发生改变')
      } },
    ])
    report.cleanupFailures = cleanup
    report.finishedAt = Date.now()
    if (cleanup.length > 0) {
      report.outcome = 'unverified'
      process.exitCode = 1
    }
    writeReport()
    try {
      report.profileClaimReleased = claim?.release({ completed: report.outcome === 'passed', continuous, cleanupSucceeded: cleanup.length === 0 }) ?? false
    }
    catch {
      report.profileClaimReleaseFailed = true
      report.outcome = 'unverified'
      process.exitCode = 1
    }
    writeReport()
    process.stdout.write(`${JSON.stringify({ output, outcome: report.outcome, sourceUnchanged: report.sourceUnchanged, cleanupFailures: cleanup })}\n`)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}
main().catch(() => {
  process.stderr.write('Safari 保存测量无法初始化；核对解锁状态、参数、专用场景与新输出目录。\n')
  process.exitCode = 1
})

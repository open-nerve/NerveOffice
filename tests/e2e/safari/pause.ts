// 真实 Safari 持久草稿暂停复核。页面必须已放进经本机 UI 核实、从创建起独占的专用场景。
// NODE_OPTIONS=--conditions=@nerve-office/source node safari/pause.ts --profile-proof <json> --owned-pages <json> --output <新目录> --pause-owned-page
// 不给 --pause-owned-page 时只检查等待页的两次完整归属和原生资格，不启动编辑或发送 STOP。
import type { ChildProcess } from 'node:child_process'
import type { ActivityWatch, Cover } from './desktop.ts'
import type { ProfilePageContext, ProfilePageSnapshot } from './profile-process.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { selftestEditorUrl } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { databaseUrl, e2eDatabaseName, pickFreePort } from '../support/environment.ts'
import { managedOutputPath, requireManagedReport } from '../support/managed-output.ts'
import { PAUSE_CLOUD_HASH, PAUSE_CONTENT_HASH, pauseCloudState, pauseRequestEvidence, pauseServerProblems } from '../support/pause-evidence.ts'
import { createLocalPauseSession } from '../support/pause-session.ts'
import { selftestScene, serverProblemsOf } from '../support/selftest-plan.ts'
import { runPausedHolder } from '../support/selftest-request.ts'
import { settleCrashCleanup } from './crash-cleanup.ts'
import { hidIdleSeconds, processAlive, screenLocked, startCover, watchActivity } from './desktop.ts'
import { startPauseProxy } from './pause-proxy.ts'
import { captureProfilePage, checkProfileSignal, compileProfileNative, parseProfileProof, readProfileIdentities } from './profile-adapter.ts'
import { claimProfile } from './profile-claim.ts'
import { createProfileContinuity, parseOwnedPages } from './profile-continuity.ts'
import { compileProfilePause, startProfilePause } from './profile-pause-adapter.ts'
import { createProfilePauseRun } from './profile-pause-run.ts'
import { identifyProfilePage, revalidateProfilePage } from './profile-process.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const { values } = parseArgs({ options: { 'profile-proof': { type: 'string' }, 'owned-pages': { type: 'string' }, 'output': { type: 'string' }, 'pause-owned-page': { type: 'boolean', default: false } }, strict: true })
class CheckError extends Error {}
function say(message: string): void {
  process.stdout.write(`Safari 暂停复核：${message}\n`)
}

/** 包括未提交源码与实际构建；实测期间任何相关输入变化都使结果失效。 */
function inputManifest(): Record<string, string> {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps', 'packages', 'tests/e2e/support', 'tests/e2e/safari', 'tests/shared', 'pnpm-lock.yaml', 'package.json'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
  for (const directory of ['apps/web/dist-e2e', 'apps/api/dist', 'packages/contracts/dist']) {
    for (const file of readdirSync(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (file.isFile())
        paths.push(relative(root, join(file.parentPath, file.name)))
    }
  }
  return Object.fromEntries([...new Set(paths)].filter(path => path !== '').sort().map(path => [path, hash(readFileSync(join(root, path)))]))
}

async function stopBackend(child: ChildProcess) {
  let forced = false
  if (child.exitCode === null && child.signalCode === null) {
    const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.stdin?.end()
    const timer = setTimeout(() => {
      forced = true
      child.kill('SIGKILL')
    }, 30_000)
    await ended
    clearTimeout(timer)
  }
  return { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, forced }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || values['profile-proof'] === undefined || values['owned-pages'] === undefined || values.output === undefined || process.env.NERVE_TEST_DATABASE_URL === undefined)
    throw new CheckError('需要 macOS、测试维护库、明确的创建/历史证明及新报告目录')
  const output = resolve(values.output)
  requireManagedReport(output)
  mkdirSync(dirname(output), { recursive: true })
  mkdirSync(output, { mode: 0o700 })
  const startedAt = Date.now()
  const deadline = startedAt + 15 * 60_000
  const runId = randomUUID()
  const proofBytes = readFileSync(values['profile-proof'])
  const profile = parseProfileProof(JSON.parse(proofBytes.toString('utf8')))
  const ledgerPath = resolve(values['owned-pages'])
  const ledgerBytes = readFileSync(ledgerPath)
  let ledger = parseOwnedPages(JSON.parse(ledgerBytes.toString('utf8')))
  const continuity = createProfileContinuity(profile, ledger)
  const inputs = inputManifest()
  writeFileSync(join(output, 'inputs.json'), `${JSON.stringify(inputs, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const report: Record<string, unknown> = { kind: 'real-safari-local-draft-pause', runId, startedAt, pauseRequested: values['pause-owned-page'], outcome: 'unverified', profile, profileProofSha256: hash(proofBytes), ownedPagesSha256: hash(ledgerBytes), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
  const writeReport = (): void => {
    writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  writeReport()
  const temporaryLedger = `${ledgerPath}.${runId}.tmp`
  const saveLedger = (): void => {
    writeFileSync(temporaryLedger, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'w', mode: 0o600 })
    renameSync(temporaryLedger, ledgerPath)
  }
  const binary = join(output, 'profile-native')
  const pauseBinary = join(output, 'profile-pause-native')
  let claim: ReturnType<typeof claimProfile> | undefined
  let proxy: Awaited<ReturnType<typeof startPauseProxy>> | undefined
  let backend: ChildProcess | undefined
  let watching: ActivityWatch | undefined
  let cover: Cover | undefined
  let session: ReturnType<typeof createLocalPauseSession> | undefined
  let native: ReturnType<typeof createProfilePauseRun> | undefined
  let backendFailed = false
  let interrupted = false
  let stage = '准备'
  let checkContinuity: (() => void) | undefined
  let verifyEnd: (() => void) | undefined
  let continuousAtEnd = false
  let voidReason: string | undefined
  const interrupt = (): void => {
    interrupted = true
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const guard = (): void => {
    if (interrupted || Date.now() >= deadline)
      throw new CheckError('已中止或超过本轮总时限')
    if (backendFailed || (backend !== undefined && (backend.exitCode !== null || backend.signalCode !== null)))
      throw new CheckError('本次独占后端提前退出')
    if (watching !== undefined && (watching.returnedAt() !== undefined || screenLocked() || (hidIdleSeconds() ?? 0) < 120))
      throw new CheckError('用户返回、锁屏或空闲无法持续确认')
    if (session?.snapshot().phase === 'failed')
      throw new CheckError('页面或阶段证据未通过')
    const end = native?.snapshot().finished
    if (end !== undefined && end.reason !== 'requested')
      throw new CheckError('独立守护已异常恢复，本轮作废')
    if (native?.snapshot().inProgress !== true)
      checkContinuity?.()
  }
  const voided = (): string | undefined => {
    try {
      guard()
    }
    catch {
      voidReason ??= '桌面、页面、守护或本轮连续性失效'
    }
    if (cover?.outcome() !== undefined && cover.outcome() !== 'stopped')
      voidReason ??= '盖屏窗口被中止或提前结束'
    return voidReason
  }
  const stopCover = async (): Promise<void> => {
    if (cover !== undefined) {
      const outcome = await cover.stop()
      report.cover = { pid: cover.pid, outcome, left: processAlive(cover.pid) }
      if (outcome !== 'stopped' || processAlive(cover.pid))
        throw new CheckError('盖屏没有按本轮正常请求结束')
    }
  }
  try {
    claim = claimProfile(ledgerPath, runId)
    report.profileClaim = claim.path
    compileProfileNative(binary)
    compileProfilePause(pauseBinary)
    report.nativeSha256 = hash(readFileSync(binary))
    report.pauseNativeSha256 = hash(readFileSync(pauseBinary))
    report.safariVersion = execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8', timeout: 5000 }).trim()
    report.macosVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).trim()
    const mainPids = execFileSync('pgrep', ['-x', 'Safari'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/).map(Number)
    const mainPid = mainPids[0]
    if (mainPids.length !== 1 || mainPid === undefined || !Number.isSafeInteger(mainPid) || mainPid <= 1)
      throw new CheckError('Safari 主进程不唯一')
    const mainBefore = readProfileIdentities(binary, [mainPid])[0]
    if (mainBefore?.bundleId !== 'com.apple.Safari' || mainBefore.uid !== process.getuid?.())
      throw new CheckError('Safari 主进程内核身份不符')
    report.mainBefore = mainBefore
    const port = await pickFreePort()
    const backendOrigin = `http://127.0.0.1:${port}`
    proxy = await startPauseProxy({ runId, backendOrigin })
    process.env.E2E_DATABASE_URL = databaseUrl(e2eDatabaseName(process.pid))
    backend = spawn(process.execPath, [fileURLToPath(new URL('../support/serve.ts', import.meta.url))], { env: { ...process.env, E2E_PORT: String(port), E2E_BASE_URL: proxy.origin }, stdio: ['pipe', 'ignore', 'inherit'] })
    backend.once('error', () => {
      backendFailed = true
    })
    const serverDeadline = Date.now() + 60_000
    for (;;) {
      guard()
      try {
        if ((await fetch(`${backendOrigin}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).ok)
          break
      }
      catch { /* 启动受独立期限和后端退出检查约束。 */ }
      if (Date.now() >= serverDeadline)
        throw new CheckError('后端未在一分钟内就绪')
      await delay(500)
    }
    const scene = await selftestScene('sf-local-pause', [{ id: 'paused-local-holder', scenario: 'paused-local-holder', role: 'author', sample: 'template' }])
    const step = scene.steps[0]
    if (step === undefined)
      throw new CheckError('未生成本轮测试文档')
    const controlUrl = `${proxy.origin}${proxy.controlPath}`
    const documentId = step.documentId
    session = createLocalPauseSession({ mode: 'native', runId, documentId, userId: scene.author.id, contentHash: PAUSE_CONTENT_HASH, cloudHash: PAUSE_CLOUD_HASH, deadline })
    const currentSession = session
    proxy.configure({ documentId, entryFragment: new URLSearchParams({ user: scene.author.username, password: scene.author.password, document: documentId, scenario: step.scenario, next: controlUrl }).toString(), receive: (message, at) => currentSession.receive(message, at) })
    const context: ProfilePageContext = { url: selftestEditorUrl(proxy.origin, documentId, step.scenario, controlUrl), uid: process.getuid(), mainPid, profile, deadline }
    report.documentId = documentId
    report.userId = scene.author.id
    ledger = { ...ledger, urls: [...new Set([...ledger.urls, proxy.startUrl, `${proxy.origin}${proxy.entryPath}`, `${proxy.origin}/selftest.html`, context.url])] }
    saveLedger()
    const capture = (url = context.url): ProfilePageSnapshot => {
      const snapshot = captureProfilePage(binary, { ...context, url }, () => watching?.returnedAt() !== undefined, ledger.urls)
      if (!continuity.accept(snapshot.windows)) {
        ledger = { ...ledger, valid: false }
        saveLedger()
        throw new CheckError('专用场景历史连续性永久失效')
      }
      return snapshot
    }
    stage = '等待专用页面与两分钟空闲'
    say(`在经核实的专用场景窗口打开 ${proxy.startUrl}`)
    for (;;) {
      guard()
      const landing = capture(proxy.startUrl)
      if (identifyProfilePage({ ...context, url: proxy.startUrl }, landing, Date.now()).kind === 'identified') {
        report.landing = landing
        break
      }
      await delay(2000)
    }
    watching = watchActivity()
    let lastCaptureAt = Date.now()
    checkContinuity = () => {
      if (Date.now() - lastCaptureAt >= 1000) {
        capture()
        lastCaptureAt = Date.now()
      }
    }
    if (!values['pause-owned-page']) {
      const landingContext = { ...context, url: proxy.startUrl }
      const first = identifyProfilePage(landingContext, capture(proxy.startUrl), Date.now())
      if (first.kind !== 'identified')
        throw new CheckError(first.reason)
      const second = revalidateProfilePage(first.target, landingContext, capture(proxy.startUrl), Date.now())
      if (second.kind !== 'identified')
        throw new CheckError(second.reason)
      report.nativeCheck = checkProfileSignal(binary, landingContext, second.target)
      report.outcome = 'checked-only'
      const landingUrl = proxy.startUrl
      verifyEnd = () => {
        capture(landingUrl)
        continuousAtEnd = true
      }
      return
    }
    native = createProfilePauseRun(context, { capture, now: Date.now, start: () => startProfilePause(pauseBinary, join(output, 'guardian.ndjson')) })
    const currentNative = native
    const currentProxy = proxy
    verifyEnd = () => {
      const end = currentNative.capture()
      const before = currentNative.snapshot().before
      const target = currentNative.snapshot().target
      const matched = identifyProfilePage(context, end, Date.now())
      if (matched.kind !== 'identified' || matched.target.pid !== target?.pid || matched.target.startedAtUs !== target.startedAtUs
        || JSON.stringify(before?.windows.filter(window => window.windowId !== profile.windowId)) !== JSON.stringify(end.windows.filter(window => window.windowId !== profile.windowId))
        || JSON.stringify(mainBefore) !== JSON.stringify(readProfileIdentities(binary, [mainPid])[0])) {
        throw new CheckError('恢复后的目标或其他 Safari 窗口/主进程发生变化')
      }
      report.finalSnapshot = end
      continuousAtEnd = true
    }
    stage = '持有者保存与暂停'
    const run = await runPausedHolder({ origin: proxy.origin, documentId, holder: scene.author, requester: scene.peer, deadline, expectSuspended: true, stage: {
      open: async () => {
        guard()
        currentProxy.arm()
      },
      hide: async () => {
        guard()
        cover = startCover(240, 'NerveOffice 暂停恢复验证（约 2 分钟）；按 Esc 或点这里中止')
      },
      pause: async () => {
        const until = Date.now() + 60_000
        while (currentSession.snapshot().phase !== 'ready') {
          guard()
          if (Date.now() >= until)
            throw new CheckError('没有在期限内取得第三格持久证据')
          await delay(100)
        }
        guard()
        const cloud = await pauseCloudState(documentId)
        report.cloudBefore = cloud
        if (!currentSession.authorizePause(cloud, Date.now()))
          throw new CheckError('暂停前云端已偏离两格或页面准备无效')
        guard()
        const stopped = await currentNative.stop()
        if (!currentSession.paused(stopped, Date.now()))
          throw new CheckError('内核停止回执不能推进本轮阶段')
        currentProxy.observe()
        say(`内核已确认专用页面 PID ${stopped.target.pid} 停止；等待真实租约到期与协作者接手`)
      },
      show: async () => {
        await stopCover()
        if (currentNative.snapshot().stopped !== undefined) {
          const end = currentNative.snapshot().finished ?? await currentNative.resume()
          if (!currentSession.resumed(end, Date.now()))
            throw new CheckError('本轮不是已确认的正常恢复')
          say('内核确认原进程已恢复，等待失权说明、旧保存拒绝和完整副本')
        }
      },
      report: async (until) => {
        while (currentSession.snapshot().report === undefined && Date.now() < until) {
          guard()
          await delay(100)
        }
        return currentSession.snapshot().report
      },
      voided,
      say,
    } })
    stage = '独立服务端核对'
    guard()
    report.request = pauseRequestEvidence(run)
    report.cloudAfter = await pauseCloudState(documentId)
    const copyId = run.report?.facts?.copyDocumentId
    if (typeof copyId !== 'string')
      throw new CheckError('页面没有给出本轮副本身份')
    const copy = await pauseCloudState(copyId)
    report.copy = { documentId: copyId, ...copy }
    const server = await serverProblemsOf(step, run.report?.path)
    const evidence = currentNative.snapshot()
    const problems = [...server.problems, ...pauseServerProblems(run, { holderId: scene.author.id, native: true, pausedAt: evidence.stopped?.at ?? 0, resumedAt: evidence.finished?.continueAt ?? 0 }), ...currentProxy.evidence().problems]
    if (copy.revision !== 1 || copy.contentHash !== PAUSE_CONTENT_HASH)
      problems.push('独立数据库原件中的副本不是完整三格或修订不符')
    report.problems = problems
    if (!currentSession.finish(problems, Date.now()))
      throw new CheckError('独立 HTTP、数据库、副本或页面证据未通过')
    guard()
    verifyEnd()
    report.outcome = 'passed'
    say('本轮受控暂停与恢复证据齐全，正在归档和清理')
  }
  catch (error) {
    report.failure = { stage, reason: error instanceof CheckError ? error.message : '底层操作未取得完整证据', errorType: error instanceof Error ? error.name : 'unknown' }
    session?.fail('本次驱动失败或中止')
    process.exitCode = 1
    say(`${stage}未通过，先恢复再收尾，失败原件保留`)
  }
  finally {
    const cleanup = await settleCrashCleanup([
      { name: '独立暂停守护', run: async () => { await native?.settle() } },
      { name: '盖屏窗口', run: stopCover },
      { name: '最终页面连续性', run: () => {
        if (report.outcome === 'passed' || report.outcome === 'checked-only') {
          if (watching?.returnedAt() !== undefined || verifyEnd === undefined)
            throw new CheckError('没有连续有效的最终归属')
          verifyEnd()
        }
      } },
      { name: '活动监测', run: () => watching?.stop() },
      { name: '同源代理', run: async () => proxy?.close() },
      { name: '后端与独占测试库', run: async () => {
        if (backend !== undefined) {
          const stopped = await stopBackend(backend)
          report.backendStop = stopped
          copyFileSync(managedOutputPath('e2e-server.log'), join(output, 'server.log'))
          if (stopped.exitCode !== 0 || stopped.forced)
            throw new CheckError('后端未正常退出')
        }
      } },
      { name: '源码与构建原件', run: () => {
        report.sourceUnchanged = JSON.stringify(inputManifest()) === JSON.stringify(inputs)
        if (report.sourceUnchanged !== true)
          throw new CheckError('本轮源或构建输入发生变化')
      } },
    ])
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    report.cleanupFailures = cleanup
    report.native = native?.snapshot()
    report.session = session?.snapshot()
    report.http = proxy?.evidence()
    report.finishedAt = Date.now()
    if (cleanup.length > 0) {
      report.outcome = 'unverified'
      process.exitCode = 1
    }
    writeReport()
    try {
      report.profileClaimReleased = claim?.release({ completed: report.outcome === 'passed' || report.outcome === 'checked-only', continuous: continuousAtEnd, cleanupSucceeded: cleanup.length === 0 }) ?? false
    }
    catch {
      report.outcome = 'unverified'
      report.profileClaimReleaseFailed = true
      process.exitCode = 1
    }
    writeReport()
    say(`原件：${output}`)
  }
}

main().catch(() => {
  process.stderr.write('Safari 暂停复核无法初始化；检查参数、独占输出目录、测试维护库与本机证明。\n')
  process.exitCode = 1
})

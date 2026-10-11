// 真实 Safari 原页进程崩溃复核。先经 UI 把等待页放进已有的专用 profile；不自动选用户窗口、不启用远程自动化。
// 用法：NODE_OPTIONS=--conditions=@nerve-office/source node safari/crash.ts --profile-proof <创建证明.json> --owned-pages <本机已知页面.json> --output <新报告.json> [--kill-owned-page]
// 不给 --kill-owned-page 时只做同一套归属/原生临发检查，报告 checked-only，不声称崩溃恢复通过。
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { ActivityWatch } from './desktop.ts'
import type { ProfilePageContext, ProfilePageSnapshot } from './profile-process.ts'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { selftestEditorUrl } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { createCrashSession } from '../support/crash-session.ts'
import { createDocument, createUser, withDatabase } from '../support/database.ts'
import { databaseUrl, e2eDatabaseName, pickFreePort } from '../support/environment.ts'
import { settleCrashCleanup } from './crash-cleanup.ts'
import { startCrashProxy } from './crash-proxy.ts'
import { hidIdleSeconds, screenLocked, watchActivity } from './desktop.ts'
import { captureProfilePage, checkProfileSignal, compileProfileNative, createProfileExecutor, parseProfileProof, readProfileIdentities, signalProfilePage } from './profile-adapter.ts'
import { claimProfile } from './profile-claim.ts'
import { createProfileContinuity, parseOwnedPages } from './profile-continuity.ts'
import { identifyProfilePage, revalidateProfilePage } from './profile-process.ts'

const CONTENT = 'Safari 页面崩溃前已持久保存的正文'
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function say(message: string): void {
  process.stdout.write(`Safari 崩溃复核：${message}\n`)
}
const { values } = parseArgs({ options: { 'profile-proof': { type: 'string' }, 'owned-pages': { type: 'string' }, 'output': { type: 'string' }, 'kill-owned-page': { type: 'boolean', default: false } }, strict: true })

class CheckError extends Error {}

async function stopBackend(child: ChildProcess) {
  let forced = false
  const result = () => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, forced })
  if (child.exitCode !== null || child.signalCode !== null)
    return result()
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.stdin?.end()
  const timer = setTimeout(() => {
    forced = true
    child.kill('SIGKILL')
  }, 30_000)
  await stopped
  clearTimeout(timer)
  return result()
}

async function cloudState(documentId: string) {
  return withDatabase(async (client) => {
    const row = (await client.query<{ revision: number, snapshot: Buffer }>('SELECT d.revision, c.snapshot FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1', [documentId])).rows[0]
    if (row === undefined)
      throw new CheckError('本次测试文档不存在')
    // 独立解压数据库原件，不使用页面报告或恢复器的内存正文作为服务器证据。
    const book = JSON.parse(gunzipSync(row.snapshot).toString('utf8')) as { sheetOrder: string[], sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }> }
    const value = book.sheets[book.sheetOrder[0] ?? '']?.cellData?.[0]?.[0]?.v
    return { revision: row.revision, contentHash: sha256(typeof value === 'string' ? value : '') }
  })
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || values['profile-proof'] === undefined || values['owned-pages'] === undefined || values.output === undefined || process.env.NERVE_TEST_DATABASE_URL === undefined)
    throw new CheckError('需要 macOS、明确的测试维护库、创建/已知页面证明和新报告路径')
  const startedAt = Date.now()
  const deadline = startedAt + 15 * 60_000
  const output = resolve(values.output)
  const proofBytes = readFileSync(values['profile-proof'])
  const profile = parseProfileProof(JSON.parse(proofBytes.toString('utf8')))
  const ledgerPath = resolve(values['owned-pages'])
  const ledgerBytes = readFileSync(ledgerPath)
  let ledger = parseOwnedPages(JSON.parse(ledgerBytes.toString('utf8')))
  const continuity = createProfileContinuity(profile, ledger)
  const runId = randomUUID()
  const report: Record<string, unknown> = { kind: 'real-safari-page-crash', runId, startedAt, profileProofSha256: sha256(proofBytes), ownedPagesSha256: sha256(ledgerBytes), profile, killRequested: values['kill-owned-page'], outcome: 'unverified', signalAttempted: false, signalsSent: 0 }
  // 先证实报告可写且不覆盖旧原件；失败时还没有启动任何资源。
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const temporaryLedger = `${ledgerPath}.${runId}.tmp`
  const saveLedger = (): void => {
    writeFileSync(temporaryLedger, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryLedger, ledgerPath)
  }
  const temporary = mkdtempSync(join(tmpdir(), 'nerve-safari-crash-'))
  const binary = join(temporary, 'profile-native')
  let proxy: Awaited<ReturnType<typeof startCrashProxy>> | undefined
  let backend: ChildProcess | undefined
  let watching: ActivityWatch | undefined
  let session: ReturnType<typeof createCrashSession> | undefined
  let claim: ReturnType<typeof claimProfile> | undefined
  let verifyEnd: (() => void) | undefined
  let continuousAtEnd = false
  let stage = '准备'
  let interrupted = false
  let backendFailed = false
  let checkContinuity: (() => void) | undefined
  const interrupt = (): void => {
    interrupted = true
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const guard = (): void => {
    if (interrupted || Date.now() >= deadline)
      throw new CheckError('运行被中止或超过总时限')
    if (backendFailed || (backend !== undefined && (backend.exitCode !== null || backend.signalCode !== null)))
      throw new CheckError('本次后端提前退出')
    if (watching !== undefined && (watching.returnedAt() !== undefined || screenLocked() || (hidIdleSeconds() ?? 0) < 120))
      throw new CheckError('用户返回、屏幕锁定或无法证明持续空闲，本次作废')
    if (session?.snapshot().phase === 'failed')
      throw new CheckError('页面报告未满足崩溃恢复验证条件')
    checkContinuity?.()
  }
  try {
    // 在原生编译/后端启动前持久占用。任何异常默认留下占用，不依赖后续失效写盘成功。
    claim = claimProfile(ledgerPath, runId)
    report.profileClaim = claim.path
    compileProfileNative(binary)
    report.nativeSha256 = sha256(readFileSync(binary))
    report.safariVersion = execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8', timeout: 5000 }).trim()
    report.macosVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).trim()
    const mainPids = execFileSync('pgrep', ['-x', 'Safari'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\s+/).map(Number)
    const mainPid = mainPids[0]
    if (mainPids.length !== 1 || mainPid === undefined || !Number.isSafeInteger(mainPid) || mainPid <= 1)
      throw new CheckError('无法唯一识别 Safari 主进程')
    const mainBefore = readProfileIdentities(binary, [mainPid])[0]
    if (mainBefore?.bundleId !== 'com.apple.Safari' || mainBefore.uid !== process.getuid?.())
      throw new CheckError('Safari 主进程的只读基线身份不符')
    report.mainBefore = mainBefore
    const backendPort = await pickFreePort()
    const backendOrigin = `http://127.0.0.1:${backendPort}`
    proxy = await startCrashProxy({ runId, backendOrigin })
    process.env.E2E_DATABASE_URL = databaseUrl(e2eDatabaseName(process.pid))
    backend = spawn(process.execPath, [fileURLToPath(new URL('../support/serve.ts', import.meta.url))], {
      env: { ...process.env, E2E_PORT: String(backendPort), E2E_BASE_URL: proxy.origin },
      stdio: ['pipe', 'ignore', 'inherit'],
    })
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
      catch {
        // 服务尚未启动；仍受退出检查和截止时刻约束。
      }
      if (Date.now() >= serverDeadline)
        throw new CheckError('后端未在一分钟内就绪')
      await delay(500)
    }
    const owner = await createUser('safari-page-crash')
    const documentId = await createDocument(owner, 'Safari 原页进程崩溃恢复')
    const controlUrl = `${proxy.origin}${proxy.controlPath}`
    session = createCrashSession({ mode: 'process-kill', runId, documentId, userId: owner.id, contentHash: sha256(CONTENT), deadline })
    const currentSession = session
    proxy.configure({ documentId, entryFragment: new URLSearchParams({ user: owner.username, password: owner.password, document: documentId, scenario: 'crash-recovery', next: controlUrl }).toString(), receive: (message, now) => currentSession.receive(message, now) })
    report.documentId = documentId
    report.userId = owner.id
    const context: ProfilePageContext = { url: selftestEditorUrl(proxy.origin, documentId, 'crash-recovery', controlUrl), uid: process.getuid(), mainPid, profile, deadline }
    // 只追加驱动自己生成的测试地址。selftest 的凭证片段从不写进清单或报告。
    ledger = { ...ledger, urls: [...new Set([...ledger.urls, proxy.startUrl, `${proxy.origin}${proxy.entryPath}`, `${proxy.origin}/selftest.html`, context.url])] }
    saveLedger()
    const requireContinuity = (snapshot: ProfilePageSnapshot): void => {
      if (!continuity.accept(snapshot.windows)) {
        ledger = { ...ledger, valid: false }
        report.continuityViolation = snapshot
        saveLedger()
        throw new CheckError('出现未知页面或场景绑定矛盾，本机历史证明已永久失效')
      }
    }
    stage = '等待专用场景与桌面空闲'
    say(`请在已核实的专用场景窗口打开 ${proxy.startUrl}`)
    let landing: ProfilePageSnapshot
    for (;;) {
      guard()
      landing = captureProfilePage(binary, { ...context, url: proxy.startUrl }, () => false, ledger.urls)
      requireContinuity(landing)
      if (identifyProfilePage({ ...context, url: proxy.startUrl }, landing, Date.now()).kind === 'identified')
        break
      await delay(2000)
    }
    report.landing = landing
    watching = watchActivity()
    let lastContinuityAt = Date.now()
    checkContinuity = () => {
      if (Date.now() - lastContinuityAt >= 1000) {
        requireContinuity(captureProfilePage(binary, context, () => watching?.returnedAt() !== undefined, ledger.urls))
        lastContinuityAt = Date.now()
      }
    }
    guard()
    proxy.arm()
    say('专用页面与两分钟空闲已确认，等待真实 Worker 持久完成')
    stage = '等待正文持久就绪'
    const prepareDeadline = Date.now() + 120_000
    while (session.snapshot().phase !== 'ready') {
      guard()
      if (Date.now() >= prepareDeadline)
        throw new CheckError('两分钟内没有取得正文持久证据')
      await delay(100)
    }
    guard()
    const cloudBefore = await cloudState(documentId)
    report.cloudBefore = cloudBefore
    if (cloudBefore.revision !== 1 || cloudBefore.contentHash === sha256(CONTENT))
      throw new CheckError('崩溃前正文已经上传，不能证明本机恢复')
    const returned = (): boolean => watching?.returnedAt() !== undefined
    const capture = (): ProfilePageSnapshot => {
      const snapshot = captureProfilePage(binary, context, returned, ledger.urls)
      requireContinuity(snapshot)
      return snapshot
    }
    verifyEnd = () => {
      if (interrupted || watching?.returnedAt() !== undefined)
        throw new CheckError('本轮活动或中止使历史连续性不再成立')
      const finalSnapshot = capture()
      report.finalSnapshot = finalSnapshot
      if (identifyProfilePage(context, finalSnapshot, Date.now()).kind !== 'identified')
        throw new CheckError('收尾时无法再次确认场景、桌面和进程归属')
      continuousAtEnd = true
    }
    const before = capture()
    report.before = before
    const identified = identifyProfilePage(context, before, Date.now())
    if (identified.kind !== 'identified')
      throw new CheckError(identified.reason)
    const target = identified.target
    report.target = target
    stage = '临发前复核'
    guard()
    if (!values['kill-owned-page']) {
      const second = capture()
      report.second = second
      const decision = revalidateProfilePage(target, context, second, Date.now())
      if (decision.kind !== 'identified')
        throw new CheckError(decision.reason)
      report.nativeCheck = checkProfileSignal(binary, context, decision.target)
      report.outcome = 'checked-only'
      say('原生临发检查完成，零信号；未执行崩溃恢复')
      return
    }
    const execute = createProfileExecutor(context, { capture: () => {
      const snapshot = capture()
      report.second = snapshot
      return snapshot
    }, now: Date.now, send: (target) => {
      guard()
      report.signalAttempted = true
      return signalProfilePage(binary, context, target)
    } })
    // 执行器同步返回前事件循环不会处理新页的 boot；只有实际原生收据成功才切换会话阶段。
    const result = execute(target)
    report.second = result.snapshot
    report.signal = result.receipt
    report.signalsSent = 1
    if (!session.signaled(result.receipt.sentAt))
      throw new CheckError('实际信号收据未能进入恢复阶段')
    proxy.observeRecovery()
    say(`已结束专用测试页 PID ${target.pid}，等待 Safari 自行重载和恢复`)
    stage = '确认旧页面进程退出'
    const exitDeadline = Date.now() + 5000
    while (readProfileIdentities(binary, [target.pid]).some(current => current.startedAtUs === target.startedAtUs)) {
      guard()
      if (Date.now() >= exitDeadline)
        throw new CheckError('信号后仍能读到旧页面进程身份')
      await delay(50)
    }
    report.oldProcessGoneAt = Date.now()
    stage = '观察 Safari 自动重载恢复'
    const recoveryDeadline = Date.now() + 120_000
    while (session.snapshot().phase !== 'restored') {
      guard()
      if (Date.now() >= recoveryDeadline)
        throw new CheckError('Safari 未在两分钟内自行重载并完成恢复')
      await delay(100)
    }
    guard()
    const after = capture()
    report.after = after
    const replacement = identifyProfilePage(context, after, Date.now())
    if (replacement.kind !== 'identified' || replacement.target.startedAtUs === target.startedAtUs)
      throw new CheckError('没有取得同一原标签页的新进程身份')
    const otherBefore = before.windows.filter(window => window.windowId !== profile.windowId)
    const otherAfter = after.windows.filter(window => window.windowId !== profile.windowId)
    const mainAfter = readProfileIdentities(binary, [mainPid])[0]
    report.mainAfter = mainAfter
    if (JSON.stringify(otherBefore) !== JSON.stringify(otherAfter) || JSON.stringify(mainBefore) !== JSON.stringify(mainAfter))
      throw new CheckError('既有用户窗口或 Safari 主进程身份发生变化')
    const http = proxy.evidence()
    const cloud = await cloudState(documentId)
    report.http = http
    report.cloud = cloud
    if (http.problems.length > 0)
      throw new CheckError('真实 HTTP 观察不完整')
    if (session.finish({ ...cloud, ...http }, Date.now()).length > 0)
      throw new CheckError('原身份普通申请、正文或单次修订核对失败')
    guard()
    report.outcome = 'passed'
    say('真实进程崩溃、自动恢复、原身份普通申请与唯一一次保存全部通过')
  }
  catch (error) {
    report.failure = { stage, reason: error instanceof CheckError ? error.message : '底层操作失败，未取得完整验证证据', errorType: error instanceof Error ? error.name : 'unknown' }
    session?.cancel('本次驱动验证失败或中止')
    // 原生调用报错时不能把“没有收据”冒充“没有信号”；不重试。
    if (report.signalAttempted === true && report.signal === undefined)
      report.signalsSent = 'unknown'
    process.exitCode = 1
    say(`${stage}失败；原件保留，未重复尝试信号`)
  }
  finally {
    report.session = session?.snapshot()
    report.http ??= proxy?.evidence()
    const cleanupFailures = await settleCrashCleanup([
      { name: '活动监测', run: () => watching?.stop() },
      { name: '同源代理', run: async () => proxy?.close() },
      { name: '后端与测试库', run: async () => {
        if (backend !== undefined) {
          const stopped = await stopBackend(backend)
          report.backendStop = stopped
          if (stopped.exitCode !== 0 || stopped.forced)
            throw new CheckError('后端没有正常退出')
        }
      } },
      { name: '场景最终连续性', run: () => {
        if (report.outcome === 'passed' || report.outcome === 'checked-only') {
          if (verifyEnd === undefined)
            throw new CheckError('缺少本次运行的最终连续性读取器')
          verifyEnd()
        }
      } },
      { name: '临时执行器', run: () => rmSync(temporary, { recursive: true, force: true }) },
      { name: '历史清单临时文件', run: () => rmSync(temporaryLedger, { force: true }) },
      { name: '信号监听器', run: () => {
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', interrupt)
      } },
    ])
    report.cleanupFailures = cleanupFailures
    if (cleanupFailures.length > 0) {
      report.outcome = 'unverified'
      process.exitCode = 1
    }
    report.finishedAt = Date.now()
    // 写报告在所有回收尝试之后；即使这里失败，也不会遗留已启动的资源。
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    try {
      // 只有结果已经落档、清理完整且连续性再确认，才解除占用；失败/中止的 claim 保留。
      report.profileClaimReleased = claim?.release({ completed: report.outcome === 'passed' || report.outcome === 'checked-only', continuous: continuousAtEnd, cleanupSucceeded: cleanupFailures.length === 0 }) ?? false
    }
    catch {
      report.outcome = 'unverified'
      report.profileClaimReleaseFailed = true
      process.exitCode = 1
    }
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    say(`报告：${output}`)
  }
}

main().catch(() => {
  process.stderr.write('Safari 崩溃复核无法初始化，请检查参数、测试维护库与本机证明文件。\n')
  process.exitCode = 1
})

// 客体 OS 突停后的真实产品恢复；手动实验，不进入 CI。
// NODE_OPTIONS=--conditions=@nerve-office/source node tools/vm-product-recovery.ts QUALIFICATION.json chrome|edge|safari OUTPUT HELPER
import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { VmBoot } from '../support/vm-durability.ts'
import type { VmBrowser, VmGuestResource } from '../support/vm-guest.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { settleCrashCleanup } from '../safari/crash-cleanup.ts'
import { startCrashProxy } from '../safari/crash-proxy.ts'
import { createCrashSession } from '../support/crash-session.ts'
import { createDocument, createUser, withDatabase } from '../support/database.ts'
import { databaseUrl, e2eDatabaseName, pickFreePort } from '../support/environment.ts'
import { startOwnedVm } from '../support/owned-vm-process.ts'
import { connectVmGuest } from '../support/vm-guest.ts'
import { freezeVmJournal } from '../support/vm-journal-barrier.ts'
import { createVmJournal } from '../support/vm-probe-server.ts'

const CONTENT = 'Safari 页面崩溃前已持久保存的正文'
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function cloudState(documentId: string) {
  return withDatabase(async (client) => {
    const row = (await client.query<{ revision: number, snapshot: Buffer }>('SELECT d.revision, c.snapshot FROM documents d JOIN document_contents c ON c.document_id = d.id WHERE d.id = $1', [documentId])).rows[0]
    assert(row !== undefined, '本次测试文档不存在')
    const book = JSON.parse(gunzipSync(row.snapshot).toString('utf8')) as { sheetOrder: string[], sheets: Record<string, { cellData?: Record<string, Record<string, { v?: unknown }>> }> }
    const value = book.sheets[book.sheetOrder[0] ?? '']?.cellData?.[0]?.[0]?.v
    return { revision: row.revision, contentHash: digest(typeof value === 'string' ? value : '') }
  })
}

async function stopBackend(child: ChildProcess) {
  let forced = false
  if (child.pid === undefined)
    return { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, forced, spawnFailed: true }
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.stdin?.end()
    const timer = setTimeout(() => {
      forced = true
      child.kill('SIGKILL')
    }, 30_000)
    await exited
    clearTimeout(timer)
  }
  return { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, forced }
}

async function main(): Promise<void> {
  const [qualificationPath, browserArg, outputArg, helperArg] = process.argv.slice(2)
  assert(qualificationPath !== undefined && outputArg !== undefined && helperArg !== undefined && ['chrome', 'edge', 'safari'].includes(browserArg ?? ''), '需要资格报告、正式浏览器、独占输出目录和原生 helper')
  assert(process.env.NERVE_TEST_DATABASE_URL !== undefined, '必须显式提供专用测试维护库')
  const qualification = JSON.parse(await readFile(qualificationPath, 'utf8')) as { qualified: boolean, resource: VmGuestResource, boots: readonly { boot: VmBoot }[] }
  assert(qualification.qualified && qualification.boots.length === 2 && qualification.boots[0]!.boot.guestBootId !== qualification.boots[1]!.boot.guestBootId, '客体没有两次独立开机资格')
  const resource = qualification.resource
  const browser = browserArg as VmBrowser
  const output = resolve(outputArg)
  const helper = resolve(helperArg)
  await mkdir(output, { recursive: false, mode: 0o700 })
  process.env.E2E_DATABASE_URL = databaseUrl(e2eDatabaseName(process.pid))
  let vm: Awaited<ReturnType<typeof startOwnedVm>> | undefined
  let guest: Awaited<ReturnType<typeof connectVmGuest>> | undefined
  let boot: VmBoot | undefined
  let generation = 0
  const results: unknown[] = []
  async function start() {
    vm = await startOwnedVm(resource, { helper, log: join(resource.directory, `product-${browser}-${Date.now()}-${generation++}.log`) })
    guest = await connectVmGuest(resource)
    boot = vm.registerGuestBoot(guest.bootId)
    report({ stage: 'booted', browser, boot })
  }
  try {
    await start()
    for (let index = 0; index < 3; index++) {
      assert(vm !== undefined && guest !== undefined && boot !== undefined)
      const before = boot
      const runId = randomUUID()
      const directory = join(output, `${index}-${runId}`)
      await mkdir(directory, { mode: 0o700 })
      const journal = await createVmJournal(join(directory, 'journal.jsonl'))
      const backendPort = await pickFreePort()
      const backendOrigin = `http://127.0.0.1:${backendPort}`
      const proxy = await startCrashProxy({ runId, backendOrigin })
      let backend: ChildProcess | undefined
      let backendFailed = false
      let session: ReturnType<typeof createCrashSession> | undefined
      let tunnel: Awaited<ReturnType<typeof guest.forward>> | undefined
      let stage = 'backend'
      let evidence: Record<string, unknown> = { mode: 'vm-power-cut', browser, index, runId, before, initialCloudUpload: 'held-test-build', recovery: 'explicit-confirmation', outcome: 'unverified' }
      try {
        const fd = openSync(join(directory, 'backend-driver.log'), 'wx', 0o600)
        backend = spawn(process.execPath, [fileURLToPath(new URL('../support/serve.ts', import.meta.url))], { env: { ...process.env, E2E_PORT: String(backendPort), E2E_BASE_URL: proxy.origin }, stdio: ['pipe', 'ignore', fd] })
        closeSync(fd)
        backend.once('error', () => {
          backendFailed = true
        })
        const deadline = Date.now() + 15 * 60_000
        const guard = (): void => {
          assert(Date.now() < deadline, '本轮超过总时限')
          assert(!backendFailed && backend?.exitCode === null && backend.signalCode === null, '测试后端提前退出')
          assert(session?.snapshot().phase !== 'failed', '产品证据不满足恢复前提')
        }
        const serverDeadline = Date.now() + 60_000
        for (;;) {
          guard()
          try {
            if ((await fetch(`${backendOrigin}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).ok)
              break
          }
          catch { /* 后端启动受独立期限及进程存活约束。 */ }
          assert(Date.now() < serverDeadline, '后端未在一分钟内就绪')
          await delay(500)
        }
        const owner = await createUser('vm-product-recovery')
        const documentId = await createDocument(owner, '客体突停后的本机恢复')
        session = createCrashSession({ mode: 'vm-power-cut', beforeVm: before, runId, documentId, userId: owner.id, contentHash: digest(CONTENT), deadline })
        const currentSession = session
        proxy.configure({ documentId, entryFragment: new URLSearchParams({ user: owner.username, password: owner.password, document: documentId, scenario: 'crash-recovery', next: `${proxy.origin}${proxy.controlPath}` }).toString(), receive: (message, now) => {
          const http = proxy.evidence()
          return currentSession.receive(message, now, { acquires: http.acquires.length, saves: http.saves.length })
        } })
        evidence = { ...evidence, documentId, userId: owner.id, url: proxy.startUrl }
        stage = 'prepare'
        tunnel = await guest.forward(proxy.startUrl, join(directory, 'ssh-before.log'))
        proxy.arm()
        await guest.open(browser, proxy.startUrl)
        const prepareDeadline = Date.now() + 180_000
        while (session.snapshot().phase !== 'ready') {
          guard()
          assert(Date.now() < prepareDeadline, '没有取得 Worker/OPFS 和独立解密的完成证据')
          await delay(25)
        }
        guard()
        const cloudBefore = await cloudState(documentId)
        assert(cloudBefore.revision === 1 && cloudBefore.contentHash !== digest(CONTENT), '突停前正文已经上传')
        guard()
        stage = 'freeze-and-stop'
        const ready = session.snapshot().ready
        assert(ready?.mirror !== undefined, '缺少实际镜像完成证据')
        const receipt = await freezeVmJournal({ kind: 'product-ready', runId, mode: 'vm-power-cut', before, ready, cloudBefore, at: Date.now() }, journal.append, Date.now)
        evidence = { ...evidence, cloudBefore, ready, frozen: receipt }
        guard()
        const stopped = await vm.killAfter(receipt)
        evidence = { ...evidence, stopped, journalToSignalMs: stopped.signal.sentAt - receipt.journaledAt }
        await journal.append({ kind: 'vm-stopped', ...stopped, journalToSignalMs: evidence.journalToSignalMs })
        await tunnel.close()
        tunnel = undefined
        report({ stage: 'stopped', browser, index, runId, journalToSignalMs: evidence.journalToSignalMs })
        stage = 'restart'
        await start()
        assert(guest !== undefined && boot !== undefined)
        const proof = { before, after: boot, signal: 'SIGKILL', exited: true } as const
        guard()
        assert(session.vmRestarted(proof, Date.now()), '原磁盘重启证明不符合产品会话')
        await journal.append({ kind: 'vm-restarted', proof, at: Date.now() })
        evidence = { ...evidence, after: boot }
        proxy.observeRecovery()
        proxy.allowRecoveryEntry()
        tunnel = await guest.forward(proxy.startUrl, join(directory, 'ssh-after.log'))
        await guest.open(browser, proxy.startUrl)
        stage = 'explicit-recovery'
        const recoveryDeadline = Date.now() + 180_000
        while (session.snapshot().phase !== 'restored') {
          guard()
          assert(Date.now() < recoveryDeadline, '重启后没有完成阅读与明确恢复')
          if (session.snapshot().phase === 'awaiting-confirmation') {
            const cloud = await cloudState(documentId)
            guard()
            const http = proxy.evidence()
            const reading = session.snapshot().awaiting
            evidence = { ...evidence, beforeConfirmation: { cloud, http, reading, at: Date.now() } }
            assert(http.problems.length === 0 && cloud.contentHash === cloudBefore.contentHash, '确认前 HTTP 不完整或云端发生变化')
            await journal.append({ kind: 'before-confirmation', cloud, http, reading, at: Date.now() })
            assert(session.authorizeConfirmation({ ...cloud, ...http }, Date.now()), '确认前不是原件/阅读/零申请保存')
          }
          await delay(25)
        }
        guard()
        const cloud = await cloudState(documentId)
        const http = proxy.evidence()
        evidence = { ...evidence, cloud, http }
        assert(http.problems.length === 0, '实际 HTTP 观察不完整')
        assert(session.finish({ ...cloud, ...http }, Date.now()).length === 0, '新身份、正文、唯一修订或草稿清理证据不符')
        await journal.append({ kind: 'passed', cloud, http, snapshot: session.snapshot(), at: Date.now() })
        evidence = { ...evidence, outcome: 'passed' }
        results.push({ runId, outcome: 'passed' })
        report({ stage: 'recovered', browser, index, runId })
      }
      catch (error) {
        evidence = { ...evidence, failure: { stage, reason: error instanceof Error ? error.message : '未知错误' } }
        throw error
      }
      finally {
        const failed = await settleCrashCleanup([
          { name: 'result', run: async () => writeFile(join(directory, 'result.json'), `${JSON.stringify({ ...evidence, snapshot: session?.snapshot() }, null, 2)}\n`, { flag: 'wx' }) },
          { name: 'tunnel', run: async () => tunnel?.close() },
          { name: 'proxy', run: proxy.close },
          { name: 'backend', run: async () => {
            if (backend === undefined)
              return
            const cleanup = await stopBackend(backend)
            await writeFile(join(directory, 'backend-cleanup.json'), `${JSON.stringify(cleanup)}\n`, { flag: 'wx' })
            await copyFile(fileURLToPath(new URL('../test-results/e2e-server.log', import.meta.url)), join(directory, 'backend.log'))
            assert(cleanup.exitCode === 0 && cleanup.signal === null && !cleanup.forced, '专用后端没有正常退出')
          } },
          { name: 'journal', run: journal.close },
        ])
        assert(failed.length === 0, `原件或收尾步骤失败：${failed.join(',')}`)
      }
    }
    await writeFile(join(output, 'completed.json'), `${JSON.stringify({ browser, kind: 'guest-os-product-recovery', results }, null, 2)}\n`, { flag: 'wx' })
  }
  finally {
    if (vm !== undefined) {
      await guest?.shutdown()
      let cleanup: unknown
      try {
        const exit = await vm.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null)
        cleanup = { kind: 'guest-normal-shutdown', exit }
      }
      catch {
        cleanup = { kind: 'owned-process-cleanup', storageExperiment: false, exit: await vm.stopForCleanup() }
      }
      await writeFile(join(output, 'cleanup.json'), `${JSON.stringify(cleanup)}\n`, { flag: 'wx' })
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'VM 产品恢复实验失败'}\n`)
  process.exitCode = 1
})

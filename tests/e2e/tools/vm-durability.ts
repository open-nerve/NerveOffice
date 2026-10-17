// 真实客体 OS 实验，手动调用，不进入 CI。先给资格报告，再选浏览器和轮次。
// node tools/vm-durability.ts QUALIFICATION.json chrome|edge|safari OUTPUT control|20 HELPER
import type { VmBoot } from '../support/vm-durability.ts'
import type { VmBrowser, VmGuestResource } from '../support/vm-guest.ts'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { settleCrashCleanup } from '../safari/crash-cleanup.ts'
import { startOwnedVm } from '../support/owned-vm-process.ts'
import { createVmDurabilityRound } from '../support/vm-durability.ts'
import { connectVmGuest } from '../support/vm-guest.ts'
import { vmProbeBytes } from '../support/vm-probe-page.ts'
import { createVmJournal, startVmProbeServer } from '../support/vm-probe-server.ts'

function report(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  const [qualificationPath, browserArg, outputArg, countArg, helperArg] = process.argv.slice(2)
  assert(qualificationPath !== undefined && outputArg !== undefined && helperArg !== undefined, '需要资格报告、浏览器、独占输出目录、轮次与原生 helper')
  assert(['chrome', 'edge', 'safari'].includes(browserArg ?? '') && ['control', '20'].includes(countArg ?? ''), '浏览器或轮次无效')
  const qualification = JSON.parse(await readFile(qualificationPath, 'utf8')) as { qualified: boolean, resource: VmGuestResource, boots: readonly { boot: VmBoot }[] }
  assert(qualification.qualified && qualification.boots.length === 2 && qualification.boots[0]!.boot.guestBootId !== qualification.boots[1]!.boot.guestBootId, '客体尚未通过两次独立开机资格')
  const resource = qualification.resource
  const browser = browserArg as VmBrowser
  const output = resolve(outputArg)
  const helper = resolve(helperArg)
  await mkdir(output, { recursive: false, mode: 0o700 })
  const results: unknown[] = []
  let vm: Awaited<ReturnType<typeof startOwnedVm>> | undefined
  let guest: Awaited<ReturnType<typeof connectVmGuest>> | undefined
  let boot: VmBoot | undefined
  let generation = 0
  async function start() {
    vm = await startOwnedVm(resource, { helper, log: join(resource.directory, `raw-${browser}-${Date.now()}-${generation++}.log`) })
    guest = await connectVmGuest(resource)
    boot = vm.registerGuestBoot(guest.bootId)
    report({ stage: 'booted', browser, boot })
  }

  async function until(round: ReturnType<typeof createVmDurabilityRound>, expected: readonly string[], timeout: number) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const phase = round.snapshot().phase
      if (expected.includes(phase))
        return
      if (phase === 'failed' || phase === 'lost' || phase === 'unreadable')
        throw new Error(`VM 实验提前终止：${phase}`)
      await delay(10)
    }
    throw new Error(`VM 实验等待 ${expected.join('/')} 超时`)
  }

  try {
    await start()
    for (let index = 0; index < (countArg === 'control' ? 1 : 20); index++) {
      assert(vm !== undefined && guest !== undefined && boot !== undefined)
      const mode = countArg === 'control' ? 'control' : 'vm-power-cut'
      const durability = index % 2 === 0 ? 'strict' : 'default'
      const runId = randomUUID()
      const directory = join(output, `${String(index).padStart(2, '0')}-${durability}-${runId}`)
      await mkdir(directory, { mode: 0o700 })
      const journal = await createVmJournal(join(directory, 'journal.jsonl'))
      const round = createVmDurabilityRound({ runId, mode, durability, cutAtSeq: 10, before: boot, digestFor: seq => createHash('sha256').update(vmProbeBytes(runId, seq)).digest('hex'), append: journal.append })
      const server = await startVmProbeServer({ round })
      let tunnel: Awaited<ReturnType<typeof guest.forward>> | undefined
      let evidence: Record<string, unknown> = { browser, resourceId: resource.resourceId, mode }
      try {
        const clock = await guest.clockSample()
        evidence = { ...evidence, clock, before: boot, url: server.url }
        tunnel = await guest.forward(server.url, join(directory, 'ssh-before.log'))
        await guest.open(browser, server.url)
        await until(round, ['ready'], 180_000)
        const receipt = await round.freeze()
        assert(receipt !== undefined, '宿主未取得持久冻结记录')
        if (mode === 'vm-power-cut') {
          const before = boot
          const stopped = await vm.killAfter(receipt)
          evidence = { ...evidence, stopped, journalToSignalMs: stopped.signal.sentAt - receipt.journaledAt, completionToSignalEstimateMs: { min: stopped.signal.sentAt - receipt.completed.completedAt - clock.offsetMax, max: stopped.signal.sentAt - receipt.completed.completedAt - clock.offsetMin }, clockQualification: '跨客体时钟区间仅是采样估计；可精确核对的是宿主接收/冻结/信号时序' }
          await journal.append({ kind: 'vm-stopped', ...stopped, journalToSignalMs: evidence.journalToSignalMs })
          await tunnel.close()
          tunnel = undefined
          report({ stage: 'stopped', browser, index, runId, durability, journalToSignalMs: evidence.journalToSignalMs })
          await start()
          assert(vm !== undefined && guest !== undefined && boot !== undefined)
          assert(await round.beginRecovery({ before, after: boot, signal: 'SIGKILL', exited: true }), '重启证明不通过')
          evidence = { ...evidence, after: boot }
          tunnel = await guest.forward(server.url, join(directory, 'ssh-after.log'))
        }
        else {
          assert(await round.beginCalibrationRecovery())
        }
        await guest.open(browser, server.url)
        await until(round, ['passed', 'lost', 'unreadable'], 180_000)
        if (round.snapshot().phase !== 'passed' && (durability === 'strict' || mode === 'control'))
          throw new Error('strict 或控制轮回读失败，保留原件并停止')
        results.push({ runId, durability, phase: round.snapshot().phase })
        report({ stage: 'read-back', browser, index, runId, durability, phase: round.snapshot().phase })
      }
      catch (error) {
        evidence = { ...evidence, error: error instanceof Error ? error.message : '未知错误' }
        if (resource.kind === 'qemu') {
          try {
            const diagnostics = await guest.run('sudo journalctl --no-pager -n 200 --output=short-iso -u \'nerve-vm-browser-*\' -u nerve-vm-xvfb', 15_000)
            await writeFile(join(directory, 'guest-browser.log'), diagnostics, { flag: 'wx' })
            const signals = await guest.run('sudo tail -n 400 /var/log/audit/audit.log', 30_000)
            await writeFile(join(directory, 'guest-signals.log'), signals, { flag: 'wx', mode: 0o600 })
          }
          catch {
            evidence = { ...evidence, guestDiagnosticsUnavailable: true }
          }
        }
        throw error
      }
      finally {
        const failed = await settleCrashCleanup([
          { name: 'result', run: async () => writeFile(join(directory, 'result.json'), `${JSON.stringify({ ...evidence, snapshot: round.snapshot() }, null, 2)}\n`, { flag: 'wx' }) },
          { name: 'tunnel', run: async () => tunnel?.close() },
          { name: 'server', run: server.close },
          { name: 'journal', run: journal.close },
        ])
        assert(failed.length === 0, `原件或收尾步骤失败：${failed.join(',')}`)
      }
    }
    await writeFile(join(output, 'completed.json'), `${JSON.stringify({ browser, kind: countArg === 'control' ? 'control' : 'guest-os-abrupt-stop', results }, null, 2)}\n`, { flag: 'wx' })
  }
  finally {
    if (vm !== undefined) {
      await guest?.shutdown()
      try {
        const exit = await vm.waitForExit(60_000)
        assert(exit.code === 0 && exit.signal === null, '最终清理没有正常关机证明')
        await writeFile(join(output, 'cleanup.json'), `${JSON.stringify({ kind: 'guest-normal-shutdown', exit })}\n`, { flag: 'wx' })
      }
      catch {
        const exit = await vm.stopForCleanup()
        await writeFile(join(output, 'cleanup.json'), `${JSON.stringify({ kind: 'owned-process-cleanup', storageExperiment: false, exit })}\n`, { flag: 'wx' })
      }
    }
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : 'VM 实验失败'}\n`)
  process.exitCode = 1
})

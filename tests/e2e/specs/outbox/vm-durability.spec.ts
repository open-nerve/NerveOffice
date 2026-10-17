// 仅校准页面/宿主证据协议；真实 VM 突停由独立工具执行，不把普通重载算成断电。
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expect, test } from '../../support/fixtures.ts'
import { createVmDurabilityRound, isVmFrozenReceipt } from '../../support/vm-durability.ts'
import { vmProbeBytes } from '../../support/vm-probe-page.ts'
import { createVmJournal, startVmProbeServer } from '../../support/vm-probe-server.ts'

test('US-M4-01 @test-build VM 读取故障校准：原生 UnknownError 单独落档为无法读取', async ({ page }, testInfo) => {
  const runId = crypto.randomUUID()
  const path = testInfo.outputPath('vm-journal.jsonl')
  await mkdir(dirname(path), { recursive: true })
  const journal = await createVmJournal(path)
  const round = createVmDurabilityRound({ runId, mode: 'reload-calibration', durability: 'strict', cutAtSeq: 1, digestFor: seq => createHash('sha256').update(vmProbeBytes(runId, seq)).digest('hex'), append: journal.append })
  const server = await startVmProbeServer({ round })
  try {
    await page.goto(server.url)
    await expect.poll(() => round.snapshot().phase).toBe('ready')
    await round.freeze()
    expect(await round.beginCalibrationRecovery()).toBe(true)
    await page.addInitScript(() => {
      // 故障注入只替换读取 API，不修改原存储，也不伪造 HTTP 回报。
      IDBObjectStore.prototype.get = () => {
        throw new DOMException('受控读取故障', 'UnknownError')
      }
    })
    await page.reload()
    await expect.poll(() => round.snapshot().phase).toBe('unreadable')
    await expect(page.locator('#status')).toHaveText('失败：read-transaction/UnknownError')
    expect(round.snapshot()).toMatchObject({ mode: 'reload-calibration', readFailure: { stage: 'read-transaction', errorName: 'UnknownError' }, completed: { seq: 1 } })
    await testInfo.attach('vm-read-failure-calibration', { body: JSON.stringify(round.snapshot()), contentType: 'application/json' })
    await testInfo.attach('vm-host-journal', { body: await readFile(path), contentType: 'application/jsonl' })
  }
  finally {
    await page.goto('about:blank')
    await server.close()
    await journal.close()
  }
})

for (const durability of ['strict', 'default'] as const) {
  test(`US-M4-01 @test-build VM 存储协议校准：${durability} 十次实际完成与原库只读回读`, async ({ page }, testInfo) => {
    const runId = crypto.randomUUID()
    const path = testInfo.outputPath('vm-journal.jsonl')
    await mkdir(dirname(path), { recursive: true })
    const journal = await createVmJournal(path)
    const round = createVmDurabilityRound({
      runId,
      mode: 'reload-calibration',
      durability,
      cutAtSeq: 10,
      digestFor: seq => createHash('sha256').update(vmProbeBytes(runId, seq)).digest('hex'),
      append: journal.append,
    })
    const server = await startVmProbeServer({ round })
    try {
      await page.addInitScript(() => {
        const calls: { mode: string | undefined, arguments: number, durability: string | undefined }[] = []
        Object.assign(window, { __vmTransactions: calls })
        // eslint-disable-next-line ts/unbound-method -- 保存原生方法，下面始终以实际数据库作为 this 调用，不改变事务参数。
        const original = IDBDatabase.prototype.transaction
        IDBDatabase.prototype.transaction = function (stores, mode, options) {
          calls.push({ mode, arguments: arguments.length, durability: options?.durability })
          return options === undefined ? original.call(this, stores, mode) : original.call(this, stores, mode, options)
        }
      })
      await page.goto(server.url)
      await expect.poll(() => round.snapshot().phase).toBe('ready')
      expect(round.snapshot().completed).toMatchObject({ seq: 10, requested: durability })
      const calls = await page.evaluate(() => (window as unknown as { __vmTransactions: { mode: string, arguments: number, durability?: string }[] }).__vmTransactions)
      const writes = calls.filter(call => call.mode === 'readwrite')
      expect(writes).toHaveLength(10)
      for (const call of writes)
        expect(call).toMatchObject(durability === 'strict' ? { arguments: 3, durability: 'strict' } : { arguments: 2, durability: undefined })
      const frozen = await round.freeze()
      expect(isVmFrozenReceipt(frozen)).toBe(false)
      expect(await round.beginCalibrationRecovery()).toBe(true)
      await page.reload()
      await expect.poll(() => round.snapshot().phase).toBe('passed')
      await expect(page.locator('#status')).toHaveText('读取通过')
      const reads = await page.evaluate(() => (window as unknown as { __vmTransactions: { mode: string }[] }).__vmTransactions)
      expect(reads.map(call => call.mode)).toEqual(['readonly'])
      expect(round.snapshot()).toMatchObject({ mode: 'reload-calibration', recovered: { record: { runId, seq: 10, requested: durability } }, problems: [] })
      await testInfo.attach('vm-protocol-calibration', { body: JSON.stringify(round.snapshot()), contentType: 'application/json' })
      await testInfo.attach('vm-host-journal', { body: await readFile(path), contentType: 'application/jsonl' })
    }
    finally {
      await page.goto('about:blank')
      await server.close()
      await journal.close()
    }
  })
}

// M4-P2 S6：生产捕获节奏 + 真实 Worker + 持久浏览器目录的端到端测量，不进常规 E2E/CI。
import type { Page } from '@playwright/test'
import type { RecordedWrites } from '../support/autosave.ts'
import type { SnapshotFor } from '../support/database.ts'
import type { DiskDraft } from '../support/local-draft.ts'
import type { LocalSaveTiming, MeasuredEdit } from '../support/local-save-measure.ts'
import type { Workbook } from '../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { perfIncrementalEdit } from '../../../apps/web/src/editor/testing/capture-samples.ts'
import { autosaveLog, capturesOf, clearAutosaveLog, recordWrites } from '../support/autosave.ts'
import { bulkSampleFor, perfSampleFor } from '../support/capture-samples.ts'
import { createDocument, createUser } from '../support/database.ts'
import { chooseAutosave, expect, test } from '../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../support/local-draft.ts'
import { measureLocalEdit } from '../support/local-save-measure.ts'
import { distribution } from '../support/measure-stats.ts'
import { firstPage, launchPersistentProfile } from '../support/persistent-profile.ts'
import { loginThroughApi } from '../support/session.ts'
import { cellOf, openAndEnterEditing, savedContent, saveStatus } from '../support/sheet.ts'

const ROUNDS = Number(process.env.MEASURE_LOCAL_SAVE_ROUNDS ?? '20')
const RESULTS_DIR = join(import.meta.dirname, 'test-results', 'local-save')
const DOCUMENTS: readonly { readonly id: string, readonly snapshotFor: SnapshotFor, readonly formula: boolean }[] = [
  { id: '1m', snapshotFor: bulkSampleFor(1024 * 1024), formula: false },
  { id: '5m', snapshotFor: bulkSampleFor(5 * 1024 * 1024), formula: false },
  { id: 'perf-50k', snapshotFor: perfSampleFor, formula: true },
]

interface Sample extends LocalSaveTiming {
  readonly round: number
  readonly cold: boolean
  readonly captureMs: number
  readonly rawBytes: number
  readonly draftSeq: number
  readonly formulasPending: boolean
}

test.describe.configure({ timeout: 10 * 60_000 })

function editFor(formula: boolean, index: number): MeasuredEdit {
  return formula ? { ...perfIncrementalEdit(index), formula: true } : { cell: 'B2', value: `实测第 ${index + 1} 次修改`, formula: false }
}

function checkSnapshot(snapshot: Workbook, edit: MeasuredEdit): void {
  const sheetId = edit.sheet === undefined ? snapshot.sheetOrder[0] : Object.keys(snapshot.sheets).find(id => snapshot.sheets[id]?.name === edit.sheet)
  expect(sheetId, '磁盘里有本轮修改的工作表').toBeDefined()
  expect(cellOf(snapshot, edit.cell, sheetId)?.v).toBe(edit.value)
  if (edit.formula) {
    const row = edit.cell.slice(1)
    const sum = ['D', 'E', 'F', 'G', 'H', 'I'].reduce((total, col) => total + Number(cellOf(snapshot, `${col}${row}`, sheetId)?.v), 0)
    expect(cellOf(snapshot, `J${row}`, sheetId)?.v, '本轮依赖修改对应的公式缓存也已经落盘').toBeCloseTo(sum, 6)
  }
}

function requireDraft(draft: DiskDraft | null): asserts draft is DiskDraft {
  expect(draft, '本机已完成对应的真实持久记录').not.toBeNull()
}

async function checkNetworkOutcome(page: Page, documentId: string, network: string, writes: RecordedWrites, edit: MeasuredEdit): Promise<void> {
  if (network === 'offline') {
    expect(writes.saves).toHaveLength(0)
    return
  }
  await expect(saveStatus(page)).toHaveText('已保存到云端')
  checkSnapshot((await savedContent(page, documentId)).snapshot, edit)
}

function checkTargets(samples: readonly Sample[], documentId: string): void {
  const eligible = samples.filter(sample => sample.formulaSettledMs <= 900)
  // 公式全部超过样本条件时，仍用全部轮次验更严格的2秒目标；报告保留条件外轮次，不虚称满足公式条件。
  const targetSamples = eligible.length === 0 ? samples : eligible
  expect(distribution(targetSamples.map(sample => sample.localSavedMs))?.p95, '修改到本机完成 p95 ≤ 2s').toBeLessThanOrEqual(2000)
  if (documentId === '1m')
    expect(distribution(samples.map(sample => sample.captureMs))?.p95, '1MiB 同步捕获 p95 ≤ 100ms').toBeLessThanOrEqual(100)
}

for (const document of DOCUMENTS) {
  for (const network of ['online', 'offline'] as const) {
    test(`${document.id} ${network}：修改到本机完成 ${ROUNDS} 次`, async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
      expect(Number.isSafeInteger(ROUNDS) && ROUNDS >= 2, '校准至少两轮；正式报告至少20轮').toBe(true)
      const samples: Sample[] = []
      const startedAt = new Date().toISOString()
      const loadBefore = loadavg()
      const context = await launchPersistentProfile(playwright[browserName], testInfo, `local-${document.id}-${network}`, { cspViolations, pageErrors })
      await chooseAutosave(context, 'running')
      const page = await firstPage(context)
      let workers = 0
      page.on('worker', (worker) => {
        if (worker.url().includes('outbox.worker'))
          workers += 1
      })
      const owner = await createUser(`measure-local-${document.id}`)
      const documentId = await createDocument(owner, '本机保存实测', document.snapshotFor)
      const key = { userId: owner.id, documentId }
      let version = ''
      try {
        await loginThroughApi(page, owner)
        await openAndEnterEditing(page, documentId)
        version = await page.evaluate(() => navigator.userAgent)
        const secret = await currentLocalKey(page)
        await expect.poll(async () => (await readLocalDisk(page, key)).writer !== null).toBe(true)
        expect(workers, '测的是实际发件箱 Worker').toBe(1)
        const writes = recordWrites(page, documentId)
        await context.setOffline(network === 'offline')
        let lastSeq = (await readLocalDisk(page, key)).writer?.lastDraftSeq ?? 0
        for (let round = 1; round <= ROUNDS; round += 1) {
          await clearAutosaveLog(page)
          const edit = editFor(document.formula, round - 1)
          const timing = await measureLocalEdit(page, edit)
          // 计时已结束：读取实际密文，不把读盘/传输/解密的开销混进保存时延。
          const draft = (await readLocalDisk(page, key)).draft
          requireDraft(draft)
          expect(draft.draftSeq).toBeGreaterThan(lastSeq)
          expect(draft.formulasPending).toBe(false)
          lastSeq = draft.draftSeq
          checkSnapshot(JSON.parse(diskSnapshot(draft, secret)) as Workbook, edit)
          const captures = capturesOf(await autosaveLog(page)).filter(entry => entry.at >= timing.startedAt && entry.at <= timing.savedAt)
          expect(captures.length, '本轮真实捕获事件').toBeGreaterThan(0)
          expect(captures.at(-1)?.seq).toBe(timing.editorSeq)
          samples.push({ ...timing, round, cold: round === 1, captureMs: Math.max(...captures.map(entry => entry.durationMs)), rawBytes: draft.rawBytes, draftSeq: draft.draftSeq, formulasPending: draft.formulasPending })
        }
        await checkNetworkOutcome(page, documentId, network, writes, editFor(document.formula, ROUNDS - 1))
      }
      finally {
        const eligible = samples.filter(sample => sample.formulaSettledMs <= 900)
        const report = {
          format: 'nerve-office.local-save-measure.v1',
          browser: { project: testInfo.project.name, userAgent: version },
          host: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), node: process.version },
          document: { id: document.id, templateBytes: Buffer.byteLength(document.snapshotFor('measure-unit')), formula: document.formula },
          network,
          rounds: ROUNDS,
          startedAt,
          finishedAt: new Date().toISOString(),
          load: { before: loadBefore, after: loadavg() },
          summary: {
            all: distribution(samples.map(sample => sample.localSavedMs)),
            eligible: distribution(eligible.map(sample => sample.localSavedMs)),
            outsideFormulaCondition: samples.filter(sample => sample.formulaSettledMs > 900).map(sample => sample.round),
            capture: distribution(samples.map(sample => sample.captureMs)),
            formula: distribution(samples.map(sample => sample.formulaSettledMs)),
          },
          samples,
        }
        mkdirSync(RESULTS_DIR, { recursive: true })
        const json = JSON.stringify(report, null, 2)
        writeFileSync(join(RESULTS_DIR, `${testInfo.project.name}-${document.id}-${network}.json`), `${json}\n`)
        await testInfo.attach('local-save-measure', { body: json, contentType: 'application/json' })
        await context.close()
      }
      checkTargets(samples, document.id)
    })
  }
}

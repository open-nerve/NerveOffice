// S4 页内测量和真实 HTTP 切断的三引擎校准；可选二十轮覆盖心跳先失败，仍不能冒充真实 Safari。
import type { LocalSaveConfig } from '../../../apps/web/src/editor/testing/local-save-report.ts'
import { randomUUID } from 'node:crypto'
import { bulkSampleFor, perfSampleFor } from '../support/capture-samples.ts'
import { createDocument, createUser } from '../support/database.ts'
import { expect, test } from '../support/fixtures.ts'
import { createLocalSaveDriver } from '../support/local-save-driver.ts'
import { startLocalSaveEnvironment } from '../support/local-save-environment.ts'
import { readLocalSaveCloud } from '../support/local-save-evidence.ts'
import { createLocalSaveSession } from '../support/local-save-session.ts'
import { firstPage, launchPersistentProfile } from '../support/persistent-profile.ts'

// 默认夹具上下文不参与测量；下面显式建立与 P2 相同的原生持久目录。
const rounds = process.env.MEASURE_LOCAL_SAVE_ROUNDS === '20' ? 20 : 2
test.use({ webkitStorage: 'temporary' })
for (const sample of ['1m', '5m', 'perf-50k'] as const) {
  for (const network of ['online', 'offline'] as const) {
    test(`S4 页面 ${sample} ${network}：真实原件与独立逐轮核对`, async ({ playwright, browserName, cspViolations, pageErrors }, testInfo) => {
      test.setTimeout(150_000)
      const runId = randomUUID()
      const environment = await startLocalSaveEnvironment(runId)
      const { proxy } = environment
      try {
        const context = await launchPersistentProfile(playwright[browserName], testInfo, `s4-local-${sample}-${network}`, { cspViolations, pageErrors }, true)
        try {
          const page = await firstPage(context)
          const config: LocalSaveConfig = { sample, network, rounds }
          const author = await createUser('s4-local-save')
          const documentId = await createDocument(author, 'S4 保存校准', sample === 'perf-50k' ? perfSampleFor : bulkSampleFor(sample === '1m' ? 1024 * 1024 : 5 * 1024 * 1024))
          const baseline = await readLocalSaveCloud(documentId)
          const deadline = Date.now() + 120_000
          const session = createLocalSaveSession({ config, runId, documentId, userId: author.id, baseRevision: baseline.revision, baseHash: baseline.snapshotHash, deadline })
          const driver = createLocalSaveDriver({ config, documentId, userId: author.id, baseline, session, proxy })
          try {
            proxy.configure({ documentId, entryFragment: new URLSearchParams({ user: author.username, password: author.password, document: documentId, scenario: `local-save-${network}`, next: `${proxy.origin}${proxy.controlPath}` }).toString(), receive: (message, at) => session.receive(message, at) })
            proxy.arm()
            await page.goto(proxy.startUrl)
            await driver.run(deadline, () => {
              expect(environment.healthy()).toBe(true)
            })
            expect(session.snapshot().phase, JSON.stringify({ problems: session.snapshot().problems, page: session.snapshot().pageReport })).toBe('passed')
            expect(session.snapshot().samples).toHaveLength(rounds)
          }
          finally {
            await testInfo.attach('s4-local-save', { body: JSON.stringify({ config, baseline, session: session.snapshot(), host: driver.snapshot() }, null, 2), contentType: 'application/json' })
          }
        }
        finally {
          await context.close()
        }
      }
      finally {
        await environment.close()
      }
    })
  }
}

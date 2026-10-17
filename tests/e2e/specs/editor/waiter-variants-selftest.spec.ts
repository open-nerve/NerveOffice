// 保留期等待真实数据库时钟；十分钟空闲用显式页面时钟校准，不能替代真实 Safari。
import type { Page } from '@playwright/test'
import type { RequestStage } from '../../support/selftest-request.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { S3_WAITER_STEPS, selftestScene, serverProblemsOf } from '../../support/selftest-plan.ts'
import { reportOf, startSelftest } from '../../support/selftest-run.ts'
import { runWaiterVariant, waiterVariantReceipt } from '../../support/selftest-waiter-variants.ts'

async function visibility(page: Page, value: DocumentVisibilityState): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
    document.dispatchEvent(new Event('visibilitychange'))
  }, value)
}

async function prepareCalibration(page: Page, cancelled: boolean): Promise<void> {
  if (cancelled)
    await page.clock.install()
}

for (const definition of S3_WAITER_STEPS) {
  const cancelled = definition.scenario === 'request-waiter-cancelled'

  test(`US-M3-06 请求方自检校准：${cancelled ? '十分钟后台空闲取消并保持阅读' : '真实保留期结束后返回前台才普通申请并保存'}`, { tag: '@test-build' }, async ({ page }, testInfo) => {
    test.setTimeout(300_000)
    const scene = await selftestScene('st-waiter', [definition])
    const step = scene.steps[0]!
    await prepareCalibration(page, cancelled)
    let delivered: readonly string[] = []
    const stage: RequestStage = {
      open: async () => { delivered = await startSelftest(page, step) },
      hide: async () => visibility(page, 'hidden'),
      show: async () => visibility(page, 'visible'),
      report: async until => reportOf(delivered, Math.max(1, until - Date.now())),
    }
    const run = await runWaiterVariant({ origin: e2eOrigin(), documentId: step.documentId, holder: scene.peer, waiter: scene.author, stage, deadline: Date.now() + 280_000 }, cancelled ? 'request-waiter-cancelled' : 'request-waiter-expired', cancelled ? { mode: 'clock-calibration', advanceIdle: async ms => page.clock.fastForward(ms) } : { mode: 'native' })
    await testInfo.attach('waiter-variant-evidence', { body: JSON.stringify(waiterVariantReceipt(run), null, 2), contentType: 'application/json' })
    expect(run.judgement.problems).toEqual([])
    expect((await serverProblemsOf(step, run.report?.path)).problems).toEqual([])
    expect(run.report?.path).toBe(cancelled ? 'cancelled-after-idle' : 'entered-on-return')
  })
}

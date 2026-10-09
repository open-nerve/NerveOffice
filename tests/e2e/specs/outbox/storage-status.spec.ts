// 本机存储的状态（M4-P1 设计 §3.1、§3.5）：经测试构建里的探针调生产的 storage-status.ts，在真实的浏览器里各调一次 persisted()、persist()、
// estimate()，核对结果的形状；Chromium 系另经 CDP 的 Browser.grantPermissions 造出"已授予持久保存"，核对申请得到 granted、之后 persisted 为真。
// 打开的是一份不存在的文档（探针不依赖编辑器）。标签 @test-build
import { chromium } from '@playwright/test'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { openOutboxProbe, outcomeOf, probeStorage } from '../../support/outbox-probe.ts'
import { profileDirFor } from '../../support/persistent-profile.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('本机存储的状态', { tag: '@test-build' }, () => {
  test('各调一次：是否获准持久保存、申请持久保存的结果都是认得出的一种，用量与配额是数（配额大于 0）', async ({ page }) => {
    await loginThroughApi(page, await createUser('ob-storage'))
    await openOutboxProbe(page)
    expect(['persisted', 'not-persisted']).toContain((await probeStorage(page, 'persisted')).kind)
    const estimate = outcomeOf(await probeStorage(page, 'estimate'), 'estimated')
    expect(estimate.quota).toBeGreaterThan(0)
    expect(estimate.usage).toBeGreaterThanOrEqual(0)
    expect(['granted', 'denied']).toContain((await probeStorage(page, 'persist')).kind)
  })

  test('Chromium 系经 CDP 授予持久保存之后：申请得到 granted，之后 persisted 为真（持久化的浏览器上下文：默认的无痕式上下文里 persist() 一律不给）', async ({ browserName, cspViolations, pageErrors }, testInfo) => {
    // eslint-disable-next-line playwright/no-skipped-test -- WebKit 没有授予持久保存的接口（CDP 的 Browser.grantPermissions 只在 Chromium 内核里有）；Safari 上的实际结果由真实 Safari 的复核记录（P1 设计 §3.6 第 1 项）
    test.skip(browserName === 'webkit', 'WebKit 没有授予持久保存的接口：Safari 上的实际结果由真实 Safari 的复核记录（P1 设计 §3.6 第 1 项）')
    const { baseURL, channel, locale, timezoneId, ignoreHTTPSErrors } = testInfo.project.use
    const context = await chromium.launchPersistentContext(profileDirFor(testInfo, 'profile'), { baseURL, channel, locale, timezoneId, ignoreHTTPSErrors })
    try {
      await cspViolations.watch(context)
      pageErrors.watch(context)
      const page = context.pages()[0] ?? await context.newPage()
      await loginThroughApi(page, await createUser('ob-storage-granted'))
      await openOutboxProbe(page)
      const cdp = await context.newCDPSession(page)
      await cdp.send('Browser.grantPermissions', { permissions: ['durableStorage'], origin: new URL(page.url()).origin })
      expect(await probeStorage(page, 'persist')).toEqual({ kind: 'granted' })
      expect(await probeStorage(page, 'persisted')).toEqual({ kind: 'persisted' })
    }
    finally {
      await context.close()
    }
  })
})

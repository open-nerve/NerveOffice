// 在 Playwright 的页面里跑一步页面自检、拦下交回的结果（M3-P2 设计 §3.5）：校准（specs/editor/selftest.spec.ts）与 M4-P1 S1 起的实测
// （measure/probe.spec.ts：持久上下文里跑真实浏览器的复核）共用。结果的交回与驱动脚本相同（整页跳到 next，结果在查询参数里）：next 是本机的地址
// （自检只把结果交给本机，M3-P2 复核 B7），用被测站点自己的源加一个没有的路径，这里拦下那次导航、读出结果，不会发到后端
import type { Page, Route } from '@playwright/test'
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { SelftestStep } from './selftest-plan.ts'
import { decodeSelftestReport, RESULT_PARAM } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'
import { selftestPageUrl } from './selftest-plan.ts'

/** 结果交回的地址：本机的源（被测站点自己的源）加一个没有的路径 */
export function selftestCollector(): string {
  return `${e2eOrigin()}/selftest-collector`
}

/** 自检要等编辑器到 steady（渲染完成后 3 秒）再逐项检查，场景的总时限 180 秒：给足时限，失败时看附件里的页面 */
export const REPORT_TIMEOUT_MS = 200_000

/** 打开入口页，交回的结果由这里拦下：返回已经交回的地址（解开用 reportOf） */
export async function startSelftest(page: Page, step: SelftestStep): Promise<string[]> {
  const delivered: string[] = []
  await page.route(`${selftestCollector()}/**`, async (route) => {
    delivered.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '自检的结果已收到' })
  })
  await page.goto(selftestPageUrl(e2eOrigin(), step, `${selftestCollector()}/report?step=${step.id}`))
  return delivered
}

/** 等结果交回，解开 */
export async function reportOf(delivered: readonly string[], timeoutMs = REPORT_TIMEOUT_MS): Promise<SelftestReport> {
  await expect.poll(() => delivered.length, { message: '等自检把结果交回', timeout: timeoutMs }).toBe(1)
  const encoded = new URL(delivered[0] ?? '').searchParams.get(RESULT_PARAM)
  expect(encoded, '交回的地址里有结果').not.toBeNull()
  return decodeSelftestReport(encoded ?? '')
}

/**
 * 同一个页面里接连跑几步（M4-P1 的实测：持久上下文里一个页面跑完全部复核）：每一步装上拦截、等它交回、再撤掉——拦截不越积越多，
 * 上一步的结果不会被下一步收走
 */
export async function runSelftestStep(page: Page, step: SelftestStep, timeoutMs = REPORT_TIMEOUT_MS): Promise<SelftestReport> {
  const delivered: string[] = []
  const pattern = `${selftestCollector()}/**`
  const handler = async (route: Route): Promise<void> => {
    delivered.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '自检的结果已收到' })
  }
  await page.route(pattern, handler)
  try {
    await page.goto(selftestPageUrl(e2eOrigin(), step, `${selftestCollector()}/report?step=${step.id}`))
    return await reportOf(delivered, timeoutMs)
  }
  finally {
    await page.unroute(pattern, handler)
  }
}

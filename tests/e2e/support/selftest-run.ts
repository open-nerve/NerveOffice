// 在 Playwright 的页面里跑一步页面自检、收下交回的结果（M3-P2 设计 §3.5）：校准（specs/editor/selftest.spec.ts）与 M4-P1 S1 起的实测
// （measure/probe.spec.ts：持久上下文里跑真实浏览器的复核）共用。结果的交回与驱动脚本相同（整页跳到 next，结果在查询参数里），next 是本机的地址
// （自检只把结果交给本机，M3-P2 复核 B7）。两种收法：
// - 校准（startSelftest、reportOf）：用被测站点自己的源加一个没有的路径，page.route 拦下那次导航、读出结果，不会发到后端；
// - 实测（runSelftestStep）：交给另起的本机收集端（./selftest-collector.ts），不碰页面的路由——Playwright 一路由页面就关掉 HTTP 缓存，
//   热的那几步就成了冷的（M4-P1 复核 B5）
import type { Page } from '@playwright/test'
import type { SelftestReport } from '../../../apps/web/src/editor/testing/selftest-report.ts'
import type { ResultCollector } from './selftest-collector.ts'
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

/** 打开入口页，交回的结果由这里拦下：返回已经交回的地址（解开用 reportOf）。页面装了路由，HTTP 缓存随之关掉：只用在不量时间的校准里 */
export async function startSelftest(page: Page, step: SelftestStep): Promise<string[]> {
  const delivered: string[] = []
  await page.route(`${selftestCollector()}/**`, async (route) => {
    delivered.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '自检的结果已收到' })
  })
  await page.goto(selftestPageUrl(e2eOrigin(), step, `${selftestCollector()}/report?step=${step.id}`))
  return delivered
}

/** 交回的地址里的结果解开 */
async function decodeDelivered(url: string): Promise<SelftestReport> {
  const encoded = new URL(url).searchParams.get(RESULT_PARAM)
  expect(encoded, '交回的地址里有结果').not.toBeNull()
  return decodeSelftestReport(encoded ?? '')
}

/** 等结果交回，解开 */
export async function reportOf(delivered: readonly string[], timeoutMs = REPORT_TIMEOUT_MS): Promise<SelftestReport> {
  await expect.poll(() => delivered.length, { message: '等自检把结果交回', timeout: timeoutMs }).toBe(1)
  return decodeDelivered(delivered[0] ?? '')
}

/**
 * 同一个页面里接连跑几步（M4-P1 的实测：持久上下文里一个页面跑完全部复核）：结果交给本机的收集端，页面不装路由，HTTP 缓存照常——
 * 同一个资料目录里第二次打开编辑器页的那几步才是真的热（复核 B5）。每一步用收集端的一个新标记，上一步迟到的交回不会被这一步收走
 */
export async function runSelftestStep(page: Page, step: SelftestStep, collector: ResultCollector, timeoutMs = REPORT_TIMEOUT_MS): Promise<SelftestReport> {
  const { next, delivered } = collector.expect(timeoutMs)
  // 打开失败时这里先抛出，等不到交回的那个失败不再有人接：先接住，免得成了没处理的拒绝（下面照样 await 它）
  void delivered.catch(() => undefined)
  await page.goto(selftestPageUrl(e2eOrigin(), step, next))
  return decodeDelivered(await delivered)
}

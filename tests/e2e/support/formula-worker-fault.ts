// M4-P5 的真实故障：阻断实际模块脚本，或在已就绪的实际 Worker 内抛错。
// 不调用页面的恢复方法、不替换 Worker 构造器；不能用于冷热性能测量（路由会禁用 HTTP 缓存）。
import type { Locator, Page, Worker } from '@playwright/test'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'

const FORMULA_WORKER_PATH = /^\/assets\/formula\.worker-[\w-]+\.js$/

export async function blockFormulaWorker(page: Page): Promise<{ attempts: () => number }> {
  let attempts = 0
  await page.route(url => url.origin === e2eOrigin() && FORMULA_WORKER_PATH.test(url.pathname), async (route) => {
    attempts += 1
    await route.abort('failed')
  })
  return { attempts: () => attempts }
}

export async function failFormulaWorker(page: Page): Promise<Worker> {
  const workers = page.workers().filter(worker => FORMULA_WORKER_PATH.test(new URL(worker.url()).pathname))
  expect(workers, '故障前恰有一个实际公式 Worker').toHaveLength(1)
  const worker = workers[0]
  if (worker === undefined)
    throw new Error('没有实际公式 Worker')
  await worker.evaluate(() => {
    // 让 evaluate 的应答先返回；随后浏览器自己派发 Worker 的 error，而非在页面手工 dispatchEvent。
    setTimeout(() => {
      throw new Error('nerve-e2e-formula-worker-fault')
    }, 100)
  })
  return worker
}

export function formulaRecoveryNotice(page: Page): Locator {
  return page.locator('#editor-chrome [data-slot="formula-recovery"]')
}

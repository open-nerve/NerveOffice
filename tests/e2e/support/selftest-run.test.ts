// 收到结果请求与页面离开编辑器是两个独立时刻；校准的下一步不能抢先发起导航。
import type { Page, Route } from '@playwright/test'
import type { SelftestStep } from './selftest-plan.ts'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSelftest } from './selftest-run.ts'

const REPORT = 'http://127.0.0.1:41997/selftest-collector/report?step=storage&result=original-report'
const STEP: SelftestStep = { id: 'storage', scenario: 'storage', account: { username: 'fixture', password: 'fixture-only' }, documentId: 'document' }
const cleanups: (() => Promise<void>)[] = []

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  // 旧实现未等待导航时，此测试输入的拒绝也不能变成测试外的未处理错误。
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** 真实故障的两个浏览器边界分别控制：发送完响应，以及收集页实际完成导航。 */
async function scene() {
  const response = deferred()
  const landed = deferred()
  let receive: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: async (_pattern: string, handler: (route: Route) => Promise<void>) => { receive = handler },
    goto: async () => null,
    waitForURL: async (url: string) => {
      expect(url, '必须等待交回的完整地址，不能把同源的旧编辑器页当成完成').toBe(REPORT)
      await landed.promise
    },
  } as unknown as Page
  const delivered = await startSelftest(page, STEP)
  if (receive === undefined)
    throw new Error('没有安装结果收集器')
  const route = { request: () => ({ url: () => REPORT }), fulfill: async () => response.promise } as unknown as Route
  const finished = receive(route).then(() => ({ error: undefined }), (error: unknown) => ({ error }))
  cleanups.push(async () => {
    response.resolve()
    landed.resolve()
    await finished
  })
  return { delivered, response, landed, finished }
}

beforeEach(() => vi.stubEnv('E2E_PORT', '41997'))
afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
  vi.unstubAllEnvs()
})

describe('页面自检校准的结果交接', () => {
  it('刚收到请求但尚未交回响应时，不向下一步公开结果', async () => {
    const current = await scene()
    expect(current.delivered).toEqual([])
  })

  it('响应已发送但收集页导航尚未完成时，仍不允许下一步抢先打开页面', async () => {
    const current = await scene()
    current.response.resolve()
    await setImmediate()
    expect(current.delivered).toEqual([])
  })

  it('收集页导航失败时，不把已经收到的结果当作成功交接', async () => {
    const current = await scene()
    current.response.resolve()
    await setImmediate()
    const error = new Error('收集页导航失败')
    current.landed.reject(error)
    expect(await current.finished).toEqual({ error })
    expect(current.delivered).toEqual([])
  })

  it('收集页真正完成导航后，原始结果地址只交回一次', async () => {
    const current = await scene()
    current.response.resolve()
    current.landed.resolve()
    expect(await current.finished).toEqual({ error: undefined })
    expect(current.delivered).toEqual([REPORT])
  })
})

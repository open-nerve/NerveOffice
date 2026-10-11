// 核对“保存先发现登录/权限变化”的真实接口故事。心跳也能发现变化，拦成断网又会暂停云端保存（M4-P2），所以明确控制这条前提。
import type { Page, Request, Response } from '@playwright/test'
import { renewedEditLeaseSchema } from '@nerve-office/contracts'
import { pausedNow, pauseTime } from './autosave.ts'
import { expect } from './fixtures.ts'
import { isSaveRequest, openAndEnterEditing } from './sheet.ts'

interface ObservedRenewal {
  readonly documentId: string
  readonly sentAt: number
  jsonRead?: boolean
  consumed?: { readonly status: number, readonly body: unknown }
  failed?: boolean
}

type RenewalWindow = typeof window & { __nerveSaveFirstRenewals: ObservedRenewal[] }

export interface SaveFirstClock {
  readonly events: readonly string[]
  /** 在正常心跳发出后 1 秒内，只推进 SDK 所需的计时器；核对首个真实保存回包与触发顺序。 */
  readonly expectResponse: (status: number) => Promise<void>
  /** 在各故事自己的失效/会话消费屏障之后调用，再执行需要重建或导航的断言。 */
  readonly resume: () => Promise<void>
}

/** 打开编辑器之前安装；观察保留原 fetch/json，只在下一任务记下应用消费，响应状态与正文均不替换。 */
export async function installSaveFirstClock(page: Page): Promise<void> {
  await page.clock.install()
  await page.addInitScript(() => {
    const observed = window as RenewalWindow
    observed.__nerveSaveFirstRenewals = []
    const fetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const documentId = typeof input === 'string' ? /^\/api\/documents\/([^/]+)\/edit-lease$/.exec(input)?.[1] : undefined
      if (documentId === undefined || init?.method !== 'PUT')
        return fetch(input, init)
      const renewal: ObservedRenewal = { documentId, sentAt: performance.now() }
      observed.__nerveSaveFirstRenewals.push(renewal)
      try {
        const response = await fetch(input, init)
        const json = response.json.bind(response)
        response.json = async () => {
          try {
            const body: unknown = await json()
            renewal.jsonRead = true
            // 契约校验、连接事实发布与续租排程在前面的微任务完成。
            setTimeout(() => {
              renewal.consumed = { status: response.status, body }
            }, 0)
            return body
          }
          catch (error) {
            renewal.failed = true
            throw error
          }
        }
        return response
      }
      catch (error) {
        renewal.failed = true
        throw error
      }
    }
  })
}

/** 已打开的编辑器：先排空旧心跳，再消费一次真实正常心跳，从它建立有确定余量的保存前提。 */
export async function pauseBeforeSave(page: Page, documentId: string): Promise<SaveFirstClock> {
  try {
    const observations = async (): Promise<ObservedRenewal[]> => page.evaluate(id => (window as RenewalWindow).__nerveSaveFirstRenewals.filter(renewal => renewal.documentId === id), documentId)
    // pauseTime 会向前停在 1 秒后；先让旧的在途请求按真实时间完成，避免这一步顺带跨过它已临近的截止。
    await expect.poll(async () => (await observations()).every(renewal => renewal.consumed !== undefined || renewal.failed), { message: '停表前没有未消费的旧心跳', intervals: [50], timeout: 60_000 }).toBe(true)
    await pauseTime(page)
    const consumeRenewals = async (): Promise<void> => {
      await expect.poll(async () => {
        const current = await observations()
        // 等网络/JSON 时不拨时间：旧请求可能已临近截止，新请求也不能把保存的 1 秒预算提前耗尽。
        if (current.some(renewal => !renewal.consumed && !renewal.failed && !renewal.jsonRead))
          return false
        if (current.some(renewal => !renewal.consumed && !renewal.failed))
          await page.clock.runFor(1)
        return (await observations()).every(renewal => renewal.consumed !== undefined || renewal.failed)
      }, { message: '真实心跳已经完整读取、校验、发布连接事实并排好下一次续租', intervals: [50], timeout: 60_000 }).toBe(true)
    }
    await consumeRenewals()
    const previous = await observations()
    expect(previous.every(renewal => renewal.consumed?.status === 200)).toBe(true)
    const next = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`)
    await page.clock.fastForward(10_000)
    await next
    await consumeRenewals()
    const renewals = await observations()
    expect(renewals).toHaveLength(previous.length + 1)
    const heartbeat = renewals.at(-1)!
    expect(heartbeat.consumed?.status).toBe(200)
    expect(renewedEditLeaseSchema.safeParse(heartbeat.consumed?.body).success).toBe(true)
    const deadline = heartbeat.sentAt + 1_000
    expect(await pausedNow(page)).toBeLessThan(deadline)

    const events: string[] = []
    let firstResponse: Response | undefined
    const onRequest = (request: Request): void => {
      const path = new URL(request.url()).pathname
      if (isSaveRequest(request))
        events.push('save')
      else if (request.method() === 'PUT' && path === `/api/documents/${documentId}/edit-lease`)
        events.push('heartbeat')
      else if (request.method() === 'GET' && path === '/api/auth/session')
        events.push('session')
    }
    const onResponse = (response: Response): void => {
      if (firstResponse === undefined && isSaveRequest(response.request()))
        firstResponse = response
    }
    page.on('request', onRequest)
    page.on('response', onResponse)
    return {
      events,
      expectResponse: async (status) => {
        await expect.poll(async () => {
          if (events.includes('save'))
            return true
          if (await pausedNow(page) + 5 <= deadline)
            await page.clock.runFor(5)
          return events.includes('save')
        }, { message: '有限页面时间内先发出保存，心跳不能抢先', intervals: [50], timeout: 60_000 }).toBe(true)
        await expect.poll(() => firstResponse !== undefined, { message: '首个真实保存已返回', timeout: 60_000 }).toBe(true)
        expect(firstResponse!.status()).toBe(status)
        expect(await firstResponse!.finished()).toBeNull()
        expect(events[0]).toBe('save')
        expect(events).not.toContain('heartbeat')
      },
      resume: async () => {
        page.off('request', onRequest)
        page.off('response', onResponse)
        await page.clock.resume()
      },
    }
  }
  catch (error) {
    await page.clock.resume()
    throw error
  }
}

export async function openBeforeSave(page: Page, documentId: string): Promise<SaveFirstClock> {
  await installSaveFirstClock(page)
  await openAndEnterEditing(page, documentId)
  return pauseBeforeSave(page, documentId)
}

/** 显式 resume 前保持冻结；异常路径也恢复，避免后续 SDK 重建或同上下文的新标签页停住。 */
export async function withSaveFirst(page: Page, documentId: string, run: (clock: SaveFirstClock) => Promise<void>, alreadyOpen = false): Promise<void> {
  const clock = alreadyOpen ? await pauseBeforeSave(page, documentId) : await openBeforeSave(page, documentId)
  try {
    await run(clock)
  }
  finally {
    await clock.resume()
  }
}

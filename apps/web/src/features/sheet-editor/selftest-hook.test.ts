// 页面自检的挂接（selftest-hook.ts）：页面到 steady 才引入自检、只跑一次；载入失败、等不到就绪时同样交给自检（它把原因带回去）；
// 页面错误、console.error 与可见性从挂上起就收集，浏览器的 ResizeObserver 通知另记。
import type { SelftestHost } from '../../editor/testing/selftest.ts'
import type { EditorPage, EditorPageLoad, EditorPageView } from './editor-page.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchForSelftest } from './selftest-hook.ts'

const run = vi.hoisted(() => vi.fn(async (_host: SelftestHost) => undefined))
vi.mock('../../editor/testing/selftest.ts', () => ({ runSelftestAndReport: run }))

const DOCUMENT_ID = '01a0fb60-a504-7c95-8bdf-8aeaec893aaf'

/** 假的编辑器页：只有挂接用到的 view 与 subscribe，load 由测试改 */
function fakePage(): { readonly page: EditorPage, readonly set: (load: EditorPageLoad) => void } {
  const listeners = new Set<() => void>()
  let view = { load: { kind: 'loading' } } as EditorPageView
  const page = {
    view: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as EditorPage
  return {
    page,
    set: (load) => {
      view = { ...view, load }
      for (const listener of [...listeners])
        listener()
    },
  }
}

function ready(stage: 'rendered' | 'steady', readOnly = true): EditorPageLoad {
  return { kind: 'ready', documentId: DOCUMENT_ID, title: '只读样本', space: { id: 's', type: 'team', name: '空间' }, accessVia: 'space', canShare: false, userId: 'u', readOnly, stage } as unknown as EditorPageLoad
}

const elements = { chrome: document.createElement('div'), surface: document.createElement('div') }

/** 挂接包装的"原来的" console.error：每个用例之前换成假的，用例之后恢复（挂接的包装随之撤掉） */
let forwarded: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  run.mockClear()
  forwarded = vi.spyOn(console, 'error').mockImplementation(() => {})
  window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=read-only`)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function hostOfFirstRun(): Promise<SelftestHost> {
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  const host = run.mock.calls[0]?.[0]
  if (host === undefined)
    throw new Error('自检没有被调用')
  return host
}

describe('页面自检的挂接', () => {
  it('到 steady 才跑自检，只跑一次：带上文档 id、按只读打开、两个挂载点', async () => {
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    set(ready('rendered'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
    set(ready('steady'))
    set(ready('steady', false))
    const host = await hostOfFirstRun()
    expect(host.page).toEqual({ state: 'ready', readOnly: true })
    expect(host.documentId).toBe(DOCUMENT_ID)
    expect([host.surface, host.chrome]).toEqual([elements.surface, elements.chrome])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('载入失败时同样交给自检，说明失败的原因', async () => {
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    set({ kind: 'editor-failed', error: new TypeError('画不出来') })
    expect((await hostOfFirstRun()).page).toEqual({ state: 'failed', detail: 'editor-failed：TypeError: 画不出来' })
  })

  it('90 秒内没有到 steady：按超时交给自检', async () => {
    vi.useFakeTimers()
    const { page } = fakePage()
    watchForSelftest(page, elements)
    await vi.advanceTimersByTimeAsync(90_000)
    vi.useRealTimers()
    expect((await hostOfFirstRun()).page).toEqual({ state: 'timeout', detail: '90 秒内没有到 steady（loading）' })
  })

  it('开始时页面在后台、2 秒之后还是隐藏的：不等 steady，按"在后台"交给自检（Safari 很快就暂停隐藏的页面）', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    await vi.advanceTimersByTimeAsync(2_000)
    set(ready('steady'))
    vi.useRealTimers()
    const host = await hostOfFirstRun()
    expect(host.page.state).toBe('hidden')
    expect(host.page.detail).toContain('hidden')
    visibility.mockRestore()
  })

  it('开始时隐藏、很快又显示出来：照常等 steady', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    visibility.mockReturnValue('visible')
    await vi.advanceTimersByTimeAsync(2_000)
    set(ready('steady'))
    vi.useRealTimers()
    expect((await hostOfFirstRun()).page).toEqual({ state: 'ready', readOnly: true })
  })

  it('从挂上起收集：没接住的异常、没处理的拒绝、console.error（照常转给原来的），ResizeObserver 的通知另记', async () => {
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new TypeError('boom') }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }))
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('拒绝了') }))
    // eslint-disable-next-line no-console -- 模拟页面里的代码调用 console.error（挂接包装了它）
    console.error('出错了', { code: 1 })
    set(ready('steady'))
    const host = await hostOfFirstRun()
    expect(host.pageErrors()).toEqual(['TypeError: boom', '没有处理的拒绝 RangeError: 拒绝了'])
    expect(host.ignoredNotices()).toEqual(['ResizeObserver loop completed with undelivered notifications.'])
    expect(host.consoleErrors()).toEqual(['出错了 {"code":1}'])
    expect(forwarded).toHaveBeenCalledWith('出错了', { code: 1 })
    expect(host.visibility()).toEqual([expect.stringMatching(new RegExp(`^\\S+ ${document.visibilityState}$`))])
  })
})

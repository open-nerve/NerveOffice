import { afterEach, describe, expect, it, vi } from 'vitest'
import { pauseCellValues, pauseControlFrom, prepareLocalPauseSelftest } from './selftest-pause.ts'
import { PAUSED_HOLDER_EDITS } from './selftest-report.ts'

const RUN = '1f1f40c3-1579-4657-9902-9f1f804fdde1'
const ORIGIN = 'http://127.0.0.1:40123'
const endpoint = `${ORIGIN}/__nerve-pause/${RUN}`
const page = (next: string) => `${ORIGIN}/documents/doc?selftest=paused-local-holder&next=${encodeURIComponent(next)}`

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function windowFixture(kind = 'prepare-window') {
  vi.useFakeTimers()
  vi.stubGlobal('location', { href: page(endpoint), origin: ORIGIN })
  vi.stubGlobal('Worker', class {})
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ kind: 'wait' }))
  fetcher.mockResolvedValueOnce(Response.json({ kind }))
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  return fetcher
}

describe('自然窗口的真实条件确认', () => {
  it('只有宿主确认窗口且页面确实 hidden 后才允许前奏写第三格', async () => {
    const fetcher = windowFixture()
    const control = await prepareLocalPauseSelftest('doc')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'wait' })).mockResolvedValueOnce(Response.json({ kind: 'window-ready' }))
    let finished = false
    const waiting = control.beforeThird!().then(() => {
      finished = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await waiting
    expect(finished).toBe(true)
    expect(fetcher.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { kind: string }).kind)).toEqual(['boot', 'window-state', 'window-state'])
    control.dispose()
  })

  it('旧受控暂停不增加窗口等待；错误回应和可见页面拒绝继续', async () => {
    windowFixture('prepare')
    const ordinary = await prepareLocalPauseSelftest('doc')
    expect(ordinary.beforeThird).toBeUndefined()
    ordinary.dispose()
    const fetcher = windowFixture()
    const control = await prepareLocalPauseSelftest('doc')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'window-ready' }))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await expect(control.beforeThird!()).rejects.toThrow('隐藏')
    control.dispose()
  })

  it('窗口未确认超过十秒或驱动拒绝均不能放行', async () => {
    const fetcher = windowFixture()
    const control = await prepareLocalPauseSelftest('doc')
    const timed = expect(control.beforeThird!()).rejects.toThrow('窗口')
    await vi.advanceTimersByTimeAsync(10_100)
    await timed
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'stop' }))
    await expect(control.beforeThird!()).rejects.toThrow('拒绝')
    control.dispose()
  })
})

describe('本机持久暂停的页面控制入口', () => {
  it('仅接受本页来源的专用运行路径', () => {
    expect(pauseControlFrom(page(endpoint))).toEqual({ endpoint, runId: RUN })
  })

  it.each([
    `http://127.0.0.1:40124/__nerve-pause/${RUN}`,
    `${ORIGIN}/__nerve-crash/${RUN}`,
    `${endpoint}?token=unexpected`,
    `${endpoint}#unexpected`,
    `${ORIGIN}/__nerve-pause/not-a-uuid`,
    `http://user:password@127.0.0.1:40123/__nerve-pause/${RUN}`,
  ])('拒绝非专用入口 %s', (next) => {
    expect(pauseControlFrom(page(next))).toBeUndefined()
  })

  it('旧场景不自动启用新控制协议', () => {
    expect(pauseControlFrom(page(endpoint).replace('paused-local-holder', 'paused-holder'))).toBeUndefined()
  })
})

describe('第三格原件的独立取值', () => {
  it('同时核对三格，兼容持久信封并保留未写的第三格为空', () => {
    const book = { sheets: { 'sheet-1': { cellData: { 0: { 0: { v: PAUSED_HOLDER_EDITS[0].value } }, 1: { 0: { v: PAUSED_HOLDER_EDITS[1].value } } } } } }
    const expected = [PAUSED_HOLDER_EDITS[0].value, PAUSED_HOLDER_EDITS[1].value, null]
    expect(pauseCellValues(JSON.stringify(book))).toEqual(expected)
    expect(pauseCellValues(JSON.stringify({ snapshot: book }))).toEqual(expected)
  })

  it('不会用别的工作表或单元格冒充本轮三格', () => {
    expect(pauseCellValues(JSON.stringify({ sheets: { other: { cellData: { 0: { 0: { v: PAUSED_HOLDER_EDITS[2].value } } } } } }))).toEqual([null, null, null])
  })
})

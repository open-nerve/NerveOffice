// 模式切换的计时（switch-timing.ts）：页面上记下哪些时刻（容器、页头、点击、请求），整理成各段的耗时时怎么取起点、怎么配对请求、
// 网络怎么合计、页头什么时候算到了目标状态。
import type { SwitchMark, SwitchTiming, SwitchTimingRecorder } from './switch-timing.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { headerReached, installSwitchTiming, requestRole, summarizeSwitch, SWITCH_TIMING_OPTIONS, switchDurations } from './switch-timing.ts'

function mark(at: number, kind: SwitchMark['kind'], detail = '', id?: number): SwitchMark {
  return id === undefined ? { at, kind, detail } : { at, kind, detail, id }
}

/** 一次进入编辑：1000 ms 时点击，申请编辑权 20 ms，销毁旧的 5 ms，挂载、同步部分 8 ms，300 ms 后 Rendered，再 30 ms 交互屏障撤掉 */
const ENTER: readonly SwitchMark[] = [
  mark(990, 'chrome', '编辑'),
  mark(1000, 'click', '编辑'),
  mark(1001, 'request', 'POST /api/documents/d1/edit-lease', 1),
  mark(1012, 'chrome', ''),
  mark(1021, 'response', '201', 1),
  mark(1026, 'access-removed', 'read'),
  mark(1026.5, 'access-set', 'edit'),
  mark(1034.5, 'sync-end', 'edit'),
  mark(1340, 'canvas'),
  mark(1370, 'state', 'ready'),
  mark(1371, 'chrome', '保存|退出编辑'),
  mark(1372, 'request', 'PUT /api/documents/d1/edit-lease', 2),
  mark(1380, 'response', '200', 2),
  mark(4370, 'state', 'steady'),
  mark(4400, 'request', 'GET /api/documents/d1/edit-lease', 3),
]

describe('整理一次切换的时刻', () => {
  it('起点是第一次点击；各个时刻相对它；页头到目标状态是第一次出现"退出编辑"', () => {
    const timing = summarizeSwitch('enter', ENTER)
    expect(timing).toMatchObject({ direction: 'enter', feedback: 12, header: 371, creating: 26, mountStart: 26.5, syncEnd: 34.5, rendered: 340, ready: 370, steady: 3370 })
    // steady 之后的请求不算这次切换的；心跳照记，按角色区分
    expect(timing.requests).toEqual([
      { role: 'acquire', label: 'POST /api/documents/d1/edit-lease 201', start: 1, end: 21 },
      { role: 'renew', label: 'PUT /api/documents/d1/edit-lease 200', start: 372, end: 380 },
    ])
  })

  it('资源计时里同一个路径、开始时刻最接近的那条给出正文读完的时刻（晚于回应时取它）', () => {
    const marks = [mark(0, 'click', '有更新，点击刷新'), mark(1, 'request', 'GET /api/documents/d1/content', 1), mark(10, 'response', '200', 1), mark(30, 'access-removed', 'read'), mark(31, 'access-set', 'read'), mark(400, 'state', 'ready'), mark(3400, 'state', 'steady')]
    const timing = summarizeSwitch('refresh', marks, [{ path: '/api/documents/d1/content', startTime: 1.2, responseEnd: 18 }, { path: '/api/documents/d1/content', startTime: 900, responseEnd: 950 }])
    expect(timing.requests).toEqual([{ role: 'content', label: 'GET /api/documents/d1/content 200', start: 1, end: 18 }])
  })

  it('打开：起点是导航开始（0），没有旧的编辑器，开始新建就是开始挂载；页头说明"正在…"不算', () => {
    const marks = [mark(5, 'chrome', ''), mark(200, 'request', 'GET /api/auth/session', 1), mark(300, 'response', '200', 1), mark(301, 'request', 'GET /api/documents/d1', 2), mark(302, 'request', 'GET /api/documents/d1/content', 3), mark(350, 'response', '200', 2), mark(360, 'response', '200', 3), mark(370, 'access-set', 'read'), mark(380, 'sync-end', 'read'), mark(700, 'canvas'), mark(720, 'state', 'ready'), mark(730, 'chrome', '编辑'), mark(3720, 'state', 'steady')]
    const timing = summarizeSwitch('open', marks)
    expect(timing).toMatchObject({ feedback: null, header: 730, creating: 370, mountStart: 370, ready: 720, steady: 3720 })
    // 详情与内容并行：网络按占了多久算（300–360 只算一次）
    expect(switchDurations(timing)).toMatchObject({ network: 159, beforeRebuild: null, dispose: null, rebuild: 350, rebuildSteady: 3350, syncCreate: 10, firstRender: 320, readyWait: 20 })
  })

  it('编辑器页按接上时的阶段写 ready 或 steady：渲染完成 3 秒之后才接上时直接是 steady，ready 与 steady 是同一刻', () => {
    const marks = [mark(0, 'click', '编辑'), mark(10, 'access-removed', 'read'), mark(11, 'access-set', 'edit'), mark(3500, 'state', 'steady')]
    expect(summarizeSwitch('enter', marks)).toMatchObject({ ready: 3500, steady: 3500 })
  })

  it('还没到的时刻是 null；没有点击的记录时说不出起点', () => {
    expect(summarizeSwitch('exit', [mark(0, 'click', '退出编辑')])).toMatchObject({ header: null, creating: null, ready: null, steady: null, requests: [] })
    expect(() => summarizeSwitch('enter', [mark(1, 'state', 'ready')])).toThrow('没有点击的记录')
  })
})

describe('各段的耗时', () => {
  it('进入编辑：网络是申请编辑权，销毁是它结束到开始新建，重建是开始新建到交互屏障撤掉、到 steady，细分同步部分、到 Rendered、到可以操作', () => {
    expect(switchDurations(summarizeSwitch('enter', ENTER))).toEqual({
      feedback: 12,
      header: 371,
      ready: 370,
      steady: 3370,
      network: 20,
      acquire: 20,
      content: null,
      save: null,
      release: null,
      beforeRebuild: 26,
      dispose: 5,
      rebuild: 344,
      rebuildSteady: 3344,
      syncCreate: 8,
      firstRender: 305.5,
      readyWait: 30,
    })
  })

  it('退出编辑：先保存、再释放，两段相继，网络是两段之和；销毁从释放结束算起', () => {
    const timing: SwitchTiming = {
      direction: 'exit',
      feedback: 5,
      header: 600,
      creating: 260,
      mountStart: 261,
      syncEnd: 270,
      rendered: 580,
      ready: 600,
      steady: 3600,
      requests: [
        { role: 'save', label: 'PUT /api/documents/d1/content 200', start: 20, end: 200 },
        { role: 'release', label: 'DELETE /api/documents/d1/edit-lease 204', start: 230, end: 250 },
        { role: 'status', label: 'GET /api/documents/d1/edit-lease 200', start: 601, end: 610 },
      ],
    }
    expect(switchDurations(timing)).toMatchObject({ network: 200, save: 180, release: 20, beforeRebuild: 260, dispose: 10, rebuild: 340 })
  })

  it('开始新建之前没有切换的请求时，销毁从点击算起', () => {
    const marks = [mark(0, 'click', '编辑'), mark(15, 'access-removed', 'read'), mark(16, 'access-set', 'edit'), mark(400, 'state', 'ready')]
    expect(switchDurations(summarizeSwitch('enter', marks))).toMatchObject({ network: null, dispose: 15, rebuild: 385 })
  })
})

describe('页头的目标状态与请求的角色', () => {
  it.each([
    ['enter', '保存|退出编辑', true],
    ['enter', '编辑', false],
    ['exit', '编辑', true],
    ['exit', '保存|退出编辑', false],
    ['exit', '编辑|退出编辑', false],
    ['exit', '', false],
    ['refresh', '编辑', true],
    ['refresh', '', true],
    ['refresh', '有更新，点击刷新|编辑', false],
    ['refresh', '正在载入最新的版本…', false],
    ['open', '编辑', true],
    ['open', '', false],
  ] as const)('%s：页头的按钮是"%s"时 %s', (direction, buttons, reached) => {
    expect(headerReached(direction, buttons)).toBe(reached)
  })

  it.each([
    ['POST /api/documents/d1/edit-lease', 'acquire'],
    ['DELETE /api/documents/d1/edit-lease', 'release'],
    ['PUT /api/documents/d1/edit-lease', 'renew'],
    ['GET /api/documents/d1/edit-lease', 'status'],
    ['GET /api/documents/d1/content', 'content'],
    ['PUT /api/documents/d1/content', 'save'],
    ['GET /api/auth/session', 'session'],
    ['GET /api/documents/d1', 'document'],
    ['POST /api/documents/d1/conflict-copies', 'other'],
    ['PATCH /api/documents/d1/edit-lease', 'other'],
  ] as const)('%s 是 %s', (label, role) => {
    expect(requestRole(label)).toBe(role)
  })
})

describe('在页面上装上计时', () => {
  const name = SWITCH_TIMING_OPTIONS.globalName
  let surface: HTMLElement
  let chrome: HTMLElement
  let recorder: SwitchTimingRecorder
  let fetched: ReturnType<typeof vi.fn>
  const originalFetch = window.fetch.bind(window)

  beforeEach(() => {
    document.body.innerHTML = '<div id="editor-chrome"><button>编辑</button></div><div id="sheet-editor" data-editor-state="steady" data-editor-access="read"></div>'
    surface = document.querySelector('#sheet-editor') as HTMLElement
    chrome = document.querySelector('#editor-chrome') as HTMLElement
    // jsdom 没有资源计时的缓冲区设置
    Object.assign(performance, { setResourceTimingBufferSize: vi.fn(), clearResourceTimings: vi.fn() })
    fetched = vi.fn(async () => new Response('{}', { status: 201 }))
    window.fetch = fetched as unknown as typeof window.fetch
    recorder = installSwitchTiming(SWITCH_TIMING_OPTIONS)
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[name]
    window.fetch = originalFetch
    document.body.innerHTML = ''
  })

  /** 等 MutationObserver 与微任务送达 */
  async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  const kinds = (): string[] => recorder.marks().map(item => `${item.kind}:${item.detail}`)

  it('同一个页面只装一次：再装返回原来的记录器，挂在 window 上', () => {
    expect(installSwitchTiming(SWITCH_TIMING_OPTIONS)).toBe(recorder)
    expect((window as unknown as Record<string, unknown>)[name]).toBe(recorder)
  })

  it('点页头的按钮、旧的编辑器销毁完、新的开始挂载（同步部分结束的微任务）、容器的状态变化、画布挂上、页头变化，依次记下', async () => {
    recorder.clear()
    chrome.querySelector('button')?.click()
    surface.removeAttribute('data-editor-access')
    surface.setAttribute('data-editor-access', 'edit')
    expect(kinds()).toEqual(['click:编辑', 'access-removed:read', 'access-set:edit'])
    await flush()
    surface.dataset.editorState = 'loading'
    await flush()
    const canvas = document.createElement('canvas')
    canvas.id = 'univer-sheet-main-canvas_u1'
    const wrapper = document.createElement('div')
    wrapper.append(canvas)
    surface.append(wrapper)
    await flush()
    surface.dataset.editorState = 'ready'
    chrome.innerHTML = '<button>保存</button><button>退出编辑</button>'
    await flush()
    expect(kinds()).toEqual(['click:编辑', 'access-removed:read', 'access-set:edit', 'sync-end:edit', 'state:loading', 'canvas:', 'state:ready', 'chrome:保存|退出编辑'])
    // 属性还照常写上、去掉
    expect(surface.getAttribute('data-editor-access')).toBe('edit')
  })

  it('同一批里的几次状态变化逐个记下（改之后的值取下一条的改之前）；没变的不记', async () => {
    recorder.clear()
    surface.dataset.editorState = 'loading'
    surface.dataset.editorState = 'ready'
    surface.dataset.editorState = 'ready'
    await flush()
    expect(kinds()).toEqual(['state:loading', 'state:ready'])
  })

  it('页头以外的点击不记；开始挂载之前挂上的画布不记（画布只在挂载开始之后找）', async () => {
    recorder.clear()
    document.body.append(Object.assign(document.createElement('button'), { textContent: '别处' }))
    document.body.lastElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const canvas = document.createElement('canvas')
    canvas.id = 'univer-sheet-main-canvas_u1'
    surface.append(document.createElement('div'), canvas)
    await flush()
    expect(kinds()).toEqual([])
  })

  it('经 fetch 的请求：方法、路径，回应的状态码；失败时记 failed、照样抛出', async () => {
    recorder.clear()
    await window.fetch('/api/documents/d1/edit-lease', { method: 'post' })
    fetched.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(window.fetch(new Request('http://localhost/api/documents/d1/content'))).rejects.toThrow('Failed to fetch')
    expect(recorder.marks().map(item => [item.kind, item.detail, item.id])).toEqual([
      ['request', 'POST /api/documents/d1/edit-lease', 1],
      ['response', '201', 1],
      ['request', 'GET /api/documents/d1/content', 2],
      ['response', 'failed', 2],
    ])
    expect(fetched).toHaveBeenCalledWith('/api/documents/d1/edit-lease', { method: 'post' })
  })

  it('清空之后重新记', () => {
    chrome.querySelector('button')?.click()
    expect(recorder.marks().length).toBeGreaterThan(0)
    recorder.clear()
    expect(recorder.marks()).toEqual([])
  })
})

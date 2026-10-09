// 页面自检的挂接（selftest-hook.ts）：页面到 steady 才引入自检、只跑一次；载入失败、等不到就绪时同样交给自检（它把原因带回去）；
// 页面错误、console.error 与可见性从挂上起就收集，浏览器的 ResizeObserver 通知另记。M3-P2 起打开即阅读：要在编辑时跑的场景先进入编辑。
import type { SelftestHost } from '../../editor/testing/selftest.ts'
import type { EditModeState } from './edit-mode.ts'
import type { EditorPage, EditorPageLoad, EditorPageView } from './editor-page.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deafenHandoverChannel, handoverViewOf, watchForSelftest } from './selftest-hook.ts'

const run = vi.hoisted(() => vi.fn(async (_host: SelftestHost) => undefined))
vi.mock('../../editor/testing/selftest.ts', () => ({ runSelftestAndReport: run }))

const DOCUMENT_ID = '01a0fb60-a504-7c95-8bdf-8aeaec893aaf'

/** 假的编辑器页：只有挂接用到的 view、subscribe 与 enterEditing，视图由测试改 */
function fakePage() {
  const listeners = new Set<() => void>()
  let view = { load: { kind: 'loading' }, mode: undefined, surface: 'loading' } as unknown as EditorPageView
  const enterEditing = vi.fn(async () => {})
  const page = {
    view: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enterEditing,
  } as unknown as EditorPage
  return {
    page,
    enterEditing,
    set: (next: Partial<EditorPageView>): void => {
      view = { ...view, ...next }
      for (const listener of [...listeners])
        listener()
    },
  }
}

const READY: EditorPageLoad = { kind: 'ready', documentId: DOCUMENT_ID, title: '只读样本', space: { id: 's', type: 'team', name: '空间' }, accessVia: 'space', canShare: false, userId: 'u' }

/** 就绪的页面：阅读（readOnly）或编辑，编辑器的容器到了 surface 这一步 */
function ready(surface: 'ready' | 'steady', readOnly = true): Partial<EditorPageView> {
  const mode = readOnly ? { kind: 'reading', canEdit: true, holder: undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver: false, interruption: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined } as const : { kind: 'editing' } as const
  return { load: READY, mode, surface }
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
    set(ready('ready'))
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

  it('要在编辑时跑的场景（edit-chrome）：阅读到 steady 之后先进入编辑（只进一次），进入了就等编辑的 steady 再跑，按可编辑打开', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=edit-chrome`)
    const { page, set, enterEditing } = fakePage()
    let entered: () => void = () => {}
    enterEditing.mockImplementationOnce(async () => new Promise<void>((resolve) => {
      entered = resolve
    }))
    watchForSelftest(page, elements)
    set(ready('steady'))
    set(ready('steady'))
    expect(enterEditing).toHaveBeenCalledOnce()
    set({ mode: { kind: 'entering' }, surface: 'loading' })
    set(ready('ready', false))
    entered()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(run).not.toHaveBeenCalled()
    set(ready('steady', false))
    expect((await hostOfFirstRun()).page).toEqual({ state: 'ready', readOnly: false })
    expect(enterEditing).toHaveBeenCalledOnce()
  })

  it('要在编辑时跑的场景进不去编辑（例如别处正在编辑、不能编辑）：进入有了结果、还在阅读时照样跑，按只读打开说明', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=edit-chrome`)
    const { page, set, enterEditing } = fakePage()
    watchForSelftest(page, elements)
    set(ready('steady'))
    expect(enterEditing).toHaveBeenCalledOnce()
    expect((await hostOfFirstRun()).page).toEqual({ state: 'ready', readOnly: true })
  })

  it('进入、退出编辑的场景（enter-exit）在阅读时开始，不先进入编辑；交给自检的 view 随页面的状态变化（场景里点了"编辑"之后按它等）', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=enter-exit`)
    const { page, set, enterEditing } = fakePage()
    watchForSelftest(page, elements)
    set(ready('steady'))
    const host = await hostOfFirstRun()
    expect(enterEditing).not.toHaveBeenCalled()
    expect(host.page).toEqual({ state: 'ready', readOnly: true })
    expect(host.view()).toEqual({ mode: 'reading', surface: 'steady' })
    set({ mode: { kind: 'entering' }, surface: 'loading' })
    expect(host.view()).toEqual({ mode: 'entering', surface: 'loading' })
    set(ready('ready', false))
    expect(host.view()).toEqual({ mode: 'editing', surface: 'ready' })
  })

  it('交接的复核（M3-P5）：正在编辑的 A（takeover-holder、takeover-holder-deaf）先进入编辑；另开的 B（takeover-taker）与刷新的那一步（refresh-save）在阅读时开始', async () => {
    for (const scenario of ['takeover-holder', 'takeover-holder-deaf']) {
      window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=${scenario}`)
      const holder = fakePage()
      watchForSelftest(holder.page, elements)
      holder.set(ready('steady'))
      expect(holder.enterEditing).toHaveBeenCalledOnce()
    }
    for (const scenario of ['takeover-taker', 'refresh-save']) {
      window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=${scenario}`)
      const other = fakePage()
      watchForSelftest(other.page, elements)
      other.set(ready('steady'))
      expect(other.enterEditing).not.toHaveBeenCalled()
    }
  })

  it('交给自检的 view 另带交接的复核要看的（M3-P5）：阅读时"在此编辑"的进展、持有者是自己时在哪里、说明；失去编辑权时的原因（被接管的带在哪里）、有没有没保存的修改、副本的进展与建好的副本', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=takeover-taker`)
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    set(ready('steady'))
    const host = await hostOfFirstRun()
    const reading = ready('steady').mode as Extract<EditModeState, { kind: 'reading' }>
    set({ mode: { ...reading, selfHolder: 'this-browser', takeover: { kind: 'waiting-save' }, notice: { kind: 'handed-over-tab' } } })
    expect(host.view()).toEqual({ mode: 'reading', surface: 'steady', takeover: 'waiting-save', selfHolder: 'this-browser', notice: 'handed-over-tab' })
    set({ mode: { kind: 'losing', loss: { kind: 'taken-over', where: 'this-browser' } } })
    expect(host.view()).toEqual({ mode: 'losing', surface: 'steady', loss: 'taken-over:this-browser' })
    const lost = { kind: 'lost', loss: { kind: 'forced' }, unsaved: true, readable: true, checking: false, captureFailed: false, inputLeft: false, reopenFailed: false, copy: { kind: 'done', document: { id: 'copy-1' } }, reload: { kind: 'idle' } }
    set({ mode: lost as unknown as EditModeState })
    expect(host.view()).toEqual({ mode: 'lost', surface: 'steady', loss: 'forced', unsaved: true, copy: 'done', copyDocumentId: 'copy-1' })
    set({ mode: { ...lost, copy: { kind: 'saving' } } as unknown as EditModeState })
    expect(host.view()).toEqual({ mode: 'lost', surface: 'steady', loss: 'forced', unsaved: true, copy: 'saving' })
    // 另存为副本成功之后按最新的内容重建为阅读：说明里带着建好的副本
    set({ mode: { ...reading, notice: { kind: 'copied', document: { id: 'copy-1' } } } as unknown as EditModeState })
    expect(host.view()).toEqual({ mode: 'reading', surface: 'steady', notice: 'copied', copyDocumentId: 'copy-1' })
    set({ mode: { kind: 'editing' } })
    expect(host.view()).toEqual({ mode: 'editing', surface: 'steady' })
    expect(handoverViewOf(undefined)).toEqual({})
  })

  it('真实浏览器的前置复核（M4-P1 S1）：捕获成本与公式冻结（capture-cost、perf-baseline）先进入编辑；存储与 Worker 的探针（storage、key-transfer、storage-quota、worker-stall）与生产发件箱的两项（outbox-stall、outbox-pipeline）在阅读时开始', async () => {
    for (const scenario of ['capture-cost', 'perf-baseline']) {
      window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=${scenario}`)
      const editing = fakePage()
      watchForSelftest(editing.page, elements)
      editing.set(ready('steady'))
      expect(editing.enterEditing, scenario).toHaveBeenCalledOnce()
    }
    for (const scenario of ['storage', 'key-transfer', 'storage-quota', 'worker-stall', 'outbox-stall', 'outbox-pipeline']) {
      window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=${scenario}`)
      const reading = fakePage()
      watchForSelftest(reading.page, elements)
      reading.set(ready('steady'))
      expect(reading.enterEditing, scenario).not.toHaveBeenCalled()
    }
  })

  it('第一次载入的时刻（M4-P1 S1 的首屏）：容器第一次到 ready、steady 时同步记下 performance.now()；之后进入编辑重建时不改', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=perf-baseline`)
    const now = vi.spyOn(performance, 'now')
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    now.mockReturnValue(1200)
    set(ready('ready'))
    now.mockReturnValue(4300)
    set(ready('steady'))
    // 进入编辑：重建之后再到 ready、steady
    now.mockReturnValue(9000)
    set({ mode: { kind: 'entering' }, surface: 'loading' })
    set(ready('ready', false))
    set(ready('steady', false))
    const host = await hostOfFirstRun()
    expect(host.firstLoad()).toEqual({ ready: 1200, steady: 4300 })
    // 生产的发件箱（复核的生产部分）：交给自检的是一个用到时才引入的函数
    expect(typeof host.outboxReview).toBe('function')
  })

  it('请求编辑的两条路（M3-P6）：被暂停的持有者（paused-holder）先进入编辑；请求方（request-waiter）在阅读时开始', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=paused-holder`)
    const holder = fakePage()
    watchForSelftest(holder.page, elements)
    holder.set(ready('steady'))
    expect(holder.enterEditing).toHaveBeenCalledOnce()
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=request-waiter`)
    const waiter = fakePage()
    watchForSelftest(waiter.page, elements)
    waiter.set(ready('steady'))
    expect(waiter.enterEditing).not.toHaveBeenCalled()
  })

  it('交给自检的 view 另带请求编辑的复核要看的（M3-P6）：阅读时请求方这一侧的进展与 granted 在等什么；编辑、离开编辑时在等回应的请求是谁发的、离开的原因；续上时别处在编辑的是谁。subscribe 转给编辑器页', async () => {
    window.history.replaceState(null, '', `/documents/${DOCUMENT_ID}?selftest=request-waiter`)
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    set(ready('steady'))
    const host = await hostOfFirstRun()
    const reading = ready('steady').mode as Extract<EditModeState, { kind: 'reading' }>
    set({ mode: { ...reading, request: { kind: 'waiting', holder: undefined, cancelFailure: undefined } } })
    expect(host.view()).toEqual({ mode: 'reading', surface: 'steady', request: 'waiting' })
    set({ mode: { ...reading, request: { kind: 'granted', until: 'visible' } } })
    expect(host.view()).toEqual({ mode: 'reading', surface: 'steady', request: 'granted', requestUntil: 'visible' })
    const requester = { id: 'peer-1', username: 'peer', displayName: '协作者' }
    const incoming = { id: 'r1', requester, declining: false, failure: undefined }
    set({ mode: { kind: 'editing', request: incoming } })
    expect(host.view()).toEqual({ mode: 'editing', surface: 'steady', incoming: 'peer-1' })
    set({ mode: { kind: 'exiting', cause: 'handover-request', request: incoming } })
    expect(host.view()).toEqual({ mode: 'exiting', surface: 'steady', incoming: 'peer-1', leaving: 'handover-request' })
    set({ mode: { kind: 'losing', loss: { kind: 'held', holder: { holder: requester, sameUser: false, lastActiveMinutes: 0 } } } })
    expect(host.view()).toEqual({ mode: 'losing', surface: 'steady', loss: 'held:other' })
    set({ mode: { kind: 'losing', loss: { kind: 'held', holder: { holder: requester, sameUser: true, lastActiveMinutes: undefined } } } })
    expect(host.view().loss).toBe('held:self')
    set({ mode: { kind: 'losing', loss: { kind: 'held', holder: undefined } } })
    expect(host.view().loss).toBe('held:unknown')
    const listener = vi.fn()
    const unsubscribe = host.subscribe(listener)
    set({ mode: { kind: 'editing' } })
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    set({ mode: { kind: 'entering' } })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('收不到交接频道消息的 A（takeover-holder-deaf）：交接频道（nerve-office:doc:*）的 message 监听挂不上，别的频道与别的事件照常', () => {
    // jsdom 的环境里 BroadcastChannel 是 Node 的（它的事件与 jsdom 的不通用）：换成按名字建、能派发事件的假频道
    class FakeChannel extends EventTarget {
      readonly name: string
      constructor(name: string) {
        super()
        this.name = name
      }
    }
    const scope = { BroadcastChannel: FakeChannel as unknown as typeof BroadcastChannel }
    deafenHandoverChannel(scope)
    const handover = new scope.BroadcastChannel(`nerve-office:doc:${DOCUMENT_ID}`)
    const other = new scope.BroadcastChannel('nerve-office:session')
    const heard: string[] = []
    handover.addEventListener('message', () => heard.push('handover'))
    handover.addEventListener('messageerror', () => heard.push('handover-error'))
    other.addEventListener('message', () => heard.push('other'))
    handover.dispatchEvent(new Event('message'))
    handover.dispatchEvent(new Event('messageerror'))
    other.dispatchEvent(new Event('message'))
    expect(heard).toEqual(['handover-error', 'other'])
  })

  it('载入失败时同样交给自检，说明失败的原因', async () => {
    const { page, set } = fakePage()
    watchForSelftest(page, elements)
    set({ load: { kind: 'editor-failed', error: new TypeError('画不出来') }, surface: 'failed' })
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

  it('自检交回结果、整页跳走的那一刻（allowLeave 之后）编辑器页的离开提示不拦；之前照常（这一页有过可信的用户操作时浏览器会弹"确定离开"，自检就停住了）', async () => {
    // 与页面相同的先后：离开提示（page-guards.ts）先装、在冒泡阶段；挂接后装、在捕获阶段
    const guard = vi.fn((event: Event) => event.preventDefault())
    window.addEventListener('beforeunload', guard)
    try {
      const { page, set } = fakePage()
      watchForSelftest(page, elements)
      set(ready('steady'))
      const host = await hostOfFirstRun()
      const before = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(before)
      expect([guard.mock.calls.length, before.defaultPrevented]).toEqual([1, true])
      host.allowLeave()
      const leaving = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(leaving)
      expect([guard.mock.calls.length, leaving.defaultPrevented]).toEqual([1, false])
    }
    finally {
      window.removeEventListener('beforeunload', guard)
    }
  })
})

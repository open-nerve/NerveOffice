import type { SaveContentResponse } from '@nerve-office/contracts'
import type { AutosaveEditor, AutosaveEvent, AutosaveLimits, AutosavePage, AutosaveTuning, UploadState } from './autosave.ts'
import type { SaveEditor, SaveRequest } from './save-coordinator.ts'
import { AUTOSAVE_RETRY_AFTER_MAX_MS } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { createAutosave, decideUpload, DEFAULT_AUTOSAVE_LIMITS, retryDelay } from './autosave.ts'
import { fakeLeaseClock } from './fake-lease-clock.test-support.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

const ME = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
/** 假时钟的起点（毫秒） */
const T0 = 10_000

function listenerSet() {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify: () => [...listeners].forEach(listener => listener()),
    size: () => listeners.size,
  }
}

/**
 * 假的编辑器：edit 是一次修改（工作簿的内容换成 text）；公式收齐、组字、单元格编辑、面板里防抖中的输入可设，各自发出信号。单元格里键入的
 * 内容在提交（等同回车）之前、面板里的输入在防抖到点之前不在工作簿里，捕获不到。captureCost 是一次捕获的耗时（同步地拨快假时钟，
 * 大文档的间隔用）。修改的信号与 SDK 一样在"命令执行的过程中"同步发出：这期间的捕获记进 capturesInCommand（调度不该在信号里捕获）
 */
function fakeEditor(elapse: (ms: number) => void, initial: { settled?: boolean, seq?: number } = {}) {
  const state = { seq: initial.seq ?? 0, content: '初始', cellInput: '', settled: initial.settled ?? true, composing: false, editing: false, pendingInput: false, panelInput: false, captureCost: 0, inCommand: false, capturesInCommand: 0 }
  const changes = listenerSet()
  const formulas = listenerSet()
  const composition = listenerSet()
  const input = listenerSet()
  const editor: AutosaveEditor & SaveEditor = {
    changeSeq: () => state.seq,
    onChange: changes.subscribe,
    isCellEditing: () => state.editing,
    uncommittedInput: () => state.pendingInput || state.panelInput ? 'pending' : state.editing ? 'open' : 'none',
    onUncommittedInputChange: input.subscribe,
    commitCellEditing: vi.fn(async () => {
      state.editing = false
      state.pendingInput = false
      state.content = state.cellInput
      state.seq += 1
      changes.notify()
      input.notify()
      return true
    }),
    settleFormulas: vi.fn(async () => state.settled ? 'settled' as const : 'timeout' as const),
    settlePanels: vi.fn(async () => {}),
    capture: vi.fn(() => {
      if (state.inCommand)
        state.capturesInCommand += 1
      elapse(state.captureCost)
      return JSON.stringify({ content: state.content })
    }),
    formulasSettled: () => state.settled,
    onFormulaProgress: formulas.subscribe,
    composing: () => state.composing,
    onCompositionChange: composition.subscribe,
  }
  const control = {
    edit(text: string): void {
      state.content = text
      state.seq += 1
      state.inCommand = true
      try {
        changes.notify()
      }
      finally {
        state.inCommand = false
      }
    },
    capturesInCommand: () => state.capturesInCommand,
    settle(settled: boolean): void {
      state.settled = settled
      formulas.notify()
    },
    compose(composing: boolean): void {
      state.composing = composing
      composition.notify()
    },
    /** 打开单元格编辑器并键入（还没回车）：工作簿里还没有它 */
    startCellEditing(text: string): void {
      state.editing = true
      state.pendingInput = true
      state.cellInput = text
      input.notify()
    },
    /** 按 Esc 放弃单元格编辑 */
    cancelCellEditing(): void {
      state.editing = false
      state.pendingInput = false
      input.notify()
    },
    /** 在面板里键入：按 SDK 的防抖还没写进工作簿 */
    typeInPanel(): void {
      state.panelInput = true
      input.notify()
    },
    /** 面板的防抖到点：text 是 SDK 这时写进工作簿的内容（一次修改），没给时是没有改动 */
    panelSettled(text?: string): void {
      if (text !== undefined)
        control.edit(text)
      state.panelInput = false
      input.notify()
    },
    /** 现在的工作簿内容与单元格编辑器（断言用） */
    state: () => ({ content: state.content, editing: state.editing, cellInput: state.cellInput }),
    captureCost(ms: number): void {
      state.captureCost = ms
    },
    /** 各个信号的订阅者个数（保存的状态机也订阅修改） */
    listeners: () => ({ changes: changes.size(), formulas: formulas.size(), composition: composition.size() }),
  }
  return { editor, control }
}

function fakePage() {
  const state = { visible: true, online: true, writable: true }
  const listeners = listenerSet()
  const page: AutosavePage = { visible: () => state.visible, online: () => state.online, sessionWritable: () => state.writable, onChange: listeners.subscribe }
  return {
    page,
    set(patch: Partial<typeof state>): void {
      Object.assign(state, patch)
      listeners.notify()
    },
    listeners: listeners.size,
  }
}

/** 测试构建的控制的样子：节奏可换、可以暂停定时的上传 */
function fakeTuning() {
  let limits: AutosaveLimits = DEFAULT_AUTOSAVE_LIMITS
  let held = false
  const listeners = listenerSet()
  const tuning: AutosaveTuning = { limits: () => limits, held: () => held, onChange: listeners.subscribe }
  return {
    tuning,
    hold(): void {
      held = true
      listeners.notify()
    },
    release(): void {
      held = false
      listeners.notify()
    },
    setLimits(next: Partial<AutosaveLimits>): void {
      limits = { ...limits, ...next }
      listeners.notify()
    },
  }
}

interface PendingSend {
  readonly request: SaveRequest
  /** 发出时假时钟的时刻 */
  readonly at: number
  resolve: (response: SaveContentResponse) => void
  reject: (error: unknown) => void
}

function saved(revision: number, unchanged = false): SaveContentResponse {
  return { revision, savedAt: '2026-10-05T08:00:00.000Z', unchanged }
}

let idSequence = 0

/** onSessionStale：保存得到令牌失效时页面做的（编辑器页：令牌已知失效、不可写，随即确认会话） */
function setup(options: { initialFormulasPending?: boolean, settled?: boolean, seq?: number, onSessionStale?: (page: ReturnType<typeof fakePage>) => void } = {}) {
  const time = fakeLeaseClock(T0)
  const { editor, control } = fakeEditor(time.elapse, { settled: options.settled, seq: options.seq })
  const calls: PendingSend[] = []
  const send = vi.fn(async (request: SaveRequest) => new Promise<SaveContentResponse>((resolve, reject) => {
    calls.push({ request, at: time.now(), resolve, reject })
  }))
  const compress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))
  const reportError = vi.fn()
  const onUnauthenticated = vi.fn()
  const page = fakePage()
  const coordinator = createSaveCoordinator({
    editor,
    compress,
    send,
    baseRevision: 1,
    clientInstanceId: ME,
    newRequestId: () => {
      idSequence += 1
      return `request-${idSequence}`
    },
    onUnauthenticated,
    onSessionStale: () => options.onSessionStale?.(page),
    reportError,
    initialFormulasPending: options.initialFormulasPending,
  })
  const tuning = fakeTuning()
  const events: AutosaveEvent[] = []
  const digest = vi.fn(async (snapshot: string) => `sha256:${snapshot}`)
  const autosave = createAutosave({
    editor,
    page: page.page,
    uploader: coordinator,
    clock: time.clock,
    digest,
    initialFormulasPending: options.initialFormulasPending ?? false,
    tuning: tuning.tuning,
    observe: event => events.push(event),
    reportError,
  })
  const captures = () => events.filter(event => event.kind === 'capture')
  const uploads = () => events.filter(event => event.kind === 'upload')
  return { time, editor, control, calls, send, compress, reportError, onUnauthenticated, coordinator, page, tuning, events, captures, uploads, digest, autosave }
}

type Context = ReturnType<typeof setup>

/** 第 n 个请求（不拨假时钟，只等排着的 Promise） */
async function sent(context: Context, n: number): Promise<PendingSend> {
  await vi.waitFor(() => expect(context.calls.length).toBeGreaterThanOrEqual(n))
  const call = context.calls[n - 1]
  if (call === undefined)
    throw new Error(`没有第 ${n} 个请求`)
  return call
}

/** 让回包之后的处理走完（假时钟不动） */
async function drain(context: Context): Promise<void> {
  await context.time.advance(0)
}

/** 改一处、等它按静默存上（第 n 个请求，修订号 revision） */
async function editAndSave(context: Context, text: string, n: number, revision: number): Promise<PendingSend> {
  context.control.edit(text)
  await context.time.advance(2000)
  const call = await sent(context, n)
  call.resolve(saved(revision))
  await drain(context)
  return call
}

describe('上传的规则（纯函数，设计 §3.3）', () => {
  const LIMITS = { uploadQuietMs: 2000, uploadMaxMs: 15_000 }
  const BASE: UploadState = { seq: 3, capturedSeq: 3, lastChangeAt: 1000, firstUnuploadedAt: 1000, retryAt: undefined, immediate: false }

  it.each<[string, UploadState, number, ReturnType<typeof decideUpload>]>([
    ['捕获覆盖了全部修改、还没停 2 秒：等到 2 秒', BASE, 2500, { kind: 'wait', until: 3000 }],
    ['停满 2 秒：上传', BASE, 3000, { kind: 'upload', reason: 'quiet' }],
    ['捕获没覆盖全部修改（公式没收齐、上限没到）：静默不算数，只等上传的上限', { ...BASE, seq: 4, lastChangeAt: 1200 }, 5000, { kind: 'wait', until: 16_000 }],
    ['持续编辑满 15 秒：上传最近一次捕获（没覆盖全部修改也传）', { ...BASE, seq: 40, lastChangeAt: 15_900 }, 16_000, { kind: 'upload', reason: 'cap' }],
    ['补捕获（没有修改过）：不等', { ...BASE, lastChangeAt: undefined, firstUnuploadedAt: undefined }, 1, { kind: 'upload', reason: 'quiet' }],
    ['退避中：等到重试的时刻（静默满了也等）', { ...BASE, retryAt: 9000 }, 8000, { kind: 'wait', until: 9000 }],
    ['退避到点：重试', { ...BASE, retryAt: 9000 }, 9000, { kind: 'upload', reason: 'retry' }],
    ['刚恢复联网：不等静默', { ...BASE, lastChangeAt: 7900, immediate: true }, 8000, { kind: 'upload', reason: 'online' }],
    ['捕获没覆盖全部修改、也不知道第一处没上传的修改：没有可等的', { ...BASE, seq: 4, firstUnuploadedAt: undefined }, 5000, { kind: 'idle' }],
  ])('%s', (_case, state, now, expected) => {
    expect(decideUpload(state, now, LIMITS)).toEqual(expected)
  })

  it('退避：2、4、8……秒，上限 60 秒', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(attempt => retryDelay(attempt, DEFAULT_AUTOSAVE_LIMITS))).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000])
  })
})

describe('节奏（设计 §3.2、§3.3）', () => {
  it('改一处：停 1 秒捕获（不带标记），停 2 秒上传；回包之前是保存中，之后已保存到云端；日志里有原因、序号、时刻与 requestId', async () => {
    const context = setup()
    const { control, time } = context
    control.edit('甲')
    await time.advance(999)
    expect(context.captures()).toHaveLength(0)
    await time.advance(1)
    expect(context.captures()).toEqual([{ kind: 'capture', trigger: 'quiet', at: T0 + 1000, seq: 1, formulasPending: false, bytes: 17, durationMs: 0 }])
    await time.advance(999)
    expect(context.calls).toHaveLength(0)
    await time.advance(1)
    const call = await sent(context, 1)
    expect(call).toMatchObject({ at: T0 + 2000, request: { localSeq: 1, snapshot: '{"content":"甲"}', formulasPending: false } })
    expect(context.coordinator.view().status).toBe('saving')
    call.resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view().status).toBe('clean')
    expect(context.uploads()).toEqual([{ kind: 'upload', trigger: 'quiet', startedAt: T0 + 2000, at: T0 + 2000, seq: 1, outcome: { kind: 'saved', requestId: call.request.requestId } }])
    // 之后没有修改：不再捕获、不再上传
    await time.advance(60_000)
    expect(context.captures()).toHaveLength(1)
    expect(context.calls).toHaveLength(1)
  })

  it('静默窗口内又改：捕获从后一处重新算 1 秒，上传从后一处算 2 秒', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(700)
    context.control.edit('甲乙')
    await context.time.advance(999)
    expect(context.captures()).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'quiet', at: T0 + 1700, seq: 2 })])
    await context.time.advance(999)
    expect(context.calls).toHaveLength(0)
    await context.time.advance(1)
    expect((await sent(context, 1)).request.localSeq).toBe(2)
  })

  it('持续编辑（每 0.5 秒改一处）：每 3 秒捕获一次（上限），从第一处没上传的修改算起 15 秒上传一次；停下之后按静默再传', async () => {
    const context = setup()
    for (let index = 1; index <= 32; index += 1) {
      context.control.edit(`第 ${index} 处`)
      await context.time.advance(500)
    }
    // 现在是 T0 + 16 秒：第一处修改之后 15 秒传过一次（最近一次捕获是那一刻的，序号 30），之后没有
    expect(context.captures().map(event => [event.trigger, event.at])).toEqual([3000, 6000, 9000, 12_000, 15_000].map(offset => ['cap', T0 + offset]))
    expect(context.calls).toHaveLength(1)
    expect(context.calls[0]).toMatchObject({ at: T0 + 15_000, request: { localSeq: 30 } })
    context.calls[0]?.resolve(saved(2))
    // 最后一处在 T0 + 15.5 秒：16.5 秒静默捕获，17.5 秒上传
    await context.time.advance(1499)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1)
    expect(await sent(context, 2)).toMatchObject({ at: T0 + 17_500, request: { localSeq: 32 } })
  })

  it('同时至多一个在途：在途时到了上限也不再发；期间照常捕获，回包之后按规则立即再传（A08：确认只到在途那一份的序号）', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const first = await sent(context, 1)
    context.control.edit('甲乙')
    await context.time.advance(30_000)
    expect(context.captures()).toHaveLength(2)
    expect(context.calls).toHaveLength(1)
    first.resolve(saved(2))
    await drain(context)
    expect(await sent(context, 2)).toMatchObject({ request: { baseRevision: 2, localSeq: 2 } })
    expect(context.coordinator.view()).toMatchObject({ status: 'saving', unsavedEdits: true })
  })

  it('在途期间到了下一次上传的时刻、回包之前又改了：不把排着的旧捕获在回包时立即发出，回包之后按规则重新判断（等新的修改被捕获、停满 2 秒）', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const first = await sent(context, 1)
    // 在途期间：T0 + 3 秒静默捕获"甲乙"，T0 + 4 秒本该上传它；T0 + 4.5 秒又改
    context.control.edit('甲乙')
    await context.time.advance(2500)
    context.control.edit('甲乙丙')
    await context.time.advance(500)
    first.resolve(saved(2))
    await drain(context)
    expect(context.calls).toHaveLength(1)
    // "甲乙丙"在 T0 + 5.5 秒捕获，最后一处修改之后 2 秒（T0 + 6.5 秒）上传
    await context.time.advance(1499)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1)
    expect(await sent(context, 2)).toMatchObject({ at: T0 + 6500, request: { localSeq: 3 } })
  })

  it('修改的信号在 SDK 执行命令的过程中同步到达：不在信号里捕获，排到下一个宏任务', async () => {
    const context = setup()
    context.tuning.setLimits({ captureQuietMs: 0, uploadQuietMs: 0 })
    context.control.edit('甲')
    expect(context.captures()).toHaveLength(0)
    await drain(context)
    expect(context.captures()).toHaveLength(1)
    expect(context.control.capturesInCommand()).toBe(0)
  })

  it('建起来时编辑器里已经有修改（打开不算修改的基线是 0，与保存的状态机相同）：按此刻有了修改算，停 1 秒捕获、停 2 秒上传', async () => {
    const context = setup({ seq: 2 })
    await context.time.advance(999)
    expect(context.captures()).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'quiet', at: T0 + 1000, seq: 2 })])
    await context.time.advance(1000)
    expect(await sent(context, 1)).toMatchObject({ at: T0 + 2000, request: { localSeq: 2 } })
  })

  it('打开之后不改：不捕获、不上传', async () => {
    const context = setup()
    await context.time.advance(60_000)
    expect(context.events).toHaveLength(0)
    expect(context.calls).toHaveLength(0)
  })
})

describe('A08：确认只到上传的那一份捕获的序号——捕获之后、上传开始之前的修改不算已确认（审查 A5、A8）', () => {
  it('15 秒上限的上传：上传的是最近一次捕获（之后还有没捕获的修改），请求的序号是那一份的；回包之后仍有未保存的修改；下一次上限从那一份之后的第一处修改算', async () => {
    const context = setup()
    // 每 0.7 秒改一处：从不静默满 1 秒，捕获按 3 秒的上限（3、6.5、10、13.5 秒……），上传按 15 秒的上限
    const editUntil = async (end: number): Promise<void> => {
      while (context.time.now() - T0 < end) {
        context.control.edit(`第 ${context.editor.changeSeq() + 1} 处`)
        await context.time.advance(700)
      }
    }
    await editUntil(15_000)
    // 15 秒时上传：最近一次捕获在 13.5 秒（序号 20），14、14.7 秒的两处（序号 21、22）还没捕获
    const capturedAt = context.captures().map(event => event.at - T0)
    expect(capturedAt).toEqual([3000, 6500, 10_000, 13_500])
    const first = await sent(context, 1)
    expect(first.at - T0).toBe(15_000)
    expect(first.request.localSeq).toBe(20)
    expect(context.captures().at(-1)).toMatchObject({ seq: 20 })
    first.resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ unsavedEdits: true })
    expect(context.autosave.saved().edits).toBe(false)
    // 上传的上限从那一份之后的第一处修改（14 秒）算起：29 秒，不是上传开始之后的第一处修改（15.4 秒）加 15 秒
    await editUntil(31_000)
    expect((await sent(context, 2)).at - T0).toBe(29_000)
  })

  it('退避之后的重试：上传的仍是那一份捕获（原样重发），期间新的修改不算已确认', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new NetworkError('断网'))
    await drain(context)
    // 退避（4 秒重试）之前 0.5 秒又改了一处：重试的时候它还没被捕获（静默 1 秒要到 4.5 秒）
    await context.time.advance(1500)
    context.control.edit('甲乙')
    await context.time.advance(500)
    const retry = await sent(context, 2)
    expect(retry.request).toMatchObject({ localSeq: 1, snapshot: '{"content":"甲"}' })
    retry.resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ status: 'dirty', unsavedEdits: true })
    expect(context.autosave.saved().edits).toBe(false)
    await context.time.advance(1500)
    expect((await sent(context, 3)).request).toMatchObject({ localSeq: 2, snapshot: '{"content":"甲乙"}' })
  })

  it('排在在途后面的切到后台的上传：轮到时上传的是切走时的那一份，之后迟到的修改（例如空闲任务里的行高）不算已确认', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    context.control.edit('甲乙')
    context.page.set({ visible: false })
    expect(context.captures().at(-1)).toMatchObject({ trigger: 'hidden', seq: 2 })
    context.control.edit('甲乙（迟到的行高）')
    inFlight.resolve(saved(2))
    const queued = await sent(context, 2)
    expect(queued.request).toMatchObject({ localSeq: 2, snapshot: '{"content":"甲乙"}' })
    queued.resolve(saved(3))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ unsavedEdits: true })
    expect(context.autosave.saved().edits).toBe(false)
  })
})

describe('公式（设计 §3.2、§3.5：超过上限带"公式待更新"，收齐之后补存）', () => {
  it('没收齐：静默满了不捕获、也不上传；到了上限照常捕获并带标记、随即上传；收齐之后补捕获、补存（内容相同、标记不同不被去重挡掉）', async () => {
    const context = setup()
    context.control.settle(false)
    context.control.edit('=SUM(A1:A9)')
    await context.time.advance(2999)
    expect(context.captures()).toHaveLength(0)
    expect(context.calls).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'cap', at: T0 + 3000, formulasPending: true })])
    const flagged = await sent(context, 1)
    expect(flagged.request).toMatchObject({ localSeq: 1, formulasPending: true })
    flagged.resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ status: 'dirty', formulasPending: true, unsavedEdits: false })
    // 收齐的信号：立即补捕获（不另等静默），上传的静默早已满了
    context.control.settle(true)
    await drain(context)
    expect(context.captures()[1]).toMatchObject({ trigger: 'formulas', formulasPending: false, seq: 1 })
    const recapture = await sent(context, 2)
    expect(recapture.request).toMatchObject({ localSeq: 1, formulasPending: false })
    recapture.resolve(saved(2, true))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', formulasPending: false })
  })

  it('上限之前收齐：静默满了就捕获，不带标记', async () => {
    const context = setup()
    context.control.settle(false)
    context.control.edit('=A1+1')
    await context.time.advance(1500)
    context.control.settle(true)
    await drain(context)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'quiet', at: T0 + 1500, formulasPending: false })])
  })

  it('带标记进入编辑（初值）：强制重算还没收齐时不捕获；收齐之后补捕获、立即补存（没有修改也存），标记随之清掉', async () => {
    const context = setup({ initialFormulasPending: true, settled: false })
    await context.time.advance(10_000)
    expect(context.events).toHaveLength(0)
    expect(context.autosave.saved()).toEqual({ edits: true, formulas: false })
    context.control.settle(true)
    await drain(context)
    const recapture = await sent(context, 1)
    expect(recapture.request).toMatchObject({ localSeq: 0, formulasPending: false })
    recapture.resolve(saved(2))
    await drain(context)
    expect(context.autosave.saved()).toEqual({ edits: true, formulas: true })
    expect(context.coordinator.view().status).toBe('clean')
  })

  it('测试构建的控制把上限调到 50 毫秒（M0 测"超过上限"的做法）：改完 50 毫秒公式还在算就带标记捕获', async () => {
    const context = setup()
    context.tuning.setLimits({ captureMaxMs: 50 })
    context.control.settle(false)
    context.control.edit('=SUM(A:A)')
    await context.time.advance(49)
    expect(context.captures()).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'cap', formulasPending: true })])
  })
})

describe('组合输入（设计 §3.6：组字中不捕获，静默从组合结束算，上限照样约束）', () => {
  it('组字中：静默满了也不捕获；到了上限照常捕获（拼音不打标记）', async () => {
    const context = setup()
    context.control.compose(true)
    context.control.edit('pin')
    await context.time.advance(2999)
    expect(context.captures()).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'cap', formulasPending: false })])
  })

  it('组合结束：静默从结束的那一刻算', async () => {
    const context = setup()
    context.control.compose(true)
    context.control.edit('pin')
    await context.time.advance(800)
    context.control.compose(false)
    await context.time.advance(999)
    expect(context.captures()).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'quiet', at: T0 + 1800 })])
  })
})

describe('单元格编辑器开着（设计 §3.2 第 4 条）：自动保存不提交、不打断', () => {
  it('只捕获工作簿；单元格里没提交的输入不在里面，页头照旧有未保存的修改', async () => {
    const context = setup()
    context.control.edit('甲')
    context.control.startCellEditing('还没回车')
    await context.time.advance(2000)
    const call = await sent(context, 1)
    expect(call.request.localSeq).toBe(1)
    expect(context.editor.commitCellEditing).not.toHaveBeenCalled()
    call.resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ status: 'dirty', unsavedEdits: true })
    expect(context.autosave.saved()).toEqual({ edits: false, formulas: true })
  })
})

describe('面板里防抖中的输入（Codex 评审 CX4，M3-P6 设计 §3.13）：还没写进模型时不提前捕获，写进之后按现有规则捕获、上传', () => {
  it('防抖中：静默与上限都不因它捕获、上传，页头是有未保存的修改、没全部存上；写进模型之后停 1 秒捕获、停 2 秒上传，存上之后回到已保存到云端', async () => {
    const context = setup()
    context.control.typeInPanel()
    expect(context.coordinator.view()).toMatchObject({ status: 'dirty', unsavedEdits: true })
    expect(context.autosave.saved()).toEqual({ edits: false, formulas: true })
    await context.time.advance(30_000)
    expect(context.captures()).toHaveLength(0)
    expect(context.calls).toHaveLength(0)
    context.control.panelSettled('面板里改的')
    await context.time.advance(999)
    expect(context.captures()).toHaveLength(0)
    await context.time.advance(1)
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'quiet', at: T0 + 31_000, seq: 1 })])
    expect(context.coordinator.view().status).toBe('dirty')
    await context.time.advance(1000)
    const call = await sent(context, 1)
    expect(call).toMatchObject({ at: T0 + 32_000, request: { localSeq: 1, snapshot: '{"content":"面板里改的"}' } })
    call.resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', unsavedEdits: false })
    expect(context.autosave.saved()).toEqual({ edits: true, formulas: true })
  })

  it('防抖到点却没有改动：回到已保存到云端，不捕获也不上传', async () => {
    const context = setup()
    context.control.typeInPanel()
    await context.time.advance(500)
    context.control.panelSettled()
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', unsavedEdits: false })
    await context.time.advance(60_000)
    expect(context.captures()).toHaveLength(0)
    expect(context.calls).toHaveLength(0)
  })
})

describe('立即上传（设计 §3.4）', () => {
  it('保存按钮：先提交单元格、等公式（至多 3 秒，从按下算）再捕获，一律上传（内容没变也传）；交回存上了没有', async () => {
    const context = setup()
    context.control.startCellEditing('编辑中')
    const flushing = context.autosave.flush('save-button')
    const first = await sent(context, 1)
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    expect(context.editor.settleFormulas).toHaveBeenCalledWith(3000)
    expect(first.request).toMatchObject({ localSeq: 1, snapshot: '{"content":"编辑中"}' })
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'save-button', seq: 1 })])
    first.resolve(saved(2))
    await expect(flushing).resolves.toEqual({ edits: true, formulas: true, outcome: { kind: 'saved', requestId: first.request.requestId } })
    const again = context.autosave.flush('save-button')
    ;(await sent(context, 2)).resolve(saved(2, true))
    await expect(again).resolves.toMatchObject({ outcome: { kind: 'saved' } })
  })

  it('保存按钮在自动保存在途时按下：排一次，在途的结束之后立即再存（等公式的 3 秒从按下算）', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    context.control.edit('甲乙')
    const flushing = context.autosave.flush('save-button')
    await context.time.advance(1200)
    expect(context.calls).toHaveLength(1)
    inFlight.resolve(saved(2))
    const queued = await sent(context, 2)
    expect(context.editor.settleFormulas).toHaveBeenLastCalledWith(1800)
    expect(queued.request).toMatchObject({ baseRevision: 2, localSeq: 2 })
    queued.resolve(saved(3))
    await expect(flushing).resolves.toMatchObject({ edits: true, outcome: { kind: 'saved' } })
  })

  it('保存按钮：公式在时限内没收齐，照常捕获、带标记上传；结果说公式结果没存上', async () => {
    const context = setup()
    context.control.settle(false)
    context.control.edit('=SUM(A:A)')
    const flushing = context.autosave.flush('save-button')
    ;(await sent(context, 1)).resolve(saved(2))
    await expect(flushing).resolves.toMatchObject({ edits: true, formulas: false })
    expect(context.calls[0]?.request.formulasPending).toBe(true)
  })

  it('保存按钮：单元格提交不了，中止（提示先完成单元格的编辑），不上传', async () => {
    const context = setup()
    context.control.startCellEditing('不合格')
    vi.mocked(context.editor.commitCellEditing).mockResolvedValueOnce(false)
    await expect(context.autosave.flush('save-button')).resolves.toEqual({ edits: false, formulas: true, outcome: { kind: 'failed', failure: { kind: 'cell-editing' }, requestId: undefined } })
    expect(context.calls).toHaveLength(0)
    expect(context.coordinator.view().problem).toEqual({ kind: 'cell-editing' })
  })

  it('退出编辑（与交出、空闲释放）：提交单元格、等公式、去重——内容与确认过的相同就不发', async () => {
    const context = setup()
    await editAndSave(context, '甲', 1, 2)
    for (const reason of ['exit', 'handover', 'idle-release'] as const)
      await expect(context.autosave.flush(reason)).resolves.toEqual({ edits: true, formulas: true, outcome: { kind: 'deduped' } })
    expect(context.calls).toHaveLength(1)
    expect(context.editor.settleFormulas).toHaveBeenCalledTimes(3)
  })

  it('退出编辑：有没存的就存一次（不管会话、联网与暂停的信号，调用方先确认过会话）', async () => {
    const context = setup()
    context.page.set({ online: false, writable: false })
    context.tuning.hold()
    context.autosave.suspend()
    context.control.edit('甲')
    const flushing = context.autosave.flush('exit')
    ;(await sent(context, 1)).resolve(saved(2))
    await expect(flushing).resolves.toMatchObject({ edits: true, formulas: true, outcome: { kind: 'saved' } })
  })

  it('测试构建的控制（control）：不提交单元格、不等公式，当场捕获、去重上传；会话或联网不对时不发', async () => {
    const context = setup()
    context.control.settle(false)
    context.control.edit('甲')
    context.page.set({ writable: false })
    await expect(context.autosave.flush('control')).resolves.toMatchObject({ outcome: undefined })
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'control', formulasPending: true })])
    context.page.set({ writable: true })
    context.tuning.hold()
    const flushing = context.autosave.flush('control')
    ;(await sent(context, 1)).resolve(saved(2))
    await expect(flushing).resolves.toMatchObject({ edits: true, formulas: false, outcome: { kind: 'saved' } })
    expect(context.editor.settleFormulas).not.toHaveBeenCalled()
    // 没有新的捕获：不再上传
    await expect(context.autosave.flush('control')).resolves.toMatchObject({ outcome: undefined })
  })
})

/** 由测试决定何时兑现的 Promise */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('立即上传在按下的这一刻定下要提交的单元格编辑（审查 A1）：之后才开始的输入不提交、不打断', () => {
  it('自动保存在途时按保存：按下的这一刻就提交开着的那一次编辑（不等在途的回来）；按下之后才开始的输入，排着的那一次轮到时不提交，只捕获工作簿', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    context.control.startCellEditing('甲乙')
    const flushing = context.autosave.flush('save-button')
    // 按下的这一刻：开着的编辑已经提交（等同回车），在途的还没回来
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    expect(context.control.state()).toMatchObject({ content: '甲乙', editing: false })
    // 按下之后：点了另一格开始键入，还没回车
    context.control.startCellEditing('之后才开始')
    inFlight.resolve(saved(2))
    const queued = await sent(context, 2)
    // 轮到时不再提交：上传的是按下时的内容，之后的输入留在单元格编辑器里（没有被当成回车提交、选区不动）
    expect(queued.request).toMatchObject({ localSeq: 2, snapshot: '{"content":"甲乙"}' })
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    expect(context.control.state()).toMatchObject({ editing: true, cellInput: '之后才开始' })
    queued.resolve(saved(3))
    await expect(flushing).resolves.toMatchObject({ edits: false, formulas: true, outcome: { kind: 'saved' } })
    // 单元格里还有没提交的输入：页头照旧有未保存的修改
    expect(context.coordinator.view()).toMatchObject({ status: 'dirty', unsavedEdits: true })
  })

  it('按下时面板的防抖还没到点：先提交开着的编辑，再等面板；等面板期间才开始的输入不提交', async () => {
    const context = setup()
    const panels = deferred<undefined>()
    vi.mocked(context.editor.settlePanels).mockImplementationOnce(async () => panels.promise)
    context.control.startCellEditing('甲')
    const flushing = context.autosave.flush('save-button')
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    context.control.startCellEditing('等面板时才开始')
    panels.resolve(undefined)
    const call = await sent(context, 1)
    expect(call.request).toMatchObject({ localSeq: 1, snapshot: '{"content":"甲"}' })
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    call.resolve(saved(2))
    await flushing
    expect(context.control.state()).toMatchObject({ editing: true, cellInput: '等面板时才开始' })
  })

  it('要等会话的确认（ready）：确认之前就提交开着的编辑；确认期间才开始的输入不提交；确认为假时不上传', async () => {
    const context = setup()
    const confirmation = deferred<boolean>()
    context.control.startCellEditing('甲')
    const flushing = context.autosave.flush('save-button', { ready: async () => confirmation.promise })
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    // 确认还没有结果：不上传、不是保存中
    await drain(context)
    expect(context.calls).toHaveLength(0)
    expect(context.coordinator.view().status).toBe('dirty')
    context.control.startCellEditing('确认时才开始')
    confirmation.resolve(true)
    const call = await sent(context, 1)
    expect(call.request.snapshot).toBe('{"content":"甲"}')
    expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    call.resolve(saved(2))
    await flushing

    const refused = setup()
    refused.control.startCellEditing('乙')
    await expect(refused.autosave.flush('save-button', { ready: async () => false })).resolves.toMatchObject({ outcome: undefined })
    // 提交留在本页（等同按了回车），没有上传
    expect(refused.control.state()).toMatchObject({ content: '乙', editing: false })
    await drain(refused)
    expect(refused.calls).toHaveLength(0)
  })

  it('按下时提交不了：排着的那一次轮到时它还开着就中止（只是提示）；用户自己放弃了就照常存', async () => {
    const stillOpen = setup()
    stillOpen.control.edit('甲')
    await stillOpen.time.advance(2000)
    const first = await sent(stillOpen, 1)
    stillOpen.control.startCellEditing('不合格')
    vi.mocked(stillOpen.editor.commitCellEditing).mockResolvedValueOnce(false)
    const flushing = stillOpen.autosave.flush('save-button')
    first.resolve(saved(2))
    await expect(flushing).resolves.toMatchObject({ outcome: { kind: 'failed', failure: { kind: 'cell-editing' } } })
    expect(stillOpen.calls).toHaveLength(1)
    expect(stillOpen.coordinator.view().problem).toEqual({ kind: 'cell-editing' })

    const cancelled = setup()
    cancelled.control.edit('甲')
    await cancelled.time.advance(2000)
    const inFlight = await sent(cancelled, 1)
    cancelled.control.edit('甲乙')
    cancelled.control.startCellEditing('不合格')
    vi.mocked(cancelled.editor.commitCellEditing).mockResolvedValueOnce(false)
    const saving = cancelled.autosave.flush('save-button')
    cancelled.control.cancelCellEditing()
    inFlight.resolve(saved(2))
    const queued = await sent(cancelled, 2)
    expect(queued.request).toMatchObject({ localSeq: 2, snapshot: '{"content":"甲乙"}' })
    queued.resolve(saved(3))
    await expect(saving).resolves.toMatchObject({ edits: true, outcome: { kind: 'saved' } })
  })

  it('退出编辑、交出与空闲释放同样在调用的这一刻提交（P5 一并适用）：在途的回来之后轮到时，之后才开始的输入不提交', async () => {
    for (const reason of ['exit', 'handover', 'idle-release'] as const) {
      const context = setup()
      context.control.edit('甲')
      await context.time.advance(2000)
      const inFlight = await sent(context, 1)
      context.control.startCellEditing('甲乙')
      const flushing = context.autosave.flush(reason)
      expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
      context.control.startCellEditing('之后才开始')
      inFlight.resolve(saved(2))
      const queued = await sent(context, 2)
      expect(queued.request.snapshot).toBe('{"content":"甲乙"}')
      queued.resolve(saved(3))
      await flushing
      expect(context.editor.commitCellEditing).toHaveBeenCalledOnce()
    }
  })

  it('按下时的提交出错（SDK 的缺陷）：轮到时按意外的错误处理（上报、保存失败）；没轮到（会话不对）时不成为没处理的拒绝', async () => {
    const context = setup()
    const failure = new Error('提交单元格时 SDK 出错')
    context.control.startCellEditing('甲')
    vi.mocked(context.editor.commitCellEditing).mockRejectedValueOnce(failure)
    await expect(context.autosave.flush('save-button')).resolves.toMatchObject({ outcome: { kind: 'failed', failure: { kind: 'unexpected' } } })
    expect(context.reportError).toHaveBeenCalledWith(failure)
    expect(context.calls).toHaveLength(0)

    const refused = setup()
    refused.control.startCellEditing('乙')
    vi.mocked(refused.editor.commitCellEditing).mockRejectedValueOnce(failure)
    await expect(refused.autosave.flush('save-button', { ready: async () => false })).resolves.toMatchObject({ outcome: undefined })
    await drain(refused)
    expect(refused.reportError).not.toHaveBeenCalled()
  })
})

describe('在途时连按保存：并进排着的那一次，同一个结果只记一次账（审查 A2，与只按一次对照）', () => {
  /** 在途（自动保存的第 1 个请求）时按 presses 次保存（按住快捷键时每次重复都是一次），之后让在途的回来 */
  async function pressWhileInFlight(presses: number) {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    context.control.edit('甲乙')
    const flushes = Array.from({ length: presses }, async () => context.autosave.flush('save-button'))
    return { context, inFlight, flushes }
  }

  it.each([1, 2, 5])('按 %i 次、显式保存遇到网络错误：只算一次失败——2 秒之后重试（不是 4 秒），日志里这一次上传只有一条，每次按下交回同一个结果', async (presses) => {
    const { context, inFlight, flushes } = await pressWhileInFlight(presses)
    inFlight.resolve(saved(2))
    const explicit = await sent(context, 2)
    explicit.reject(new NetworkError('断网'))
    const results = await Promise.all(flushes)
    expect(new Set(results.map(result => JSON.stringify(result.outcome))).size).toBe(1)
    expect(results[0]?.outcome).toMatchObject({ kind: 'failed', failure: { kind: 'retry' }, requestId: explicit.request.requestId })
    await drain(context)
    expect(context.uploads().filter(event => event.trigger === 'save-button')).toHaveLength(1)
    await context.time.advance(1999)
    expect(context.calls).toHaveLength(2)
    await context.time.advance(1)
    expect((await sent(context, 3)).request).toEqual(explicit.request)
    expect(context.send).toHaveBeenCalledTimes(3)
  })

  it.each([1, 2, 5])('按 %i 次、显式保存压缩出错（意外）：只算一次意外——退避之后照常再试一次', async (presses) => {
    const { context, inFlight, flushes } = await pressWhileInFlight(presses)
    context.compress.mockRejectedValueOnce(new Error('压缩出错'))
    inFlight.resolve(saved(2))
    const results = await Promise.all(flushes)
    expect(results.every(result => result.outcome?.kind === 'failed' && result.outcome.failure.kind === 'unexpected')).toBe(true)
    await drain(context)
    expect(context.autosave.view().retrying).toBe(true)
    await context.time.advance(2000)
    expect((await sent(context, 2)).request).toMatchObject({ localSeq: 2, snapshot: '{"content":"甲乙"}' })
  })

  it.each([1, 2, 5])('按 %i 次、显式保存得到 422（要等新内容）：挡住的只是那一份，之后新的捕获照常自动上传', async (presses) => {
    const { context, inFlight, flushes } = await pressWhileInFlight(presses)
    inFlight.resolve(saved(2))
    const explicit = await sent(context, 2)
    // 显式保存在途期间又改了一处，静默 1 秒捕获（新的一份）
    context.control.edit('甲乙丙')
    await context.time.advance(1000)
    expect(context.captures().at(-1)).toMatchObject({ trigger: 'quiet', seq: 3 })
    explicit.reject(new ApiError(422, 'SNAPSHOT_INVALID', '不合格'))
    await Promise.all(flushes)
    await context.time.advance(30_000)
    expect(context.calls.map(call => call.request.localSeq)).toEqual([1, 2, 3])
  })

  it('排着的那一次已经开始（在等公式）之后再按：另排一次，不并进已经开始的', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    const formulas = deferred<'settled' | 'timeout'>()
    vi.mocked(context.editor.settleFormulas).mockImplementationOnce(async () => formulas.promise)
    const first = context.autosave.flush('save-button')
    inFlight.resolve(saved(2))
    await vi.waitFor(() => expect(context.editor.settleFormulas).toHaveBeenCalledOnce())
    context.control.edit('甲乙')
    const second = context.autosave.flush('save-button')
    formulas.resolve('settled')
    ;(await sent(context, 2)).resolve(saved(3))
    await expect(first).resolves.toMatchObject({ outcome: { kind: 'saved' } })
    const again = await sent(context, 3)
    expect(again.request).toMatchObject({ localSeq: 2, snapshot: '{"content":"甲乙"}' })
    again.resolve(saved(4))
    await expect(second).resolves.toMatchObject({ edits: true, outcome: { kind: 'saved' } })
  })

  it('并进的那一次按下时的准备也等到：第二次按下时面板的防抖还没到点，排着的那一次等它写进模型再捕获', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    const first = context.autosave.flush('save-button')
    const panels = deferred<undefined>()
    vi.mocked(context.editor.settlePanels).mockImplementationOnce(async () => {
      await panels.promise
      context.control.edit('批注里刚键入的')
    })
    const second = context.autosave.flush('save-button')
    inFlight.resolve(saved(2))
    await drain(context)
    expect(context.calls).toHaveLength(1)
    panels.resolve(undefined)
    const queued = await sent(context, 2)
    expect(queued.request).toMatchObject({ localSeq: 2, snapshot: '{"content":"批注里刚键入的"}' })
    queued.resolve(saved(3))
    const results = await Promise.all([first, second])
    expect(results.map(result => result.outcome)).toEqual([{ kind: 'saved', requestId: queued.request.requestId }, { kind: 'saved', requestId: queued.request.requestId }])
  })

  it('并进时等公式的时限按最晚的一次按下算（从按下算）', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    const first = context.autosave.flush('save-button')
    await context.time.advance(1000)
    const second = context.autosave.flush('save-button')
    await context.time.advance(500)
    inFlight.resolve(saved(2))
    ;(await sent(context, 2)).resolve(saved(3))
    await Promise.all([first, second])
    // 第二次按下在 1.5 秒之前：3 秒的时限还剩 2.5 秒
    expect(context.editor.settleFormulas).toHaveBeenCalledExactlyOnceWith(2500)
  })

  it('排着的那一次因为停住而没做（skipped）：之后再按不并进它，照常存', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    const stopped = context.autosave.flush('save-button')
    context.coordinator.stop()
    inFlight.resolve(saved(2))
    await expect(stopped).resolves.toMatchObject({ outcome: { kind: 'skipped', reason: 'stopped' } })
    context.coordinator.resume()
    context.control.edit('甲乙')
    const again = context.autosave.flush('save-button')
    ;(await sent(context, 2)).resolve(saved(3))
    await expect(again).resolves.toMatchObject({ edits: true, outcome: { kind: 'saved' } })
  })
})

describe('切到后台（设计 §3.4：不等公式、不提交单元格，全程不靠计时器）', () => {
  it('当场捕获（没收齐就带标记）、立刻发起上传，假时钟一刻也没走；不提交单元格；回到前台、收齐之后补存', async () => {
    const context = setup()
    context.control.settle(false)
    context.control.edit('甲')
    context.control.startCellEditing('甲乙')
    context.page.set({ visible: false })
    expect(context.captures()).toEqual([expect.objectContaining({ trigger: 'hidden', seq: 1, formulasPending: true })])
    const call = await sent(context, 1)
    expect(context.time.now()).toBe(T0)
    // 单元格里还没回车的"甲乙"不提交、不在快照里
    expect(call.request).toMatchObject({ localSeq: 1, formulasPending: true, snapshot: '{"content":"甲"}' })
    expect(context.editor.commitCellEditing).not.toHaveBeenCalled()
    call.resolve(saved(2))
    context.page.set({ visible: true })
    context.control.settle(true)
    await drain(context)
    expect(context.captures()[1]).toMatchObject({ trigger: 'formulas', formulasPending: false })
    await context.time.advance(2000)
    expect((await sent(context, 2)).request.formulasPending).toBe(false)
  })

  it('暂停（hold）时照样上传；没有新内容时不发；会话或联网不对时只捕获；挂起时（正在退出编辑）什么也不做', async () => {
    const held = setup()
    held.tuning.hold()
    held.control.edit('甲')
    held.page.set({ visible: false })
    await sent(held, 1)

    const nothing = setup()
    await editAndSave(nothing, '甲', 1, 2)
    nothing.page.set({ visible: false })
    await drain(nothing)
    expect(nothing.calls).toHaveLength(1)

    const offline = setup()
    offline.page.set({ online: false })
    offline.control.edit('甲')
    offline.page.set({ visible: false })
    expect(offline.captures()).toHaveLength(1)
    await drain(offline)
    expect(offline.calls).toHaveLength(0)

    const suspended = setup()
    suspended.autosave.suspend()
    suspended.control.edit('甲')
    suspended.page.set({ visible: false })
    await drain(suspended)
    expect(suspended.events).toHaveLength(0)
  })

  it('退避期内切到后台（服务端给了 Retry-After，审查 A4）：只捕获、不立即重发；回到前台也不提前，到点才重发', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 30 }))
    await drain(context)
    await context.time.advance(1000)
    context.control.edit('甲乙')
    context.page.set({ visible: false })
    expect(context.captures().at(-1)).toMatchObject({ trigger: 'hidden', seq: 2 })
    await drain(context)
    expect(context.calls).toHaveLength(1)
    context.page.set({ visible: true })
    await context.time.advance(28_999)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1)
    expect(await sent(context, 2)).toMatchObject({ at: T0 + 32_000, request: { localSeq: 2 } })
  })

  it('退避期内切到后台（网络错误之后的退避）：不立即重发，到点照常重试；不在退避期时切到后台照常立即上传', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new NetworkError('断网'))
    await drain(context)
    await context.time.advance(1000)
    context.page.set({ visible: false })
    await drain(context)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1000)
    const retry = await sent(context, 2)
    expect(retry.at).toBe(T0 + 4000)
    retry.resolve(saved(2))
    await drain(context)
    context.page.set({ visible: true })
    context.control.edit('甲乙')
    context.page.set({ visible: false })
    expect(await sent(context, 3)).toMatchObject({ at: T0 + 4000, request: { localSeq: 2 } })
  })

  it('在途时切到后台：有新的修改就当场捕获，排在在途的后面上传；在途的就是最近一次捕获时不重复排', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    context.page.set({ visible: false })
    context.page.set({ visible: true })
    context.control.edit('甲乙')
    context.page.set({ visible: false })
    inFlight.resolve(saved(2))
    const second = await sent(context, 2)
    expect(second.request.localSeq).toBe(2)
    second.resolve(saved(3))
    await drain(context)
    expect(context.calls).toHaveLength(2)
    // 第一次切到后台时在途的就是最近一次捕获：没有另排一次（连去重掉的也没有）
    expect(context.uploads().map(event => event.trigger)).toEqual(['quiet', 'hidden'])
  })
})

describe('失败与重试（设计 §3.8）', () => {
  it('结果未知（断网、5xx）：退避 2、4、8 秒重试，内容没变就原样重发同一个 requestId；失败的说明一直在、页头说会自动重试；成功之后退避清零', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const first = await sent(context, 1)
    first.reject(new NetworkError('断网'))
    await drain(context)
    expect(context.autosave.view().retrying).toBe(true)
    expect(context.coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request' } })
    let count = 1
    for (const delay of [2000, 4000, 8000]) {
      await context.time.advance(delay - 1)
      expect(context.calls).toHaveLength(count)
      await context.time.advance(1)
      const retry = await sent(context, count + 1)
      expect(retry.request).toEqual(first.request)
      expect(context.coordinator.view().problem).toMatchObject({ kind: 'request' })
      // 排着的那次重试已经开始：不再有"等着重试"，页头照常说保存中
      expect(context.autosave.view().retrying).toBe(false)
      count += 1
      if (delay < 8000) {
        retry.reject(new ApiError(502, 'BAD_GATEWAY', '网关出错'))
        await drain(context)
      }
      else {
        retry.resolve(saved(2))
        await drain(context)
      }
    }
    expect(context.autosave.view().retrying).toBe(false)
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
    // 同一份重试了三次，摘要只算了一次（5 MiB 的快照不必每次重算）
    expect(context.digest).toHaveBeenCalledOnce()
    // 退避清零：下一次失败又从 2 秒起
    context.control.edit('甲乙')
    await context.time.advance(2000)
    ;(await sent(context, 5)).reject(new NetworkError('断网'))
    await drain(context)
    await context.time.advance(2000)
    await sent(context, 6)
  })

  it('失败时保存的状态机的视图变成"保存失败"的那一刻，调度已经记下会自动重试（页头不先说"保存失败"再说"稍后自动重试"，S4）', async () => {
    const context = setup()
    const seen: [string, boolean][] = []
    context.coordinator.subscribe(() => seen.push([context.coordinator.view().status, context.autosave.view().retrying]))
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new NetworkError('断网'))
    await drain(context)
    expect(seen.filter(([status]) => status === 'failed')).toEqual([['failed', true]])
  })

  it('要等新内容的失败（快照不合格）：视图变成"保存失败"的那一刻调度不说会重试', async () => {
    const context = setup()
    const seen: [string, boolean][] = []
    context.coordinator.subscribe(() => seen.push([context.coordinator.view().status, context.autosave.view().retrying]))
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(422, 'SNAPSHOT_INVALID', '不合格'))
    await drain(context)
    expect(seen.filter(([status]) => status === 'failed')).toEqual([['failed', false]])
  })

  it('重试之前又改了：重试的是新的捕获（新的请求）', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const first = await sent(context, 1)
    first.reject(new NetworkError('断网'))
    await drain(context)
    context.control.edit('甲乙')
    await context.time.advance(2000)
    const retry = await sent(context, 2)
    expect(retry.request.requestId).not.toBe(first.request.requestId)
    expect(retry.request.localSeq).toBe(2)
  })

  it.each([
    ['Retry-After 比退避长：按它等', 10, 10_000],
    ['Retry-After 比退避短：按退避等', 1, 2000],
  ])('503 带 Retry-After（检查池满、每个账户 2 份）：%s，再原样重发', async (_case, seconds, wait) => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const first = await sent(context, 1)
    first.reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: seconds }))
    await drain(context)
    await context.time.advance(wait - 1)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1)
    expect((await sent(context, 2)).request).toEqual(first.request)
  })

  it('503 带一个异常大的 Retry-After（30 天：反向代理的维护页、写错的值）：至多按 5 分钟等，到点原样重发；断网又恢复也不早于它（复验 C2）', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const first = await sent(context, 1)
    first.reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '维护中', { retryAfterSeconds: 30 * 24 * 3600 }))
    await drain(context)
    context.page.set({ online: false })
    context.page.set({ online: true })
    await context.time.advance(AUTOSAVE_RETRY_AFTER_MAX_MS - 1)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1)
    expect((await sent(context, 2)).request).toEqual(first.request)
  })

  it('要等新内容（快照不合格）：同一份不再自动重传（不退避、页头不说会重试）；有新的修改才再试', async () => {
    const context = setup()
    context.control.edit('坏')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(422, 'SNAPSHOT_INVALID', '格式不正确'))
    await drain(context)
    expect(context.autosave.view().retrying).toBe(false)
    await context.time.advance(120_000)
    expect(context.calls).toHaveLength(1)
    context.control.edit('好')
    await context.time.advance(2000)
    expect((await sent(context, 2)).request.localSeq).toBe(2)
  })

  it('终态（本页过旧）：不再捕获、不再上传，立即上传也不做', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(409, 'CLIENT_OUTDATED', '过旧'))
    await drain(context)
    expect(context.coordinator.view().status).toBe('outdated')
    context.control.edit('甲乙')
    await context.time.advance(60_000)
    expect(context.captures()).toHaveLength(1)
    expect(context.calls).toHaveLength(1)
    await expect(context.autosave.flush('save-button')).resolves.toMatchObject({ outcome: undefined })
  })

  it('续租得知不兼容（保存的状态机转入终态）：同样停下', async () => {
    const context = setup()
    context.coordinator.block('document-too-new')
    context.control.edit('甲')
    await context.time.advance(60_000)
    expect(context.events).toHaveLength(0)
  })

  it('捕获出错：上报、显示保存失败（会自动重试）；退避之后再试一次成功了就照常存；连着两次出错就等新的修改', async () => {
    const context = setup()
    const failure = new Error('SDK 的 save() 出错')
    vi.mocked(context.editor.capture).mockImplementationOnce(() => {
      throw failure
    })
    context.control.edit('甲')
    await context.time.advance(1000)
    expect(context.reportError).toHaveBeenCalledWith(failure)
    expect(context.coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure } })
    expect(context.autosave.view().retrying).toBe(true)
    expect(context.events).toEqual([{ kind: 'capture-failed', trigger: 'quiet', at: T0 + 1000 }])
    await context.time.advance(2000)
    expect(context.captures()).toHaveLength(1)
    ;(await sent(context, 1)).resolve(saved(2))
    await drain(context)
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })

    vi.mocked(context.editor.capture).mockImplementationOnce(() => {
      throw failure
    }).mockImplementationOnce(() => {
      throw failure
    })
    context.control.edit('甲乙')
    await context.time.advance(1000)
    await context.time.advance(2000)
    expect(context.autosave.view().retrying).toBe(false)
    expect(context.editor.capture).toHaveBeenCalledTimes(4)
    await context.time.advance(60_000)
    expect(context.editor.capture).toHaveBeenCalledTimes(4)
    context.control.edit('甲乙丙')
    await context.time.advance(1000)
    expect(context.captures()).toHaveLength(2)
  })

  it('压缩出错（意外）：退避之后再试一次；仍错就等新的捕获', async () => {
    const context = setup()
    const failure = new Error('压缩出错')
    context.compress.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
    context.control.edit('甲')
    await context.time.advance(2000)
    await drain(context)
    expect(context.autosave.view().retrying).toBe(true)
    await context.time.advance(2000)
    expect(context.compress).toHaveBeenCalledTimes(2)
    expect(context.autosave.view().retrying).toBe(false)
    await context.time.advance(60_000)
    expect(context.compress).toHaveBeenCalledTimes(2)
    expect(context.calls).toHaveLength(0)
    context.control.edit('甲乙')
    await context.time.advance(2000)
    expect((await sent(context, 1)).request.localSeq).toBe(2)
  })

  it('摘要算不出：上报，这一次照常上传（不去重）', async () => {
    const context = setup()
    const failure = new Error('crypto.subtle 不可用')
    context.digest.mockRejectedValueOnce(failure)
    context.control.edit('甲')
    await context.time.advance(2000)
    await sent(context, 1)
    expect(context.reportError).toHaveBeenCalledWith(failure)
  })
})

describe('离线与会话（设计 §3.3 第 5 条、§3.8）', () => {
  it('离线：照常捕获，不上传，视图说已离线；恢复联网立即上传（不等静默）', async () => {
    const context = setup()
    context.page.set({ online: false })
    expect(context.autosave.view()).toMatchObject({ offline: true })
    context.control.edit('甲')
    await context.time.advance(10_000)
    expect(context.captures()).toHaveLength(1)
    expect(context.calls).toHaveLength(0)
    context.control.edit('甲乙')
    await context.time.advance(1000)
    context.page.set({ online: true })
    await drain(context)
    expect(await sent(context, 1)).toMatchObject({ at: T0 + 11_000, request: { localSeq: 2 } })
    expect(context.autosave.view()).toMatchObject({ offline: false })
  })

  it('恢复联网时没有要传的：之后的修改照常等静默（"立即上传"只对恢复那一刻有待传的内容）', async () => {
    const context = setup()
    context.page.set({ online: false })
    context.page.set({ online: true })
    await drain(context)
    context.control.edit('甲')
    await context.time.advance(1999)
    expect(context.calls).toHaveLength(0)
    await context.time.advance(1)
    await sent(context, 1)
  })

  it('断网之后在退避中恢复联网：立即重试，不等退避；服务端给的 Retry-After 照旧', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new NetworkError('断网'))
    await drain(context)
    context.page.set({ online: false })
    await context.time.advance(500)
    context.page.set({ online: true })
    await drain(context)
    expect(await sent(context, 2)).toMatchObject({ at: T0 + 2500 })

    const busy = setup()
    busy.control.edit('甲')
    await busy.time.advance(2000)
    ;(await sent(busy, 1)).reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 30 }))
    await drain(busy)
    busy.page.set({ online: false })
    busy.page.set({ online: true })
    await busy.time.advance(29_999)
    expect(busy.calls).toHaveLength(1)
    await busy.time.advance(1)
    await sent(busy, 2)
  })

  it('会话不是本人或令牌已知失效：不上传（没有 401 的风暴），视图说暂停；回到本人立即再看', async () => {
    const context = setup()
    context.page.set({ writable: false })
    context.control.edit('甲')
    await context.time.advance(30_000)
    expect(context.calls).toHaveLength(0)
    expect(context.autosave.view()).toMatchObject({ paused: true })
    context.page.set({ writable: true })
    await drain(context)
    await sent(context, 1)
  })

  it('保存得到 401：页面确认会话期间不发；回到本人立即重试，不等退避', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(401, 'SESSION_EXPIRED', '登录已过期'))
    await drain(context)
    expect(context.onUnauthenticated).toHaveBeenCalledOnce()
    context.page.set({ writable: false })
    await context.time.advance(60_000)
    expect(context.calls).toHaveLength(1)
    context.page.set({ writable: true })
    await drain(context)
    await sent(context, 2)
  })

  it('保存得到 401、页面很快确认了是本人（退避还没到）：会话回来时立即重试，不等退避', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(401, 'SESSION_EXPIRED', '登录已过期'))
    await drain(context)
    context.page.set({ writable: false })
    await context.time.advance(500)
    context.page.set({ writable: true })
    await drain(context)
    expect(await sent(context, 2)).toMatchObject({ at: T0 + 2500 })
  })

  /**
   * 真实接线的样子（编辑器页）：每一次会话类的保存失败都让页面确认会话——令牌已知失效（不可写）→ 向服务端确认（一个来回，50 毫秒）→
   * 是本人、换上令牌 → 可写。send 交回每次请求的结果（抛出即失败）
   */
  function flippingSetup(send: (attempt: number) => SaveContentResponse) {
    const time = fakeLeaseClock(T0)
    const { editor, control } = fakeEditor(time.elapse)
    const page = fakePage()
    const sends: number[] = []
    const coordinator = createSaveCoordinator({
      editor,
      compress: async snapshot => new TextEncoder().encode(snapshot),
      send: async () => {
        sends.push(time.now() - T0)
        return send(sends.length)
      },
      baseRevision: 1,
      clientInstanceId: ME,
      newRequestId: () => {
        idSequence += 1
        return `request-${idSequence}`
      },
      onUnauthenticated: () => {
        page.set({ writable: false })
        time.clock.schedule(() => page.set({ writable: true }), 50)
      },
      onSessionStale: () => {
        page.set({ writable: false })
        time.clock.schedule(() => page.set({ writable: true }), 50)
      },
      reportError: vi.fn(),
    })
    createAutosave({ editor, page: page.page, uploader: coordinator, clock: time.clock, digest: async snapshot => snapshot, initialFormulasPending: false, reportError: vi.fn() })
    return { time, control, sends }
  }

  const CSRF_REJECTED = new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')

  it('服务端一直拒绝会话（令牌失效）而页面每次确认都照常成功（审查 A3）：只有第一次在会话回来时立即重试，之后按 4、8、16……秒退避，不按网络往返的速度连着发', async () => {
    const { time, control, sends } = flippingSetup(() => {
      throw CSRF_REJECTED
    })
    control.edit('甲')
    await time.advance(60_000)
    // 2 秒静默上传；被拒、确认之后立即重试一次（2.05 秒）；之后连着的会话类失败按退避：+4、+8、+16 秒（下一次在 62.05 秒，60 秒之外）
    expect(sends).toEqual([2000, 2050, 6050, 14_050, 30_050])
  })

  it('连着的会话类失败的计数在成功、或者别的失败之后清零：之后再遇到会话类失败，会话回来时照样立即重试', async () => {
    const outcomes: (SaveContentResponse | ApiError | NetworkError)[] = [CSRF_REJECTED, saved(2), CSRF_REJECTED, new NetworkError('断网'), new ApiError(401, 'SESSION_EXPIRED', '登录已过期'), saved(3)]
    const { time, control, sends } = flippingSetup((attempt) => {
      const outcome = outcomes[attempt - 1]
      if (outcome === undefined || outcome instanceof Error)
        throw outcome ?? new Error('多出来的请求')
      return outcome
    })
    control.edit('甲')
    await time.advance(2050)
    expect(sends).toEqual([2000, 2050])
    control.edit('甲乙')
    await time.advance(2050)
    // 第 3 次（4.05 秒）被拒，确认之后立即重试（4.1 秒）得到网络错误（退避 4 秒：连着的第 2 次失败），8.1 秒重试得到 401、确认之后立即重试
    await time.advance(10_000)
    expect(sends).toEqual([2000, 2050, 4050, 4100, 8100, 8150])
  })

  it('排在在途后面的上传轮到时会话已知不对（在途的那一次得到令牌失效、页面随即确认会话）：不带着失效的令牌再发、不算一次失败；会话回来之后立即上传按下时的那一份', async () => {
    const context = setup({ onSessionStale: page => page.set({ writable: false }) })
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    context.control.edit('甲乙')
    const flushing = context.autosave.flush('save-button')
    inFlight.reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await expect(flushing).resolves.toMatchObject({ outcome: { kind: 'skipped', reason: 'session' } })
    await drain(context)
    expect(context.calls).toHaveLength(1)
    // 轮到时照样捕获了（按下时提交之后的内容）：会话回来时是连着的第一次会话类失败，立即重试，上传的就是这一份
    expect(context.captures().at(-1)).toMatchObject({ trigger: 'save-button', seq: 2 })
    context.page.set({ writable: true })
    await drain(context)
    expect(await sent(context, 2)).toMatchObject({ at: T0 + 2000, request: { localSeq: 2, snapshot: '{"content":"甲乙"}' } })
  })

  it('503 带 Retry-After 之后、到点之前按保存得到令牌失效：会话回来时不等退避，但服务端给的 Retry-After 照旧（复验 C7）', async () => {
    const context = setup({ onSessionStale: page => page.set({ writable: false }) })
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(503, 'SERVICE_UNAVAILABLE', '繁忙', { retryAfterSeconds: 30 }))
    await drain(context)
    await context.time.advance(3000)
    context.control.edit('甲乙')
    const flushing = context.autosave.flush('save-button')
    ;(await sent(context, 2)).reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await flushing
    await drain(context)
    context.page.set({ writable: true })
    await drain(context)
    // Retry-After 在 32 秒时到（第一次失败在 2 秒）：会话回来（5 秒）时不提前
    await context.time.advance(26_999)
    expect(context.calls).toHaveLength(2)
    await context.time.advance(1)
    expect(await sent(context, 3)).toMatchObject({ at: T0 + 32_000, request: { localSeq: 2 } })
  })

  it('保存得到 401、会话却一直显示可写：照样按退避再试，不连着发', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    ;(await sent(context, 1)).reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await drain(context)
    await context.time.advance(1999)
    expect(context.calls).toHaveLength(1)
    await context.time.advance(1)
    await sent(context, 2)
  })

  it('保存的状态机被停住（换了人、失去编辑权）：不上传；恢复之后立即再看', async () => {
    const context = setup()
    context.coordinator.stop()
    context.control.edit('甲')
    await context.time.advance(30_000)
    expect(context.calls).toHaveLength(0)
    context.coordinator.resume()
    await drain(context)
    await sent(context, 1)
  })
})

describe('会话内去重（设计 §3.7）', () => {
  it('改了又撤销：内容与确认过的相同，不发请求，按这次捕获确认（已保存到云端）', async () => {
    const context = setup()
    await editAndSave(context, '甲', 1, 2)
    context.control.edit('甲乙')
    context.control.edit('甲')
    await context.time.advance(2000)
    expect(context.uploads().at(-1)).toMatchObject({ trigger: 'quiet', outcome: { kind: 'deduped' } })
    expect(context.calls).toHaveLength(1)
    expect(context.coordinator.view()).toMatchObject({ status: 'clean', unsaved: false })
    expect(context.digest).toHaveBeenCalledTimes(2)
  })
})

describe('测试构建的控制的注入点（设计 §3.14：hold、setLimits、log）', () => {
  it('hold：定时触发的上传不发（捕获照常）；release 之后立即再看', async () => {
    const context = setup()
    context.tuning.hold()
    expect(context.autosave.view()).toMatchObject({ held: true })
    context.control.edit('甲')
    await context.time.advance(30_000)
    expect(context.captures()).toHaveLength(1)
    expect(context.calls).toHaveLength(0)
    context.tuning.release()
    await drain(context)
    await sent(context, 1)
    expect(context.autosave.view()).toMatchObject({ held: false })
  })

  it('setLimits：换上上传的节奏', async () => {
    const context = setup()
    context.tuning.setLimits({ captureQuietMs: 10, uploadQuietMs: 20 })
    context.control.edit('甲')
    await context.time.advance(20)
    expect(await sent(context, 1)).toMatchObject({ at: T0 + 20 })
  })

  it('观察者出错不影响保存：上报', async () => {
    const time = fakeLeaseClock(T0)
    const { editor, control } = fakeEditor(time.elapse)
    const reportError = vi.fn()
    const coordinator = createSaveCoordinator({ editor, compress: async snapshot => new TextEncoder().encode(snapshot), send: async () => saved(2), baseRevision: 1, clientInstanceId: ME, newRequestId: () => 'request-observer', onUnauthenticated: vi.fn(), onSessionStale: vi.fn(), reportError })
    const failure = new Error('日志写不进去')
    createAutosave({ editor, page: fakePage().page, uploader: coordinator, clock: time.clock, digest: async snapshot => snapshot, initialFormulasPending: false, observe: () => {
      throw failure
    }, reportError })
    control.edit('甲')
    await time.advance(2000)
    await vi.waitFor(() => expect(coordinator.view().status).toBe('clean'))
    expect(reportError).toHaveBeenCalledWith(failure)
  })
})

describe('大文档拉长间隔（计划书 §7.2：两次捕获的间隔不小于上一次捕获耗时的 10 倍）', () => {
  it('一次捕获耗时 500 毫秒：之后 5 秒之内不再捕获（静默满了也等）', async () => {
    const context = setup()
    context.control.captureCost(500)
    context.control.edit('甲')
    await context.time.advance(1000)
    expect(context.captures()).toEqual([expect.objectContaining({ at: T0 + 1500, durationMs: 500 })])
    // 捕获在 T0 + 1.5 秒结束：T0 + 6.5 秒之前不再捕获（这一处的静默在 T0 + 2.5 秒就满了）
    context.control.edit('甲乙')
    await context.time.advance(4999)
    expect(context.captures()).toHaveLength(1)
    await context.time.advance(1)
    expect(context.captures()[1]).toMatchObject({ trigger: 'quiet', seq: 2, at: T0 + 7000 })
  })
})

describe('挂起、全部存上了没有、停下', () => {
  it('挂起（开始退出编辑）：定时的捕获与上传都停，退出编辑的立即上传照常；恢复之后接着按规则存', async () => {
    const context = setup()
    context.autosave.suspend()
    context.control.edit('甲')
    await context.time.advance(30_000)
    expect(context.events).toHaveLength(0)
    context.autosave.resume()
    await drain(context)
    expect(context.captures()).toHaveLength(1)
    await sent(context, 1)
  })

  it('全部存上了没有：修改、单元格里的输入与公式分开说', async () => {
    const context = setup()
    expect(context.autosave.saved()).toEqual({ edits: true, formulas: true })
    context.control.edit('甲')
    expect(context.autosave.saved()).toEqual({ edits: false, formulas: true })
    await context.time.advance(2000)
    ;(await sent(context, 1)).resolve(saved(2))
    await drain(context)
    expect(context.autosave.saved()).toEqual({ edits: true, formulas: true })
  })

  it('停下（dispose）：退订全部信号，不再捕获与上传；在途的由保存的状态机收尾；立即上传不做', async () => {
    const context = setup()
    context.control.edit('甲')
    await context.time.advance(2000)
    const inFlight = await sent(context, 1)
    expect(context.control.listeners()).toEqual({ changes: 2, formulas: 1, composition: 1 })
    context.autosave.dispose()
    // 剩下的那一个是保存的状态机的
    expect(context.control.listeners()).toEqual({ changes: 1, formulas: 0, composition: 0 })
    expect(context.page.listeners()).toBe(0)
    expect(context.time.pending()).toBe(0)
    inFlight.resolve(saved(2))
    context.control.edit('甲乙')
    context.page.set({ visible: false })
    await context.time.advance(60_000)
    expect(context.calls).toHaveLength(1)
    expect(context.uploads()).toHaveLength(0)
    expect(context.coordinator.view().status).toBe('dirty')
    await expect(context.autosave.flush('save-button')).resolves.toMatchObject({ outcome: undefined })
  })
})

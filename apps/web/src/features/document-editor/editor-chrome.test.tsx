// 页头的通用骨架（M6-P1 S8c，S8 spec §3.2、§3.6）：用不带任何表格成员的假页面与假插槽，核对：
// - 骨架自己能走通载入、阅读、编辑、失去编辑权、强制接管与载入失败；
// - 没有插槽时（选中装配之前）与原来选中之前相同：挡住按假算，两个位置不渲染，播报区没有第三件事实，快照被拒的说明用 describeError；
//   选中之后（页面扩展交出成员）插槽随即起作用：骨架每次渲染都经 page.extension() 取插槽；
// - 7 个插槽各在原来的位置、按原来的先后起作用；相邻的条件变化时插槽的位置不动，有焦点的元素不重建；
// - 挡住动作在骨架里按渲染时的视图算（不读页面扩展的 blocksActions()：它读编辑模式此刻的视图，与页头的快照可能差一拍），
//   确认框与“放弃本机修改”按 page.view() 的当前值调用插槽。
// 表格的全部页头行为（骨架加表格的插槽）由 sheet-editor/sheet-chrome.test.tsx 覆盖
import type { RecoveryView } from '../../shared/local-drafts/document-recovery.ts'
import type { LeaseLoss } from './edit-lease.ts'
import type { CopyState, LostMode, ReadingMode } from './edit-mode.ts'
import type { EditorChromeMembers, EditorChromeSlots } from './editor-chrome.tsx'
import type { EditorPage, EditorPageReady, EditorPageView } from './editor-page.ts'
import type { IncomingRequest } from './holder-requests.ts'
import type { SaveView } from './save-coordinator.ts'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, describeError } from '../../shared/api/index.ts'
import { EditorChrome } from './editor-chrome.tsx'

/** 编辑模式视图里扩展的部分（表格是 formulaRecovery）：假插槽按它决定挡不挡、播报什么、说明什么 */
interface Extra {
  readonly fake: { readonly blocked: boolean, readonly spoken?: string, readonly note?: string } | undefined
}

/** 图片操作的状态：会话层只约束 kind 与可选的 reason，这里另带一段给插槽用的文字 */
interface Image {
  readonly kind: 'busy' | 'failed'
  readonly reason?: 'permission'
  readonly label: string
}

/**
 * 假装配交给使用方的成员：插槽、工具行开不开、说明里的按钮做什么；另带页面扩展的挂点 blocksActions——运行时 page.extension() 交回的是整个扩展
 * （挂点并上成员），这里给它一个与插槽相反的答案，核对骨架不读它
 */
interface Members extends EditorChromeMembers<Members, Extra, Image> {
  readonly toolbar: boolean
  readonly act: () => void
  readonly blocksActions: () => boolean
}

type View = EditorPageView<Extra, Image>

/** 工具行的假件：按钮把焦点交给骨架给的去处 */
function FakeToolbar({ fallbackFocus }: { fallbackFocus: () => void }) {
  return (
    <div data-slot="fake-toolbar">
      <button type="button" onClick={fallbackFocus}>交还焦点</button>
    </div>
  )
}

/** 假插槽（模块级常量，同表格的写法）：都在用到的那一刻经 page.extension() 取成员 */
const SLOTS: EditorChromeSlots<Members, Extra, Image> = {
  blocksActions: view => view.fake?.blocked === true,
  actionBlocked: '假的扩展正挡着这个操作',
  announcement: view => view.fake?.spoken,
  toolbar: (page, fallbackFocus) => page.extension()?.toolbar === true ? <FakeToolbar fallbackFocus={fallbackFocus} /> : undefined,
  imageOperation: state => `假的图片操作：${state.label}`,
  notice: (view, page) => {
    const note = view.fake?.note
    if (note === undefined)
      return undefined
    return (
      <div data-slot="fake-notice">
        <p>{note}</p>
        <button type="button" onClick={() => page.extension()?.act()}>处理假的说明</button>
      </div>
    )
  },
  snapshotProblem: (details, page) => `假的快照说明（${JSON.stringify(details)}，${page.view().load.kind}）`,
}

function membersOf(changes: Partial<Members> = {}): Members {
  return { chrome: SLOTS, toolbar: false, act: vi.fn(), blocksActions: vi.fn(() => false), ...changes }
}

const READY: EditorPageReady = {
  kind: 'ready',
  documentId: '0199a2c4-0000-7000-8000-0000000000d1',
  title: '周记',
  space: { id: '0199a2c4-0000-7000-8000-0000000000a1', type: 'personal' },
  accessVia: 'space',
  canShare: false,
  canViewHistory: false,
  userId: '0199a2c4-0000-7000-8000-00000000000a',
}
const CLEAN: SaveView = { status: 'clean', formulasPending: false, problem: undefined, conflict: undefined, canSave: true, unsaved: false, unsavedEdits: false, checking: false, snapshotBytes: undefined }
const DIRTY: SaveView = { ...CLEAN, status: 'dirty', unsaved: true, unsavedEdits: true }
const READING: ReadingMode = { kind: 'reading', canEdit: true, holder: undefined, selfHolder: undefined, takeover: undefined, request: undefined, requestedElsewhere: false, canTakeOver: false, interruption: undefined, update: 'none', gone: false, notice: undefined, releaseUnconfirmed: false, blocked: undefined, formulasPending: false, damaged: undefined }
const AMY = { id: '0199a2c4-0000-7000-8000-0000000000e1', username: 'amy', displayName: '艾米' }
const OTHER_HOLDER = { holder: AMY, sameUser: false, sameSession: false, lastActiveMinutes: 1 }
const OFFLINE = { browserOnline: false, available: false, problem: 'offline', since: Date.now(), generation: 1 } as const
const CONNECTION_REQUIRED = '此操作需要联网，连接恢复后可继续。'
const RESTORE: RecoveryView = { stage: 'ready', decision: { kind: 'restore', baseRevision: 3, formulasPending: false, reason: 'fast-forward' }, updatedAt: new Date(2026, 10, 21, 15, 30).getTime(), operation: undefined, cleanup: undefined, copy: { kind: 'idle' }, notice: undefined, problem: undefined }

/** 失去编辑权（读得到、有修改：可以另存为副本或放弃） */
function lost(loss: LeaseLoss, copy: CopyState = { kind: 'idle' }): LostMode {
  return { kind: 'lost', loss, unsaved: true, readable: true, checking: false, captureFailed: false, inputLeft: false, reopenFailed: false, copy, reload: { kind: 'idle' } }
}

/** 假的编辑器页：视图由测试设定；members 为 undefined 是选中装配之前（没有插槽） */
function fakePage(initial: Partial<View>, members: Members | undefined) {
  let view: View = { load: READY, mode: { kind: 'editing' }, save: CLEAN, autosave: undefined, session: 'active', sessionProblem: undefined, confirmingSession: false, detailProblem: undefined, detailRefreshing: false, surface: 'ready', ...initial }
  let current = members
  const listeners = new Set<() => void>()
  const page: EditorPage<Members, Extra, Image> = {
    extension: () => current,
    retryRecovery: vi.fn(async () => {}),
    copyRecovery: vi.fn(async () => {}),
    beginDiscardRecovery: vi.fn(() => ({ updatedAt: 123 })),
    discardRecovery: vi.fn(async () => {}),
    retryRecoveryCleanup: vi.fn(async () => {}),
    acknowledgeRecovery: vi.fn(async () => {}),
    view: () => view,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async () => {},
    save: vi.fn(async () => {}),
    enterEditing: vi.fn(async () => {}),
    takeOverHere: vi.fn(async () => {}),
    cancelTakeOver: vi.fn(),
    forceTakeOver: vi.fn(async () => {}),
    dismissInterruption: vi.fn(),
    requestEditing: vi.fn(async () => {}),
    cancelRequest: vi.fn(async () => {}),
    handOver: vi.fn(async () => {}),
    keepEditing: vi.fn(async () => {}),
    exitEditing: vi.fn(async () => {}),
    refreshUpdate: vi.fn(async () => {}),
    saveCopy: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    hasUnsavedWork: () => false,
    reload: vi.fn(),
    refreshDetail: vi.fn(async () => {}),
    recheckSession: vi.fn(async () => {}),
    dispose: () => {},
  }
  return {
    page,
    /** 改视图并通知（页头随之按新的快照渲染） */
    set(next: Partial<View>): void {
      view = { ...view, ...next }
      act(() => listeners.forEach(listener => listener()))
    },
    /** 只改 page.view() 的当前值、不通知：页头留着渲染时的快照 */
    quietly(next: Partial<View>): void {
      view = { ...view, ...next }
    },
    /** 换掉页面扩展交出的成员（下一次渲染或点击时才读到） */
    select(next: Members | undefined): void {
      current = next
    },
  }
}

function renderChrome(initial: Partial<View> = {}, members: Members = membersOf()) {
  const fake = fakePage(initial, members)
  render(<EditorChrome page={fake.page} apple={false} />)
  return fake
}

/** 选中装配之前：页面扩展还没有，没有插槽 */
function renderUnselected(initial: Partial<View>) {
  const fake = fakePage(initial, undefined)
  render(<EditorChrome page={fake.page} apple={false} />)
  return fake
}

/** 页头里看得见的状态（不是读屏的播报区） */
function headerStatus(): HTMLElement {
  const status = screen.getByRole('banner').querySelector<HTMLElement>('[data-slot="header-status"]')
  if (status === null)
    throw new Error('页头里没有看得见的状态')
  return status
}

/** 页头里读屏的播报区（只播有意义的变化）：一直在、视觉隐藏 */
function announcement(): HTMLElement {
  const spoken = screen.getByRole('banner').querySelector<HTMLElement>('p.sr-only[aria-live="polite"]')
  if (spoken === null)
    throw new Error('页头里没有读屏的播报区')
  return spoken
}

function slotIn(header: HTMLElement, slot: string): HTMLElement {
  const element = header.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
  if (element === null)
    throw new Error(`页头里没有 ${slot}`)
  return element
}

describe('骨架自己能走通各个模式', () => {
  it('载入中说明正在打开、有返回链接；载入失败只有说明与返回链接', () => {
    const fake = renderUnselected({ load: { kind: 'loading' }, mode: undefined, save: undefined })
    expect(headerStatus()).toHaveTextContent('正在打开表格…')
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    fake.set({ load: { kind: 'not-found' } })
    expect(screen.getByText('内容不存在，或者你没有访问权限')).toBeVisible()
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveAttribute('href', '/')
    expect(screen.queryByRole('banner')).toBeNull()
  })

  it('阅读：只能查看时说明，阅读的静态说明一直在；能编辑时“编辑”进入编辑', () => {
    const fake = renderChrome({ mode: { ...READING, canEdit: false }, save: undefined })
    expect(headerStatus()).toHaveTextContent('只能查看')
    expect(screen.getByText('阅读时显示的是已保存的版本，不是实时内容')).toBeVisible()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    fake.set({ mode: READING })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(fake.page.enterEditing).toHaveBeenCalledOnce()
  })

  it('编辑：保存状态、“保存”与“退出编辑”', () => {
    const fake = renderChrome({ save: DIRTY })
    expect(headerStatus()).toHaveTextContent('有未保存的修改')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByRole('button', { name: '退出编辑' }))
    expect(fake.page.save).toHaveBeenCalledOnce()
    expect(fake.page.exitEditing).toHaveBeenCalledOnce()
    fake.set({ save: CLEAN })
    expect(headerStatus()).toHaveTextContent('已保存到云端')
  })

  it('失去编辑权：另存为副本；放弃本页的修改先确认', async () => {
    const fake = renderChrome({ mode: lost({ kind: 'newer' }), save: undefined })
    expect(headerStatus()).toHaveTextContent('编辑权已失效')
    fireEvent.click(screen.getByRole('button', { name: '另存为副本' }))
    expect(fake.page.saveCopy).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '放弃本页的修改' }))
    const dialog = await screen.findByRole('dialog', { name: '放弃本页的修改？' })
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(fake.page.discard).toHaveBeenCalledOnce())
  })

  it('强制接管先确认，确认之后才接管', async () => {
    const fake = renderChrome({ mode: { ...READING, canTakeOver: true, holder: OTHER_HOLDER }, save: undefined })
    fireEvent.click(screen.getByRole('button', { name: '强制接管' }))
    const dialog = await screen.findByRole('dialog', { name: '强制接管编辑？' })
    expect(fake.page.forceTakeOver).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '强制接管' }))
    await waitFor(() => expect(fake.page.forceTakeOver).toHaveBeenCalledOnce())
  })
})

describe('没有插槽时与选中装配之前相同', () => {
  it('挡住按假算，工具行与说明的位置不渲染，播报区没有第三件事实，快照被拒的说明用 describeError；选中之后插槽随即起作用', () => {
    const error = new ApiError(422, 'SNAPSHOT_INVALID', '快照不合规则', { details: { rule: 'link-address' } })
    const fake = renderUnselected({ fake: { blocked: true, spoken: '插槽的第三件事实', note: '插槽的说明' }, save: { ...DIRTY, status: 'failed', problem: { kind: 'request', error } } })
    const header = screen.getByRole('banner')
    expect(header.querySelector('[data-slot="fake-toolbar"]')).toBeNull()
    expect(header.querySelector('[data-slot="fake-notice"]')).toBeNull()
    expect(announcement()).not.toHaveTextContent('插槽的第三件事实')
    expect(screen.getByRole('alert')).toHaveTextContent(`保存失败：${describeError(error).message}`)
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(save)
    expect(fake.page.save).toHaveBeenCalledOnce()
    fake.select(membersOf({ toolbar: true }))
    fake.set({})
    expect(slotIn(header, 'fake-toolbar')).toBeVisible()
    expect(slotIn(header, 'fake-notice')).toHaveTextContent('插槽的说明')
    expect(announcement()).toHaveTextContent('插槽的第三件事实')
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：假的快照说明（{"rule":"link-address"}，ready）')
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('副本被拒时同样用 describeError 说明', () => {
    const error = new ApiError(422, 'SNAPSHOT_INVALID', '快照不合规则', { details: { rule: 'image-source' } })
    renderUnselected({ mode: lost({ kind: 'newer' }, { kind: 'refused', refusal: 'content', error }), save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent(`没能另存为副本：${describeError(error).message}。`)
  })
})

describe('7 个插槽的位置、先后与作用', () => {
  it('工具行（toolbar）紧跟页头行、在“需要联网”之前；它的焦点去处是返回链接', () => {
    renderChrome({ connection: OFFLINE }, membersOf({ toolbar: true }))
    const header = screen.getByRole('banner')
    const toolbar = slotIn(header, 'fake-toolbar')
    expect(header.children[1]).toBe(toolbar)
    expect(header.children[2]).toHaveTextContent(CONNECTION_REQUIRED)
    fireEvent.click(within(toolbar).getByRole('button', { name: '交还焦点' }))
    expect(screen.getByRole('link', { name: '我的空间' })).toHaveFocus()
  })

  it('说明（notice）在图片状态之后、阅读的静态说明之前；它的按钮在点击的那一刻读页面扩展', () => {
    const first = membersOf()
    const fake = renderChrome({ mode: READING, save: undefined, imageProblem: true, fake: { blocked: false, note: '插槽的说明' } }, first)
    const header = screen.getByRole('banner')
    const notice = slotIn(header, 'fake-notice')
    expect(slotIn(header, 'image-status').nextElementSibling).toBe(notice)
    expect(notice.nextElementSibling).toBe(slotIn(header, 'reading-note'))
    const second = membersOf()
    fake.select(second)
    fireEvent.click(within(notice).getByRole('button', { name: '处理假的说明' }))
    expect(second.act).toHaveBeenCalledOnce()
    expect(first.act).not.toHaveBeenCalled()
  })

  it('图片操作（imageOperation）：骨架留着原来的读屏状态，只向插槽要文字', () => {
    const fake = renderChrome({ save: DIRTY, imageOperation: { kind: 'busy', label: '插入 2 张' } })
    const operation = slotIn(screen.getByRole('banner'), 'image-operation')
    expect(operation).toHaveAttribute('role', 'status')
    expect(operation).toHaveTextContent('假的图片操作：插入 2 张')
    fake.set({ imageOperation: { kind: 'failed', reason: 'permission', label: '粘贴' } })
    expect(slotIn(screen.getByRole('banner'), 'image-operation')).toBe(operation)
    expect(operation).toHaveTextContent('假的图片操作：粘贴')
  })

  it('播报区的第三件事实（announcement）与保存的事实各自独立：它变了只播它，保存的新状态照常播', () => {
    const fake = renderChrome({ save: DIRTY })
    const spoken = announcement()
    fake.set({ fake: { blocked: false, spoken: '插槽的第三件事实' } })
    expect(announcement()).toBe(spoken)
    expect(spoken).toHaveTextContent('插槽的第三件事实')
    fake.set({ save: CLEAN })
    expect(spoken).toHaveTextContent('已保存到云端')
    expect(spoken).not.toHaveTextContent('插槽的第三件事实')
  })

  it('挡住动作（blocksActions）用在原来的 5 处：保存与退出编辑、交出与继续编辑、阅读时的进入与刷新、本机恢复的两个入口；取消请求照常', () => {
    const request: IncomingRequest = { id: 'request', requester: AMY, declining: false, failure: undefined }
    const fake = renderChrome({ mode: { kind: 'editing', request }, save: DIRTY, fake: { blocked: true } })
    for (const name of ['保存', '退出编辑', '交出', '继续编辑']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(button)
    }
    expect(fake.page.save).not.toHaveBeenCalled()
    expect(fake.page.exitEditing).not.toHaveBeenCalled()
    expect(fake.page.handOver).not.toHaveBeenCalled()
    expect(fake.page.keepEditing).not.toHaveBeenCalled()
    fake.set({ mode: { ...READING, update: 'available' }, save: undefined, recovery: RESTORE })
    for (const name of ['编辑', '有更新，点击刷新']) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(button)
    }
    for (const name of ['恢复并编辑', '放弃本机修改']) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(fake.page.enterEditing).not.toHaveBeenCalled()
    expect(fake.page.refreshUpdate).not.toHaveBeenCalled()
    expect(fake.page.beginDiscardRecovery).not.toHaveBeenCalled()
    fake.set({ mode: { ...READING, holder: OTHER_HOLDER, request: { kind: 'waiting', holder: AMY, cancelFailure: undefined } }, recovery: undefined })
    fireEvent.click(screen.getByRole('button', { name: '取消请求' }))
    expect(fake.page.cancelRequest).toHaveBeenCalledOnce()
    fake.set({ fake: { blocked: false } })
    fireEvent.click(screen.getByRole('button', { name: '取消请求' }))
    expect(fake.page.cancelRequest).toHaveBeenCalledTimes(2)
  })

  it('挡住时确认框的说明（actionBlocked）排在“需要联网”之前；不挡之后才说需要联网', async () => {
    const fake = renderChrome({ mode: { ...READING, canTakeOver: true, holder: OTHER_HOLDER }, save: undefined })
    fireEvent.click(screen.getByRole('button', { name: '强制接管' }))
    const dialog = await screen.findByRole('dialog', { name: '强制接管编辑？' })
    fake.set({ fake: { blocked: true }, connection: OFFLINE })
    const confirm = within(dialog).getByRole('button', { name: '强制接管' })
    expect(confirm).toHaveAttribute('aria-disabled', 'true')
    expect(within(dialog).getByText('假的扩展正挡着这个操作')).toBeVisible()
    expect(within(dialog).queryByText(CONNECTION_REQUIRED)).toBeNull()
    await act(async () => fireEvent.click(confirm))
    expect(fake.page.forceTakeOver).not.toHaveBeenCalled()
    fake.set({ fake: { blocked: false } })
    expect(within(dialog).getByText(CONNECTION_REQUIRED)).toBeVisible()
    expect(within(dialog).queryByText('假的扩展正挡着这个操作')).toBeNull()
  })

  it('快照被拒的说明（snapshotProblem）：保存被拒与副本被拒都交给插槽（详情与页面）；副本超过容量照旧按容量说', () => {
    const invalid = new ApiError(422, 'SNAPSHOT_INVALID', '快照不合规则', { details: { rule: 'link-address' } })
    const fake = renderChrome({ save: { ...DIRTY, status: 'failed', problem: { kind: 'request', error: invalid } } })
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败：假的快照说明（{"rule":"link-address"}，ready）')
    fake.set({ mode: lost({ kind: 'newer' }, { kind: 'refused', refusal: 'content', error: invalid }), save: undefined })
    expect(screen.getByRole('alert')).toHaveTextContent('没能另存为副本：假的快照说明（{"rule":"link-address"}，ready）。')
    fake.set({ mode: lost({ kind: 'newer' }, { kind: 'refused', refusal: 'content', error: new ApiError(413, 'PAYLOAD_TOO_LARGE', '超过上限') }) })
    expect(screen.getByRole('alert')).not.toHaveTextContent('假的快照说明')
  })

  it('相邻的条件变化时插槽各占原来的位置：工具行出现与消失、“需要联网”出现，说明里有焦点的按钮不重建、焦点不丢', () => {
    const fake = renderChrome({ save: DIRTY, fake: { blocked: false, note: '插槽的说明' } })
    const button = screen.getByRole('button', { name: '处理假的说明' })
    button.focus()
    fake.select(membersOf({ toolbar: true }))
    fake.set({})
    expect(slotIn(screen.getByRole('banner'), 'fake-toolbar')).toBeVisible()
    fake.set({ connection: OFFLINE })
    fake.select(membersOf())
    fake.set({})
    expect(screen.getByRole('banner').querySelector('[data-slot="fake-toolbar"]')).toBeNull()
    expect(screen.getByRole('button', { name: '处理假的说明' })).toBe(button)
    expect(button).toHaveFocus()
  })
})

describe('挡住动作读哪一份视图', () => {
  it('页头按渲染时的视图快照问插槽，不读页面扩展的 blocksActions()', () => {
    const fake = renderChrome({ save: DIRTY, fake: { blocked: false } }, membersOf({ blocksActions: vi.fn(() => true) }))
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toHaveAttribute('aria-disabled', 'false')
    fireEvent.click(save)
    expect(fake.page.save).toHaveBeenCalledOnce()
    fake.select(membersOf({ blocksActions: vi.fn(() => false) }))
    fake.set({ fake: { blocked: true } })
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('“放弃本机修改”与已经打开的确认框按 page.view() 的当前值问插槽：快照没挡住、当前值挡住时不开始、不执行', async () => {
    const fake = renderChrome({ mode: READING, save: undefined, recovery: RESTORE })
    fake.quietly({ fake: { blocked: true } })
    fireEvent.click(screen.getByRole('button', { name: '放弃本机修改' }))
    expect(fake.page.beginDiscardRecovery).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    fake.set({ fake: { blocked: false } })
    fireEvent.click(screen.getByRole('button', { name: '放弃本机修改' }))
    const dialog = await screen.findByRole('dialog', { name: '放弃这份本机修改？' })
    fake.quietly({ fake: { blocked: true } })
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: '确认放弃' })))
    expect(fake.page.discardRecovery).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()
  })
})

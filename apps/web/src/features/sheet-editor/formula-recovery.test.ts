import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, disposeSessions } from './editing-session.test-support.ts'
import { recoveryFixture } from './formula-recovery.test-support.ts'

vi.hoisted(() => {
  // 只使用公开出口中的真实 Worker 错误类型，不运行 Canvas。
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse())
    dispose()
  disposeSessions()
})

async function fixture(access: 'read' | 'edit', failedBeforeAttach = false) {
  const result = await recoveryFixture(access, failedBeforeAttach)
  cleanups.push(result.dispose)
  return result
}

describe('运行中的公式 Worker 恢复', () => {
  it('阅读故障排出当前事件栈，再按原快照和视图重建；不申请或保存', async () => {
    const h = await fixture('read')
    const acquire = vi.spyOn(h.options.api.editLease, 'acquire')
    h.original.fail()
    expect(h.createEditor).toHaveBeenCalledOnce()
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    expect(h.createEditor).toHaveBeenLastCalledWith({ snapshot: '{"v":"原内容"}', access: 'read', viewState: { sheetId: 'sheet-1', topLeft: { row: 7, column: 3 }, selection: undefined }, formulaMode: 'main-thread', recalculate: true })
    expect(h.original.disposed()).toBe(true)
    expect(h.slot.editor()).toBe(h.created[1]!.editor)
    expect(h.recovery.view()).toMatchObject({ phase: 'ready', blocksInput: false, blocksActions: false, failure: 'error-after-ready' })
    expect(acquire).not.toHaveBeenCalled()
    expect(h.options.api.save).not.toHaveBeenCalled()
  })

  it('先订阅再读 getter，接线前已发生的首错也能恢复', async () => {
    const h = await fixture('read', true)
    expect(h.original.failureListeners()).toBe(1)
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    expect(h.recovery.view()?.phase).toBe('ready')
  })

  it('编辑重建保留原保存资源、正文和逻辑序号，重算后补存', async () => {
    const h = await fixture('edit')
    const coordinator = h.session.coordinator!
    const scheduler = h.session.autosave!
    const draft = h.session.draft!
    h.original.edit('{"v":"未保存修改"}')
    h.original.fail()
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    expect(h.createEditor.mock.calls[1]![0].snapshot).toBe('{"v":"未保存修改"}')
    expect(h.session.coordinator).toBe(coordinator)
    expect(h.session.autosave).toBe(scheduler)
    expect(h.session.draft).toBe(draft)
    expect(h.session.lease).toBe(h.held)
    expect(h.session.captureEditor()!.changeSeq()).toBe(1)
    expect(coordinator.view().formulasPending).toBe(true)
    h.created[1]!.finishFormula('{"v":"未保存修改","formula":42}')
    await h.time.advance(2_000)
    await vi.waitFor(() => expect(coordinator.hasUnsavedWork()).toBe(false))
    expect(await draft.readLatest()).toMatchObject({ snapshot: '{"v":"未保存修改","formula":42}', ref: { editorSeq: 1, formulasPending: false } })
    h.created[1]!.edit('{"v":"新输入"}')
    expect(h.session.captureEditor()!.changeSeq()).toBe(2)
    expect(coordinator.view().unsavedEdits).toBe(true)
    expect(h.held.release).not.toHaveBeenCalled()
  })

  it('等待组字时不截断输入；组字结束也不在该事件栈捕获', async () => {
    const h = await fixture('edit')
    h.original.compose(true)
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'waiting-input', blocksInput: false, blocksActions: true })
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    expect(h.original.disposed()).toBe(false)
    h.original.edit('{"v":"组字提交"}')
    h.original.compose(false)
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    await h.time.advance(0)
    expect(h.createEditor.mock.calls[1]![0].snapshot).toBe('{"v":"组字提交"}')
    expect(h.recovery.view()?.phase).toBe('ready')
    expect(h.original.compositionListeners()).toBe(0)
  })

  it('等完旧保存的提交与面板准备，旧 await 不会读到新实例面板', async () => {
    const h = await fixture('edit')
    const commit = deferred<void>()
    const panels = deferred<void>()
    const original = vi.mocked(h.original.editor.commitCellEditing).getMockImplementation()!
    vi.mocked(h.original.editor.commitCellEditing).mockImplementationOnce(async () => {
      const result = original()
      await commit.promise
      return result
    })
    vi.mocked(h.original.editor.settlePanels).mockReturnValueOnce(panels.promise)
    h.original.beginInput()
    const saving = h.session.autosave!.flush('save-button', { ready: async () => false })
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'preparing', blocksInput: true })
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    commit.resolve()
    await h.time.advance(0)
    expect(h.original.editor.settlePanels).toHaveBeenCalledOnce()
    expect(h.original.disposed()).toBe(false)
    panels.resolve()
    await saving
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    expect(h.createEditor.mock.calls[1]![0].snapshot).toBe('{"v":"已提交的输入"}')
    expect(h.created[1]!.editor.settlePanels).not.toHaveBeenCalled()
  })

  it('提交不了时保留原实例并放开输入；明确重试后才重新准备', async () => {
    const h = await fixture('edit')
    h.original.control.commitResult = false
    h.original.beginInput()
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'failed', problem: 'input', blocksInput: false })
    expect(h.original.disposed()).toBe(false)
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    h.recovery.sync()
    await h.time.advance(0)
    expect(h.original.editor.commitCellEditing).toHaveBeenCalledOnce()
    h.original.control.commitResult = true
    h.recovery.retry()
    await h.time.advance(0)
    expect(h.recovery.view()?.phase).toBe('ready')
    expect(h.original.editor.commitCellEditing).toHaveBeenCalledTimes(2)
  })

  it('捕获失败不销毁原模型；修复后重试可保存当前内容', async () => {
    const h = await fixture('edit')
    h.original.control.failCapture = true
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'failed', problem: 'capture', blocksInput: false })
    expect(h.original.disposed()).toBe(false)
    expect(h.options.reportError).toHaveBeenCalledOnce()
    h.original.control.failCapture = false
    h.original.edit('{"v":"失败后补充"}')
    h.recovery.retry()
    await h.time.advance(0)
    expect(h.createEditor.mock.calls[1]![0].snapshot).toBe('{"v":"失败后补充"}')
    expect(h.recovery.view()?.phase).toBe('ready')
  })

  it('新建失败后保留冻结正文，重试不读取已销毁的旧模型', async () => {
    const h = await fixture('edit')
    h.failNext(new Error('主线程新建失败'))
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'failed', problem: 'create', blocksInput: true })
    expect(h.slot.editor()).toBeUndefined()
    expect(h.session.captureEditor()!.capture()).toBe('{"v":"原内容"}')
    expect(h.session.coordinator!.hasUnsavedWork()).toBe(true)
    const reads = vi.mocked(h.original.editor.capture).mock.calls.length
    h.recovery.retry()
    await h.time.advance(0)
    expect(h.recovery.view()?.phase).toBe('ready')
    expect(h.original.editor.capture).toHaveBeenCalledTimes(reads)
    expect(h.options.reportError).toHaveBeenCalledOnce()
  })

  it('新实例自检失败就丢弃，不绑定或捕获它；重试仍用原完整正文', async () => {
    const h = await fixture('edit')
    h.badCheckNext()
    h.original.edit('{"v":"完整原稿"}')
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'failed', problem: 'open-check', blocksInput: true })
    expect(h.created[1]!.disposed()).toBe(true)
    expect(h.created[1]!.editor.capture).not.toHaveBeenCalled()
    expect(h.session.captureEditor()!.capture()).toBe('{"v":"完整原稿"}')
    h.recovery.retry()
    await h.time.advance(0)
    expect(h.createEditor.mock.calls[2]![0].snapshot).toBe('{"v":"完整原稿"}')
    expect(h.recovery.view()?.phase).toBe('ready')
  })

  it('重复故障、sync 和重试保持单飞，已退订的旧回调不能再发起创建', async () => {
    const h = await fixture('read')
    const queued = vi.mocked(h.original.editor.onWorkerFailure).mock.calls[0]![0]
    const creating = h.holdNext()
    h.original.fail()
    await h.time.advance(0)
    h.original.fail()
    h.recovery.sync()
    h.recovery.retry()
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    creating.resolve()
    await h.time.advance(0)
    expect(h.recovery.view()?.phase).toBe('ready')
    queued('messageerror-after-ready')
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    expect(h.original.failureListeners()).toBe(0)
  })

  it.each(['session', 'permission', 'generation', 'lease', 'lock', 'dispose'] as const)('创建在途时 %s 失效，迟到结果不接纳，原冻结正文仍可读取', async (cause) => {
    const h = await fixture('edit')
    const creating = h.holdNext()
    h.original.fail()
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    if (cause === 'session') {
      h.setContext({ active: false })
    }
    else if (cause === 'permission') {
      h.setContext({ allowed: false })
    }
    else if (cause === 'generation') {
      h.setContext({ generation: 2, access: undefined })
    }
    else if (cause === 'lease') {
      h.session.detachLease()
      h.recovery.sync()
    }
    else if (cause === 'lock') {
      h.session.releaseLock()
      h.recovery.sync()
    }
    else {
      h.recovery.dispose()
    }
    creating.resolve()
    await h.time.advance(0)
    expect(h.created[1]!.disposed()).toBe(true)
    expect(h.slot.editor()).toBeUndefined()
    expect(h.session.captureEditor()!.capture()).toBe('{"v":"原内容"}')
    expect(h.options.api.save).not.toHaveBeenCalled()
  })

  it('输入准备等待中开始另一流程，旧准备结束不能销毁实例或撤掉别人挂起的调度', async () => {
    const h = await fixture('edit')
    const panels = deferred<void>()
    vi.mocked(h.original.editor.settlePanels).mockReturnValueOnce(panels.promise)
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()?.phase).toBe('preparing')
    const resume = vi.spyOn(h.session.autosave!, 'resume')
    h.setContext({ generation: 2, access: undefined })
    panels.resolve()
    await h.time.advance(0)
    expect(h.original.disposed()).toBe(false)
    expect(h.createEditor).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
  })

  it('组字等待时销毁会清理监听，迟到 compositionend 不再操作页面', async () => {
    const h = await fixture('edit')
    h.original.compose(true)
    h.original.fail()
    await h.time.advance(0)
    h.recovery.dispose()
    h.session.stopSaving()
    expect(h.original.compositionListeners()).toBe(0)
    expect(h.original.failureListeners()).toBe(0)
    h.original.compose(false)
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledOnce()
  })

  it('会话离开又回来不能重新接纳旧创建；清理后以冻结正文开始新一轮', async () => {
    const h = await fixture('edit')
    const first = h.holdNext()
    h.original.edit('{"v":"跨会话等待的原稿"}')
    h.original.fail()
    await h.time.advance(0)
    h.setContext({ active: false })
    h.setContext({ active: true })
    const second = h.holdNext()
    first.resolve()
    await h.time.advance(0)
    expect(h.created[1]!.disposed()).toBe(true)
    expect(h.slot.editor()).toBeUndefined()
    expect(h.createEditor).toHaveBeenCalledTimes(3)
    expect(h.createEditor.mock.calls[2]![0].snapshot).toBe('{"v":"跨会话等待的原稿"}')
    second.resolve()
    await h.time.advance(0)
    expect(h.slot.editor()).toBe(h.created[2]!.editor)
    expect(h.recovery.view()?.phase).toBe('ready')
  })

  it('提交输入的 await 中失权，不再读取旧实例面板或捕获正文', async () => {
    const h = await fixture('edit')
    const commit = deferred<boolean>()
    h.original.beginInput()
    vi.mocked(h.original.editor.commitCellEditing).mockReturnValueOnce(commit.promise)
    h.original.fail()
    await h.time.advance(0)
    expect(h.original.editor.commitCellEditing).toHaveBeenCalledOnce()
    h.setContext({ active: false })
    commit.resolve(true)
    await h.time.advance(0)
    expect(h.original.editor.settlePanels).not.toHaveBeenCalled()
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    expect(h.original.disposed()).toBe(false)
  })

  it('已有保存准备期间失权，准备兑现后不提交第二次输入', async () => {
    const h = await fixture('edit')
    const panels = deferred<void>()
    vi.mocked(h.original.editor.settlePanels).mockReturnValueOnce(panels.promise)
    const saving = h.session.autosave!.flush('save-button', { ready: async () => false })
    h.original.fail()
    await h.time.advance(0)
    h.setContext({ active: false })
    panels.resolve()
    await saving
    await h.time.advance(0)
    expect(h.original.editor.settlePanels).toHaveBeenCalledOnce()
    expect(h.original.editor.capture).not.toHaveBeenCalled()
    expect(h.createEditor).toHaveBeenCalledOnce()
  })

  it('面板准备抛错时保留旧实例，解除输入屏障并报告一次', async () => {
    const h = await fixture('edit')
    vi.mocked(h.original.editor.settlePanels).mockRejectedValueOnce(new Error('面板写入失败'))
    h.original.fail()
    await h.time.advance(0)
    expect(h.recovery.view()).toMatchObject({ phase: 'failed', problem: 'input', blocksInput: false })
    expect(h.original.disposed()).toBe(false)
    expect(h.options.reportError).toHaveBeenCalledOnce()
    h.recovery.retry()
    await h.time.advance(0)
    expect(h.recovery.view()?.phase).toBe('ready')
  })

  it('其他切换流程正在进行时只记模式偏好，回到稳定阅读后才组织恢复', async () => {
    const h = await fixture('read')
    h.setContext({ generation: 2, access: undefined })
    h.original.fail()
    await h.time.advance(0)
    expect(h.fallback.mode()).toBe('main-thread')
    expect(h.createEditor).toHaveBeenCalledOnce()
    h.setContext({ access: 'read' })
    await h.time.advance(0)
    expect(h.createEditor).toHaveBeenCalledTimes(2)
    expect(h.recovery.view()?.phase).toBe('ready')
  })
})

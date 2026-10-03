import type { SaveContentResponse } from '@nerve-office/contracts'
import type { SaveEditor, SaveRequest } from './save-coordinator.ts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError } from '../../shared/api/index.ts'
import { createSaveCoordinator } from './save-coordinator.ts'

const ME = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const OTHER_TAB = '0199a2c4-1f2e-4a3b-8c4d-00000000bbbb'

/**
 * 假的编辑器：edit() 是一次修改；可以设定正在编辑、提交的结果与公式收齐的结果。
 * startCellEditing 打开单元格编辑器，typed 为真时编辑中的内容已经改动（还没提交的输入）
 */
function fakeEditor() {
  let seq = 0
  let content = '初始'
  let editing = false
  let pendingInput = false
  const listeners = new Set<() => void>()
  const cellEditingListeners = new Set<() => void>()
  const notify = (): void => listeners.forEach(listener => listener())
  const setPendingInput = (next: boolean): void => {
    pendingInput = next
    cellEditingListeners.forEach(listener => listener())
  }
  const control = {
    commitResult: true,
    settle: 'settled' as 'settled' | 'timeout',
    edit(text: string): void {
      content = text
      seq += 1
      notify()
    },
    startCellEditing(text: string, typed = true): void {
      editing = true
      content = text
      setPendingInput(typed)
    },
    /** 编辑中的内容改动了（例如双击打开之后键入） */
    typeInCellEditor(): void {
      setPendingInput(true)
    },
    /** 按 Esc 放弃编辑 */
    cancelCellEditing(): void {
      editing = false
      setPendingInput(false)
    },
  }
  const editor: SaveEditor = {
    changeSeq: () => seq,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isCellEditing: () => editing,
    hasPendingCellInput: () => pendingInput,
    onCellEditingChange: (listener) => {
      cellEditingListeners.add(listener)
      return () => cellEditingListeners.delete(listener)
    },
    commitCellEditing: vi.fn(async () => {
      if (!control.commitResult)
        return false
      editing = false
      seq += 1
      setPendingInput(false)
      notify()
      return true
    }),
    settleFormulas: vi.fn(async () => control.settle),
    capture: vi.fn(() => JSON.stringify({ content })),
  }
  return { editor, control }
}

interface PendingSend {
  readonly request: SaveRequest
  /** 压缩之后的正文（假的压缩：快照的 UTF-8 字节） */
  readonly body: Uint8Array
  resolve: (response: SaveContentResponse) => void
  reject: (error: unknown) => void
}

/** 假的上传：每次调用挂起，由测试决定结果 */
function fakeSend() {
  const calls: PendingSend[] = []
  const send = vi.fn(async (request: SaveRequest, body: Uint8Array<ArrayBuffer>) => new Promise<SaveContentResponse>((resolve, reject) => {
    calls.push({ request, body, resolve, reject })
  }))
  return { send, calls }
}

/** 假的压缩：快照的 UTF-8 字节 */
const fakeCompress = vi.fn(async (snapshot: string) => new TextEncoder().encode(snapshot))

let idSequence = 0
function setup(overrides: { baseRevision?: number, maxSnapshotBytes?: number } = {}) {
  const { editor, control } = fakeEditor()
  const { send, calls } = fakeSend()
  const onUnauthenticated = vi.fn()
  const onSessionStale = vi.fn()
  const reportError = vi.fn()
  const compress = vi.fn(fakeCompress)
  const coordinator = createSaveCoordinator({
    editor,
    compress,
    send,
    baseRevision: overrides.baseRevision ?? 1,
    clientInstanceId: ME,
    newRequestId: () => {
      idSequence += 1
      return `request-${idSequence}`
    },
    onUnauthenticated,
    onSessionStale,
    reportError,
    maxSnapshotBytes: overrides.maxSnapshotBytes,
  })
  return { coordinator, editor, control, compress, send, calls, onUnauthenticated, onSessionStale, reportError }
}

/** 等保存流程走到发出请求（提交编辑、等公式收齐都是异步的） */
async function sent(calls: PendingSend[], count: number): Promise<PendingSend> {
  await vi.waitFor(() => expect(calls.length).toBe(count))
  const call = calls[count - 1]
  if (call === undefined)
    throw new Error('没有发出请求')
  return call
}

function saved(revision: number): SaveContentResponse {
  return { revision, savedAt: '2026-09-27T08:00:00.000Z' }
}

function conflictError(currentRevision: number, source: { clientInstanceId: string, localSeq: number } | null): ApiError {
  return new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '别处保存了更新的版本', { details: { currentRevision, source } })
}

describe('保存状态', () => {
  it('打开时已保存；修改之后有未保存的修改；保存中；成功后已保存到云端，基准修订号前进', async () => {
    const { coordinator, control, calls } = setup({ baseRevision: 4 })
    expect(coordinator.view().status).toBe('clean')
    control.edit('甲')
    expect(coordinator.view().status).toBe('dirty')

    const saving = coordinator.save()
    expect(coordinator.view()).toMatchObject({ status: 'saving', canSave: false })
    const first = await sent(calls, 1)
    expect(first.request).toMatchObject({ baseRevision: 4, clientInstanceId: ME, localSeq: 1, snapshot: '{"content":"甲"}' })
    first.resolve(saved(5))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'clean', canSave: true, problem: undefined })

    control.edit('乙')
    const again = coordinator.save()
    ;(await sent(calls, 2)).resolve(saved(6))
    await again
    expect(calls[1]?.request).toMatchObject({ baseRevision: 5, localSeq: 2 })
    expect(calls[1]?.request.requestId).not.toBe(calls[0]?.request.requestId)
  })

  it('保存中再按：不做任何事，同一时间只有一个保存在途', async () => {
    const { coordinator, control, calls, send } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    await coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('保存期间继续修改：回包后仍是有未保存的修改（已保存的序号只前进到捕获时，A08）', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    control.edit('甲乙')
    expect(coordinator.view().status).toBe('saving')
    request.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('dirty')
    expect(coordinator.hasUnsavedWork()).toBe(true)
  })

  it('没有修改也可以保存：照常上传', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(calls[0]?.request.localSeq).toBe(0)
    expect(coordinator.view().status).toBe('clean')
  })

  it('没有变化时不重复通知：视图对象不变', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    const before = coordinator.view()
    control.edit('甲')
    control.edit('乙')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(coordinator.view()).not.toBe(before)
    const dirty = coordinator.view()
    control.edit('丙')
    expect(coordinator.view()).toBe(dirty)
  })
})

describe('有没有服务端还没确认的内容（unsaved：只看内容，不看保存的状态，M3-P1 审查 B3）', () => {
  it('打开时没有；修改之后有；保存成功之后没有', async () => {
    const { coordinator, control, calls } = setup()
    expect(coordinator.view().unsaved).toBe(false)
    control.edit('甲')
    expect(coordinator.view().unsaved).toBe(true)
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view().unsaved).toBe(false)
  })

  it('没有修改时按保存、保存被拒：状态是保存失败，内容却都已确认，不算有；有修改时被拒才算有', async () => {
    const denied = new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看')
    const clean = setup()
    const first = clean.coordinator.save()
    ;(await sent(clean.calls, 1)).reject(denied)
    await first
    expect(clean.coordinator.view()).toMatchObject({ status: 'failed', unsaved: false })

    const dirty = setup()
    dirty.control.edit('甲')
    const second = dirty.coordinator.save()
    ;(await sent(dirty.calls, 1)).reject(denied)
    await second
    expect(dirty.coordinator.view()).toMatchObject({ status: 'failed', unsaved: true })
  })

  it('单元格里还有没提交的输入：算有；按 Esc 放弃之后不算', () => {
    const { coordinator, control } = setup()
    control.startCellEditing('甲')
    expect(coordinator.view().unsaved).toBe(true)
    control.cancelCellEditing()
    expect(coordinator.view().unsaved).toBe(false)
  })

  it('公式结果尚未保存：算有', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('=SUM(A1:A9)')
    control.settle = 'timeout'
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view()).toMatchObject({ formulasPending: true, unsaved: true })
  })

  it('版本冲突之后：本页的内容没有存进去，算有', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(conflictError(3, { clientInstanceId: OTHER_TAB, localSeq: 7 }))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'conflict', unsaved: true })
  })
})

describe('单元格里还没提交的输入（Codex 评审 CX6）', () => {
  it('键入之后还没回车：有未保存的修改；按 Esc 放弃，回到已保存到云端', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    control.startCellEditing('还没回车')
    expect(coordinator.view().status).toBe('dirty')
    expect(listener).toHaveBeenCalledOnce()
    control.cancelCellEditing()
    expect(coordinator.view().status).toBe('clean')
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })

  it('只是打开单元格编辑器、还没改动：仍是已保存到云端，离开时照样提示；改动之后有未保存的修改', () => {
    const { coordinator, control } = setup()
    control.startCellEditing('初始', false)
    expect(coordinator.view().status).toBe('clean')
    expect(coordinator.hasUnsavedWork()).toBe(true)
    control.typeInCellEditor()
    expect(coordinator.view().status).toBe('dirty')
  })

  it('保存成功之后又在单元格里键入：立即是有未保存的修改', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
    control.startCellEditing('乙')
    expect(coordinator.view().status).toBe('dirty')
  })

  it('保存期间在单元格里键入：仍显示保存中，回包之后是有未保存的修改', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    control.startCellEditing('乙')
    expect(coordinator.view().status).toBe('saving')
    request.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('dirty')
  })

  it('销毁之后不再通知', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.dispose()
    control.startCellEditing('甲')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('保存之前：提交正在编辑的单元格、等公式收齐、检查体积', () => {
  it('单元格正在编辑：先提交（等同回车），提交的内容一起保存', async () => {
    const { coordinator, editor, control, calls } = setup()
    control.startCellEditing('编辑中的值')
    expect(coordinator.hasUnsavedWork()).toBe(true)
    const saving = coordinator.save()
    const request = await sent(calls, 1)
    expect(editor.commitCellEditing).toHaveBeenCalledOnce()
    expect(request.request).toMatchObject({ localSeq: 1, snapshot: '{"content":"编辑中的值"}' })
    request.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
  })

  it('提交不了：中止保存，提示先完成单元格的编辑，不上传，状态照旧', async () => {
    const { coordinator, control, send } = setup()
    control.edit('甲')
    control.startCellEditing('不合格的值')
    control.commitResult = false
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'dirty', problem: { kind: 'cell-editing' }, canSave: true })
  })

  it('先提交编辑，再等公式收齐（最多 3 秒），然后捕获', async () => {
    const { coordinator, editor, control, calls } = setup()
    control.startCellEditing('=A1+1')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(editor.settleFormulas).toHaveBeenCalledWith(3000)
    const commitOrder = vi.mocked(editor.commitCellEditing).mock.invocationCallOrder[0] ?? 0
    const settleOrder = vi.mocked(editor.settleFormulas).mock.invocationCallOrder[0] ?? 0
    const captureOrder = vi.mocked(editor.capture).mock.invocationCallOrder[0] ?? 0
    expect(commitOrder).toBeLessThan(settleOrder)
    expect(settleOrder).toBeLessThan(captureOrder)
  })

  it('公式 3 秒没收齐：照常保存，成功后提示公式结果尚未保存，仍算有未保存的修改；下一次收齐的保存之后消失', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('=SUM(A1:A9)')
    control.settle = 'timeout'
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'dirty', formulasPending: true })
    expect(coordinator.hasUnsavedWork()).toBe(true)

    control.settle = 'settled'
    const again = coordinator.save()
    ;(await sent(calls, 2)).resolve(saved(3))
    await again
    expect(coordinator.view()).toMatchObject({ status: 'clean', formulasPending: false })
  })

  it('序列化之后超过上限：提示容量上限，不上传', async () => {
    const { coordinator, control, send } = setup({ maxSnapshotBytes: 20 })
    control.edit('这段内容按 UTF-8 超过二十个字节')
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'too-large' } })
  })
})

describe('版本冲突', () => {
  it('别处保存了更新的版本：进入冲突，保留本页内容，禁止继续保存，离开时提示', async () => {
    const { coordinator, control, calls, send } = setup()
    control.edit('本页的修改')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(conflictError(3, { clientInstanceId: OTHER_TAB, localSeq: 7 }))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'conflict', canSave: false, conflict: { currentRevision: 3, source: { clientInstanceId: OTHER_TAB, localSeq: 7 } } })
    expect(coordinator.hasUnsavedWork()).toBe(true)
    await coordinator.save()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('冲突的详情认不出来：仍是冲突', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', 'x', { details: { currentRevision: 'x' } }))
    await saving
    expect(coordinator.view()).toMatchObject({ status: 'conflict', conflict: null })
  })

  it('自己追自己：上一次保存没收到回包却已提交，冲突的来源是它；换上当前修订号，用新的 requestId 立即重发一次', async () => {
    const { coordinator, control, calls } = setup({ baseRevision: 1 })
    control.edit('甲')
    const first = coordinator.save()
    const lost = await sent(calls, 1)
    lost.reject(new NetworkError('回包丢了'))
    await first
    expect(coordinator.view().status).toBe('failed')

    control.edit('甲乙')
    const second = coordinator.save()
    const stale = await sent(calls, 2)
    expect(stale.request).toMatchObject({ baseRevision: 1, localSeq: 2 })
    stale.reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 3)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 2, snapshot: '{"content":"甲乙"}' })
    expect(new Set(calls.map(call => call.request.requestId)).size).toBe(3)
    resent.resolve(saved(3))
    await second
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it('自己追自己只重发一次：重发又冲突，就是真正的冲突', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('回包丢了'))
    await first
    control.edit('甲乙')
    const second = coordinator.save()
    ;(await sent(calls, 2)).reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    ;(await sent(calls, 3)).reject(conflictError(3, { clientInstanceId: OTHER_TAB, localSeq: 4 }))
    await second
    expect(coordinator.view()).toMatchObject({ status: 'conflict', conflict: { currentRevision: 3 } })
    expect(calls).toHaveLength(3)
  })

  it('两次都没收到回包，其实是较早的一次提交了：同样认得出来', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('回包丢了'))
    await first
    control.edit('甲乙')
    const second = coordinator.save()
    ;(await sent(calls, 2)).reject(new NetworkError('请求没有到达'))
    await second
    control.edit('甲乙丙')
    const third = coordinator.save()
    ;(await sent(calls, 3)).reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 4)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 3 })
    resent.resolve(saved(3))
    await third
    expect(coordinator.view().status).toBe('clean')
  })

  it('来源是本页、却不是结果未知的保存：真正的冲突', async () => {
    const { coordinator, calls } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(conflictError(5, { clientInstanceId: ME, localSeq: 99 }))
    await saving
    expect(coordinator.view().status).toBe('conflict')
    expect(calls).toHaveLength(1)
  })
})

describe('重试原样再发结果未知的请求（Codex 评审 CX2）', () => {
  /** 修改之后保存，回包丢了：服务端可能已经提交；返回那次请求 */
  async function lostSave(context: ReturnType<typeof setup>, text: string): Promise<SaveRequest> {
    const { coordinator, control, calls } = context
    control.edit(text)
    const saving = coordinator.save()
    const request = await sent(calls, calls.length + 1)
    request.reject(new NetworkError('回包丢了'))
    await saving
    return request.request
  }

  it('改了又撤销、内容回到原样：重试原样再发，序号仍是第一次的；成功后确认到这次捕获的序号', async () => {
    const context = setup()
    const { coordinator, control, calls } = context
    const first = await lostSave(context, '甲')
    control.edit('甲乙')
    control.edit('甲')
    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request).toBe(first)
    expect(second.request.localSeq).toBe(1)
    second.resolve(saved(2))
    await retry
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it('原样再发的回包又丢了，之后继续修改再保存：冲突的来源是第一次的序号，认得出自己追自己', async () => {
    const context = setup()
    const { coordinator, control, calls } = context
    await lostSave(context, '甲')
    control.edit('甲乙')
    control.edit('甲')
    const retry = coordinator.save()
    ;(await sent(calls, 2)).reject(new NetworkError('回包又丢了'))
    await retry

    control.edit('甲丙')
    const third = coordinator.save()
    const stale = await sent(calls, 3)
    expect(stale.request).toMatchObject({ baseRevision: 1, localSeq: 4 })
    stale.reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 4)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 4, snapshot: '{"content":"甲丙"}' })
    resent.resolve(saved(3))
    await third
    expect(coordinator.view()).toMatchObject({ status: 'clean', conflict: undefined })
  })

  it('原样再发被明确拒绝（登录过期）：更早那次仍可能已经提交，记录留着；重新登录后继续修改再保存，认得出自己追自己', async () => {
    const context = setup()
    const { coordinator, control, calls, onUnauthenticated } = context
    const first = await lostSave(context, '甲')
    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request).toBe(first)
    second.reject(new ApiError(401, 'SESSION_EXPIRED', '登录已过期'))
    await retry
    expect(onUnauthenticated).toHaveBeenCalledOnce()

    control.edit('甲乙')
    const third = coordinator.save()
    ;(await sent(calls, 3)).reject(conflictError(2, { clientInstanceId: ME, localSeq: 1 }))
    const resent = await sent(calls, 4)
    expect(resent.request).toMatchObject({ baseRevision: 2, localSeq: 2 })
    resent.resolve(saved(3))
    await third
    expect(coordinator.view()).toMatchObject({ status: 'clean', conflict: undefined, problem: undefined })
  })

  it('原样再发被明确拒绝之后，内容没变再保存：仍原样再发那个请求', async () => {
    const context = setup()
    const { coordinator, calls } = context
    const first = await lostSave(context, '甲')
    const retry = coordinator.save()
    ;(await sent(calls, 2)).reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await retry
    const again = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request).toBe(first)
    third.resolve(saved(2))
    await again
    expect(coordinator.view().status).toBe('clean')
  })

  it('原样再发得到 requestId 被占用：原样再发也一样，下一次换新的 requestId', async () => {
    const context = setup()
    const { coordinator, calls } = context
    const first = await lostSave(context, '甲')
    const retry = coordinator.save()
    ;(await sent(calls, 2)).reject(new ApiError(409, 'REQUEST_ID_CONFLICT', 'requestId 已被使用'))
    await retry
    const again = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request.requestId).not.toBe(first.requestId)
    expect(third.request).toMatchObject({ baseRevision: 1, localSeq: 1, snapshot: first.snapshot })
    third.resolve(saved(2))
    await again
  })
})

describe('保存失败', () => {
  it.each([
    ['网络错误', new NetworkError('断网')],
    ['5xx', new ApiError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用')],
    ['回包与契约不一致', new ResponseFormatError('回包不对')],
  ])('%s：保存失败；内容没变时重试沿用同一个 requestId，内容变了就换一个', async (_case, error) => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(error)
    await first
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error } })
    expect(coordinator.hasUnsavedWork()).toBe(true)

    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request).toEqual(calls[0]?.request)
    second.reject(error)
    await retry

    control.edit('甲乙')
    const changed = coordinator.save()
    const third = await sent(calls, 3)
    expect(third.request.requestId).not.toBe(calls[0]?.request.requestId)
    third.resolve(saved(2))
    await changed
    expect(coordinator.view()).toMatchObject({ status: 'clean', problem: undefined })
  })

  it.each([
    ['超过上限（413）', new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体解压后超过上限')],
    ['快照不合格（422）', new ApiError(422, 'SNAPSHOT_INVALID', '表格内容的格式不正确')],
    ['文档不在了（404）', new ApiError(404, 'NOT_FOUND', '不存在')],
  ])('%s：保存失败，显示原因；确定没有提交，重试换新的 requestId', async (_case, error) => {
    const { coordinator, calls } = setup()
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(error)
    await first
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request', error } })
    const retry = coordinator.save()
    const second = await sent(calls, 2)
    expect(second.request.requestId).not.toBe(calls[0]?.request.requestId)
    second.resolve(saved(2))
    await retry
  })

  it('未登录或登录已过期：交给页面向服务端确认会话', async () => {
    const { coordinator, calls, onUnauthenticated } = setup()
    const saving = coordinator.save()
    const error = new ApiError(401, 'SESSION_EXPIRED', '登录已过期')
    ;(await sent(calls, 1)).reject(error)
    await saving
    expect(onUnauthenticated).toHaveBeenCalledWith(error)
    expect(coordinator.view().status).toBe('failed')
  })

  it('CSRF 令牌不对：交给页面向服务端确认会话', async () => {
    const { coordinator, calls, onSessionStale } = setup()
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效'))
    await saving
    expect(onSessionStale).toHaveBeenCalledOnce()
    expect(coordinator.view().status).toBe('failed')
  })

  it('失败之后再保存：先清掉上一次的原因', async () => {
    const { coordinator, calls } = setup()
    const first = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await first
    const retry = coordinator.save()
    expect(coordinator.view()).toMatchObject({ status: 'saving', problem: undefined })
    ;(await sent(calls, 2)).resolve(saved(2))
    await retry
  })
})

describe('保存流程本身出错（审查 B5）', () => {
  it('捕获时出错：显示保存失败并上报，不发请求；save 不会被拒绝', async () => {
    const { coordinator, editor, control, send, reportError } = setup()
    control.edit('甲')
    const failure = new Error('SDK 的 save() 出错')
    vi.mocked(editor.capture).mockImplementationOnce(() => {
      throw failure
    })
    await expect(coordinator.save()).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure }, canSave: true })
    expect(reportError).toHaveBeenCalledWith(failure)
    expect(coordinator.hasUnsavedWork()).toBe(true)
  })

  it('压缩时出错：同样按意外的错误处理，不当作结果未知的请求，下一次换新的 requestId（复验 RB8）', async () => {
    const { coordinator, control, compress, send, calls, reportError } = setup()
    control.edit('甲')
    const failure = new Error('压缩出错')
    compress.mockRejectedValueOnce(failure)
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'unexpected', error: failure } })
    expect(reportError).toHaveBeenCalledWith(failure)
    const saving = coordinator.save()
    const call = await sent(calls, 1)
    expect(new TextDecoder().decode(call.body)).toBe(call.request.snapshot)
    call.resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
  })

  it('提交编辑或等公式收齐时出错：同样', async () => {
    const { coordinator, editor, control, reportError } = setup()
    control.startCellEditing('x')
    vi.mocked(editor.commitCellEditing).mockRejectedValueOnce(new Error('提交出错'))
    await coordinator.save()
    expect(coordinator.view().problem?.kind).toBe('unexpected')
    vi.mocked(editor.settleFormulas).mockRejectedValueOnce(new Error('收齐出错'))
    control.commitResult = true
    await coordinator.save()
    expect(coordinator.view().problem?.kind).toBe('unexpected')
    expect(reportError).toHaveBeenCalledTimes(2)
  })
})

describe('会话恢复之后清掉会话类的失败（复验 RB2）', () => {
  it.each([
    ['登录已过期', new ApiError(401, 'SESSION_EXPIRED', '登录已过期')],
    ['令牌失效', new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效')],
  ])('%s：会话确认有效之后说明不再成立，回到有未保存的修改', async (_case, error) => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(error)
    await saving
    expect(coordinator.view().status).toBe('failed')
    coordinator.dismissSessionProblem()
    expect(coordinator.view()).toMatchObject({ status: 'dirty', problem: undefined })
  })

  it('其他失败不清掉', async () => {
    const { coordinator, control, calls } = setup()
    control.edit('甲')
    const saving = coordinator.save()
    ;(await sent(calls, 1)).reject(new NetworkError('断网'))
    await saving
    coordinator.dismissSessionProblem()
    expect(coordinator.view()).toMatchObject({ status: 'failed', problem: { kind: 'request' } })
  })
})

describe('停止保存与离开', () => {
  it('页面停止保存（别的标签页换了人）：之后的保存不做；恢复之后照常保存', async () => {
    const { coordinator, control, send, calls } = setup()
    control.edit('甲')
    coordinator.stop()
    expect(coordinator.view().canSave).toBe(false)
    await coordinator.save()
    expect(send).not.toHaveBeenCalled()
    expect(coordinator.hasUnsavedWork()).toBe(true)
    coordinator.resume()
    expect(coordinator.view().canSave).toBe(true)
    const saving = coordinator.save()
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.view().status).toBe('clean')
  })

  it('没有修改、没有正在编辑、没有在途的保存：离开不提示', async () => {
    const { coordinator, calls } = setup()
    expect(coordinator.hasUnsavedWork()).toBe(false)
    const saving = coordinator.save()
    expect(coordinator.hasUnsavedWork()).toBe(true)
    ;(await sent(calls, 1)).resolve(saved(2))
    await saving
    expect(coordinator.hasUnsavedWork()).toBe(false)
  })

  it('销毁之后不再通知', () => {
    const { coordinator, control } = setup()
    const listener = vi.fn()
    coordinator.subscribe(listener)
    coordinator.dispose()
    control.edit('甲')
    expect(listener).not.toHaveBeenCalled()
  })
})

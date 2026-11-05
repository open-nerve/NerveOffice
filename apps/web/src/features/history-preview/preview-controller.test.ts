import type { SessionImageAccessController } from '../../shared/lib/session-image-access.ts'
import type { PreviewDependencies, PreviewEditor } from './preview-controller.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { HISTORY_SESSION, historyItem } from '../../shared/testing/history.test-support.ts'
import { createHistoryPreview } from './preview-controller.ts'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(disposers.splice(0).map(async dispose => dispose()))
})
function setup(patch: Partial<PreviewDependencies> = {}) {
  const editor: PreviewEditor = { usable: true, dispose: vi.fn(async () => {}) }
  let images: SessionImageAccessController | undefined
  const deps = {
    session: vi.fn(async () => HISTORY_SESSION),
    detail: vi.fn(async () => historyItem()),
    content: vi.fn(async () => '{"history":"original"}'),
    mount: vi.fn(async (_text: string, access: SessionImageAccessController) => {
      images = access
      return editor
    }),
    adopt: vi.fn(),
    ...patch,
  }
  const preview = createHistoryPreview(deps)
  disposers.push(preview.dispose)
  return { preview, deps, editor, images: () => images }
}

describe('US-M5-10 独立历史预览生命周期', () => {
  it('加载与复核资格后才显示，读原正文；同一身份周期复核保留实例，不再次加载正文', async () => {
    const w = setup()
    await w.preview.refresh()
    expect(w.preview.view()).toMatchObject({ kind: 'ready', history: historyItem() })
    expect(w.deps.mount).toHaveBeenCalledWith('{"history":"original"}', expect.anything(), historyItem())
    expect(w.images()?.current()).toBe(HISTORY_SESSION)
    await w.preview.refresh('background')
    expect(w.deps.mount).toHaveBeenCalledTimes(1)
    expect(w.deps.content).toHaveBeenCalledTimes(1)
    expect(w.deps.detail).toHaveBeenCalledTimes(4)
    expect(w.deps.session).toHaveBeenNthCalledWith(1, expect.any(AbortSignal), 'user')
    for (const call of [2, 3, 4])
      expect(w.deps.session).toHaveBeenNthCalledWith(call, expect.any(AbortSignal), 'background')
  })

  it.each([{ compatibility: 'unsupported' as const }, { sdkVersion: '999.0.0' }, { profile: 'sheet@999' }, { formatVersion: 999 }])('本页不支持格式 %j 时不读取正文或挂载 SDK', async (patch) => {
    const w = setup({ detail: vi.fn(async () => historyItem(patch)) })
    await w.preview.refresh()
    expect(w.preview.view()).toEqual({ kind: 'unsupported' })
    expect(w.deps.content).not.toHaveBeenCalled()
    expect(w.deps.mount).not.toHaveBeenCalled()
  })

  it.each([new ApiError(403, 'PERMISSION_DENIED', '撤权'), new ApiError(404, 'NOT_FOUND', '清除或到期')])('复核历史被拒：立即关图片，销毁旧实例且隐藏正文（%s）', async (error) => {
    const w = setup()
    await w.preview.refresh()
    vi.mocked(w.deps.detail).mockRejectedValueOnce(error)
    const refresh = w.preview.refresh()
    expect(w.images()?.current()).toBeUndefined()
    expect(w.preview.view().kind).toBe('loading')
    await refresh
    expect(w.preview.view()).toEqual({ kind: 'unavailable' })
    expect(w.editor.dispose).toHaveBeenCalledTimes(1)
  })

  it('会话换人后不能重新挂载旧内容，清除原会话并给出重新打开提示', async () => {
    const w = setup()
    await w.preview.refresh()
    vi.mocked(w.deps.session).mockResolvedValue({ ...HISTORY_SESSION, user: { ...HISTORY_SESSION.user, id: 'another-user' } })
    await w.preview.refresh()
    expect(w.preview.view()).toEqual({ kind: 'changed-user' })
    expect(w.images()?.current()).toBeUndefined()
    expect(w.editor.dispose).toHaveBeenCalledTimes(1)
    expect(w.deps.adopt).toHaveBeenLastCalledWith(undefined)
    await w.preview.refresh()
    expect(w.deps.mount).toHaveBeenCalledTimes(1)
  })

  it('会话失效销毁；网络失败也不继续显示未经确认的旧正文，恢复后可重试', async () => {
    const w = setup()
    await w.preview.refresh()
    vi.mocked(w.deps.detail).mockRejectedValueOnce(new NetworkError('断网'))
    await w.preview.refresh()
    expect(w.preview.view().kind).toBe('failed')
    expect(w.editor.dispose).toHaveBeenCalledTimes(1)
    await w.preview.refresh()
    expect(w.preview.view().kind).toBe('ready')
    vi.mocked(w.deps.session).mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', '未登录'))
    await w.preview.refresh()
    expect(w.preview.view().kind).toBe('signed-out')
  })

  it('正文回包前撤权：最后复核失败，旧正文没有机会进入 SDK', async () => {
    const body = deferred<string>()
    const w = setup({ content: vi.fn(async () => body.promise) })
    const pending = w.preview.refresh()
    await vi.waitFor(() => expect(w.deps.content).toHaveBeenCalledTimes(1))
    vi.mocked(w.deps.detail).mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', '撤权'))
    body.resolve('stale')
    await pending
    expect(w.preview.view().kind).toBe('unavailable')
    expect(w.deps.mount).not.toHaveBeenCalled()
  })

  it('晚到的正文不能覆盖较新的复核，卸载后不能再挂载或通知', async () => {
    const body = deferred<string>()
    const w = setup()
    vi.mocked(w.deps.content).mockImplementationOnce(async () => body.promise)
    const old = w.preview.refresh()
    await vi.waitFor(() => expect(w.deps.content).toHaveBeenCalledTimes(1))
    const changed = vi.fn()
    w.preview.subscribe(changed)
    await w.preview.refresh()
    const calls = vi.mocked(w.deps.mount).mock.calls.length
    body.resolve('old')
    await old
    expect(w.deps.mount).toHaveBeenCalledTimes(calls)
    await w.preview.dispose()
    const notifications = changed.mock.calls.length
    await w.preview.dispose()
    await w.preview.refresh()
    expect(changed).toHaveBeenCalledTimes(notifications)
    expect(w.editor.dispose).toHaveBeenCalledTimes(1)
  })

  it('SDK 正在创建时退出：晚到实例立即销毁，不把页面变回就绪', async () => {
    const mounting = deferred<PreviewEditor>()
    const mount = vi.fn(async () => mounting.promise)
    const w = setup({ mount })
    const pending = w.preview.refresh()
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1))
    const closed = w.preview.dispose()
    mounting.resolve(w.editor)
    await Promise.all([pending, closed])
    expect(w.editor.dispose).toHaveBeenCalledTimes(1)
    expect(w.preview.view().kind).toBe('disposed')
  })

  it('SDK 自检不完整时销毁，不把格式兼容当作完整预览', async () => {
    const editor = { usable: false, dispose: vi.fn(async () => {}) }
    const w = setup({ mount: vi.fn(async () => editor) })
    await w.preview.refresh()
    expect(w.preview.view().kind).toBe('unusable')
    expect(editor.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('M5R-M-04 后台复核只核验不打断（D-06）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('资格未变时：复核期间仍是就绪，不暂停图片、不发布加载态，不重下正文、不重建实例', async () => {
    const w = setup()
    await w.preview.refresh()
    const imageChanges = vi.fn()
    w.images()?.subscribe(imageChanges)
    const states: string[] = []
    w.preview.subscribe(() => states.push(w.preview.view().kind))
    const session = deferred<typeof HISTORY_SESSION>()
    vi.mocked(w.deps.session).mockImplementationOnce(async () => session.promise)
    const pending = w.preview.refresh('background')
    expect(w.preview.view().kind).toBe('ready')
    expect(w.images()?.current()).toBe(HISTORY_SESSION)
    session.resolve(HISTORY_SESSION)
    await pending
    expect(w.preview.view().kind).toBe('ready')
    expect(states).not.toContain('loading')
    expect(imageChanges).not.toHaveBeenCalled()
    expect(w.deps.content).toHaveBeenCalledTimes(1)
    expect(w.deps.mount).toHaveBeenCalledTimes(1)
  })

  it('复核超过约 10 秒仍没有结论才隐藏；结论到了恢复显示', async () => {
    vi.useFakeTimers()
    const w = setup()
    await w.preview.refresh()
    const session = deferred<typeof HISTORY_SESSION>()
    vi.mocked(w.deps.session).mockImplementationOnce(async () => session.promise)
    const pending = w.preview.refresh('background')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(w.preview.view().kind).toBe('ready')
    expect(w.images()?.current()).toBe(HISTORY_SESSION)
    await vi.advanceTimersByTimeAsync(1)
    expect(w.preview.view().kind).toBe('loading')
    expect(w.images()?.current()).toBeUndefined()
    session.resolve(HISTORY_SESSION)
    await pending
    expect(w.preview.view().kind).toBe('ready')
    expect(w.images()?.current()).toBe(HISTORY_SESSION)
    expect(w.deps.mount).toHaveBeenCalledTimes(1)
  })

  it('后台复核发现撤权：不等 10 秒，立即关图片并销毁实例', async () => {
    const w = setup()
    await w.preview.refresh()
    vi.mocked(w.deps.detail).mockRejectedValueOnce(new ApiError(403, 'PERMISSION_DENIED', '撤权'))
    await w.preview.refresh('background')
    expect(w.preview.view()).toEqual({ kind: 'unavailable' })
    expect(w.images()?.current()).toBeUndefined()
    expect(w.editor.dispose).toHaveBeenCalledTimes(1)
  })

  it('无法预览是终态：后台复核不再读正文或创建实例，只有用户重试才重来', async () => {
    const editor = { usable: false, dispose: vi.fn(async () => {}) }
    const w = setup({ mount: vi.fn(async () => editor) })
    await w.preview.refresh()
    expect(w.preview.view().kind).toBe('unusable')
    await w.preview.refresh('background')
    await w.preview.refresh('background')
    expect(w.deps.session).toHaveBeenCalledTimes(2)
    expect(w.deps.content).toHaveBeenCalledTimes(1)
    expect(w.deps.mount).toHaveBeenCalledTimes(1)
    await w.preview.refresh('user')
    expect(w.deps.mount).toHaveBeenCalledTimes(2)
  })

  it('不受支持是终态：后台复核不再查询', async () => {
    const w = setup({ detail: vi.fn(async () => historyItem({ compatibility: 'unsupported' })) })
    await w.preview.refresh()
    await w.preview.refresh('background')
    expect(w.preview.view()).toEqual({ kind: 'unsupported' })
    expect(w.deps.detail).toHaveBeenCalledTimes(1)
  })

  it('非临时性的失败只在用户点击时重试；网络类临时失败仍自动重试', async () => {
    const w = setup()
    vi.mocked(w.deps.mount).mockRejectedValueOnce(new Error('SDK 内部错误'))
    await w.preview.refresh()
    expect(w.preview.view().kind).toBe('failed')
    await w.preview.refresh('background')
    expect(w.deps.mount).toHaveBeenCalledTimes(1)
    await w.preview.refresh('user')
    expect(w.preview.view().kind).toBe('ready')
    vi.mocked(w.deps.detail).mockRejectedValueOnce(new NetworkError('断网'))
    await w.preview.refresh('background')
    expect(w.preview.view().kind).toBe('failed')
    await w.preview.refresh('background')
    expect(w.preview.view().kind).toBe('ready')
  })
})

describe('M5R-M-05 数据类加载错误与正文无法解码归入无法预览', () => {
  class DataProblem extends Error {}
  it.each(['content', 'mount'] as const)('%s 抛出数据类错误：显示无法预览，后台不再重试', async (where) => {
    const w = setup({ unusable: error => error instanceof DataProblem })
    vi.mocked(w.deps[where]).mockRejectedValueOnce(new DataProblem('正文坏了'))
    await w.preview.refresh()
    expect(w.preview.view()).toEqual({ kind: 'unusable' })
    await w.preview.refresh('background')
    expect(w.deps.mount).toHaveBeenCalledTimes(where === 'mount' ? 1 : 0)
  })
})

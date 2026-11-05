import type { SessionChannel } from '../../shared/lib/session-channel.ts'
import { historyPreviewPagePath } from '@nerve-office/contracts'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
import { HISTORY_DOCUMENT_ID as DOC, HISTORY_SESSION, historyItem } from '../../shared/testing/history.test-support.ts'
import { startHistoryPreview } from './start.tsx'

const sdk = vi.hoisted(() => {
  /** 替身里的同名错误类：被测的组装与这里的用例经同一个模块替身拿到它 */
  class SheetEditorLoadError extends Error {
    readonly reason: string
    constructor(reason: string, message: string) {
      super(message)
      this.reason = reason
    }
  }
  return { create: vi.fn(), dispose: vi.fn(async () => {}), SheetEditorLoadError }
})
vi.mock('../../editor/index.ts', () => ({ createSheetEditor: sdk.create, SheetEditorLoadError: sdk.SheetEditorLoadError }))
let stop: (() => Promise<void>) | undefined
beforeEach(() => {
  sdk.create.mockReset().mockResolvedValue({ openCheck: { ok: true }, dispose: sdk.dispose })
  sdk.dispose.mockClear()
})
afterEach(async () => {
  await act(async () => stop?.())
  stop = undefined
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('US-M5-10 独立预览实际组装', () => {
  it('真正属于另一检查点的响应仍被拒绝，不挂载正文', async () => {
    const item = historyItem()
    installFakeApi({
      'GET /api/auth/session': () => json(200, HISTORY_SESSION),
      [`GET /api/documents/${DOC}/history/${item.id}`]: () => json(200, { ...item, id: '0199a2c4-0000-7000-8000-0000000000ff' }),
    })
    const chrome = document.createElement('div')
    const surface = document.createElement('div')
    document.body.append(chrome, surface)
    const channel: SessionChannel = { announce: vi.fn(), close: vi.fn(), subscribe: () => () => {} }
    await act(async () => {
      stop = startHistoryPreview({ chrome, surface, pathname: historyPreviewPagePath(DOC, item.id), channel })
    })
    await screen.findByRole('alert')
    expect(surface.hidden).toBe(true)
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it.each(['signed-out', 'changed-user'])('周期确认身份 %s 时清掉原预览，停止后的计时器不再读取', async (outcome) => {
    let tick = () => {}
    // 只截取宿主使用的无参数浏览器回调，避免 Node 重载与 DOM TimerHandler 的宽泛 Function 类型。
    const browserWindow: { setInterval: (callback: () => void, delay?: number) => number } = window
    const nativeInterval = browserWindow.setInterval.bind(browserWindow)
    let timer: number | undefined
    const interval = vi.spyOn(browserWindow, 'setInterval').mockImplementation((handler, delay) => {
      expect(delay).toBe(30_000)
      tick = handler
      timer = nativeInterval(() => {}, delay)
      return timer
    })
    const clear = vi.spyOn(window, 'clearInterval')
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const item = historyItem()
    const detail = `GET /api/documents/${DOC}/history/${item.id}`
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, HISTORY_SESSION),
      'GET /api/auth/session/check': () => json(200, HISTORY_SESSION),
      [detail]: () => json(200, item),
      [`${detail}/content`]: () => new Response('{}'),
    })
    const chrome = document.createElement('div')
    const surface = document.createElement('div')
    document.body.append(chrome, surface)
    const channel: SessionChannel = { announce: vi.fn(), close: vi.fn(), subscribe: () => () => {} }
    await act(async () => {
      stop = startHistoryPreview({ chrome, surface, pathname: historyPreviewPagePath(DOC, item.id), channel })
    })
    interval.mockRestore()
    await waitFor(() => expect(surface.dataset.editorState).toBe('ready'))
    const before = api.requests.length
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => tick())
    expect(api.requests).toHaveLength(before)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    api.on('GET /api/auth/session/check', () => outcome === 'signed-out'
      ? apiError(401, 'UNAUTHENTICATED')
      : json(200, { ...HISTORY_SESSION, user: { ...HISTORY_SESSION.user, id: '0199a2c4-0000-7000-8000-0000000000b1' } }))
    await act(async () => tick())
    expect(await screen.findByRole('alert')).toHaveTextContent(outcome === 'signed-out' ? '登录已失效' : '登录的账户已经变化')
    expect(surface.hidden).toBe(true)
    expect(sdk.dispose).toHaveBeenCalledTimes(1)
    await act(async () => stop?.())
    const after = api.requests.length
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      tick()
    })
    expect(clear).toHaveBeenCalledWith(timer)
    expect(api.requests).toHaveLength(after)
    expect(channel.close).toHaveBeenCalledTimes(1)
  })

  it.each(['小写', '大写', '混合大小写'])('%s地址只以 read 创建 SDK；可见性、会话消息会重新确认，撤权隐藏正文；没有编辑租约或保存请求', async (casing) => {
    const item = historyItem()
    const detail = `GET /api/documents/${DOC}/history/${item.id}`
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, HISTORY_SESSION),
      'GET /api/auth/session/check': () => json(200, HISTORY_SESSION),
      [detail]: () => json(200, item),
      [`${detail}/content`]: () => new Response('{"history":true}'),
    })
    const documentId = casing === '大写' ? DOC.toUpperCase() : DOC
    const historyId = casing === '小写' ? item.id : item.id.toUpperCase()
    const requestedDetail = `GET /api/documents/${documentId}/history/${historyId}`
    api.on(requestedDetail, () => json(200, item))
    api.on(`${requestedDetail}/content`, () => new Response('{"history":true}'))
    let message = () => {}
    const channel: SessionChannel = { announce: vi.fn(), close: vi.fn(), subscribe: (listener) => {
      message = listener
      return () => {}
    } }
    const chrome = document.createElement('div')
    const surface = document.createElement('div')
    document.body.append(chrome, surface)
    await act(async () => {
      stop = startHistoryPreview({ chrome, surface, pathname: historyPreviewPagePath(documentId, historyId), channel })
    })
    await waitFor(() => expect(surface.dataset.editorState).toBe('ready'))
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ access: 'read', container: surface, snapshot: '{"history":true}' }))
    expect(screen.getByText('这是历史的只读预览，不会修改原文档或本机草稿。')).toBeInTheDocument()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const before = api.requests.length
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(api.requests.length).toBeGreaterThan(before))
    await waitFor(() => expect(surface.dataset.editorState).toBe('ready'))
    expect(sdk.create).toHaveBeenCalledTimes(1)
    api.on(detail, () => apiError(403, 'PERMISSION_DENIED'))
    await act(async () => message())
    await screen.findByText('这份文档的历史已不可用，或你没有查看历史的权限。')
    expect(surface.hidden).toBe(true)
    expect(sdk.dispose).toHaveBeenCalledTimes(1)
    expect(api.requests.every(request => request.key.startsWith('GET '))).toBe(true)
    expect(api.requests.some(request => /edit-lease|local-key|outbox|open-check-failures/.test(request.key))).toBe(false)
    await act(async () => stop?.())
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
})

describe('M5-P7 历史预览的终态、后台复核与公式提示', () => {
  async function open(item = historyItem(), content: () => Response = () => new Response('{"history":true}')) {
    const detail = `GET /api/documents/${DOC}/history/${item.id}`
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, HISTORY_SESSION),
      'GET /api/auth/session/check': () => json(200, HISTORY_SESSION),
      [detail]: () => json(200, item),
      [`${detail}/content`]: content,
    })
    const chrome = document.createElement('div')
    const surface = document.createElement('div')
    document.body.append(chrome, surface)
    const channel: SessionChannel = { announce: vi.fn(), close: vi.fn(), subscribe: () => () => {} }
    await act(async () => {
      stop = startHistoryPreview({ chrome, surface, pathname: historyPreviewPagePath(DOC, item.id), channel })
    })
    return { api, surface }
  }

  it.each(['snapshot-invalid', 'create-failed', 'unit-mismatch'] as const)('M5R-M-05 SDK 按数据拒绝（%s）：显示无法预览，没有重试', async (reason) => {
    sdk.create.mockRejectedValue(new sdk.SheetEditorLoadError(reason, '数据不对'))
    const { surface } = await open()
    expect(await screen.findByText('这份历史没能完整载入，无法预览。可返回历史列表尝试其他历史。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(surface.hidden).toBe(true)
  })

  it('M5R-M-05 正文读到了响应却解不开：显示无法预览，没有重试', async () => {
    await open(historyItem(), () => new Response(new ReadableStream({ start: controller => controller.error(new TypeError('解码失败')) })))
    expect(await screen.findByText('这份历史没能完整载入，无法预览。可返回历史列表尝试其他历史。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('M5R-M-05 环境类的失败（公式 Worker 起不来）仍可重试', async () => {
    sdk.create.mockRejectedValueOnce(new sdk.SheetEditorLoadError('worker-failed', 'Worker 起不来'))
    await open()
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('M5R-M-04 就绪后的后台复核进行中仍显示正文，不播报加载状态', async () => {
    let answer: (response: Response) => void = () => {}
    const { api, surface } = await open()
    await waitFor(() => expect(surface.dataset.editorState).toBe('ready'))
    api.on('GET /api/auth/session/check', async () => new Promise<Response>((resolve) => {
      answer = resolve
    }))
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const before = api.requests.length
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(api.requests.length).toBeGreaterThan(before))
    expect(surface.dataset.editorState).toBe('ready')
    expect(surface.style.visibility).toBe('visible')
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => answer(json(200, HISTORY_SESSION)))
    await waitFor(() => expect(surface.dataset.editorState).toBe('ready'))
    expect(sdk.create).toHaveBeenCalledTimes(1)
  })

  it('M5R-M-07 历史里公式未收齐：页头按阅读页口径提示', async () => {
    await open(historyItem({ formulasPending: true }))
    expect(await screen.findByText('这份历史的公式结果可能还没更新（保存这一版时公式还没算完）')).toBeInTheDocument()
  })

  it('M5R-M-07 公式已收齐时不提示', async () => {
    const { surface } = await open()
    await waitFor(() => expect(surface.dataset.editorState).toBe('ready'))
    expect(screen.queryByText(/公式结果可能还没更新/)).toBeNull()
  })
})

import type { CsvTable } from '../../shared/csv/index.ts'
import type { CreatedCsvIntent } from './editor-page.ts'
import { csvCreatePagePath } from '@nerve-office/contracts'
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiSession, setCsrfToken } from '../../shared/api/index.ts'
import { rememberSessionPermit } from '../../shared/api/session-association.ts'
import { currentApiSession } from '../../shared/api/session-context.ts'
import { publishLocalSession } from '../../shared/local-drafts/session-events.ts'
import { testSessionPermit } from '../../shared/outbox/session-fence.test-support.ts'
import { installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
import { csvFile, pending } from './csv-controller.test-support.ts'
import { CSV_CREATED, CSV_CREATOR } from './csv-create-controller.test-support.ts'
import { startCsvCreatePage } from './csv-create-start.tsx'

const h = vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
  return {
    mount: vi.fn(),
    dispose: vi.fn(),
    save: vi.fn(async () => {}),
    apply: vi.fn(async (_table: CsvTable, _intent: CreatedCsvIntent) => true),
    stopConnection: vi.fn(),
    closeChannel: vi.fn(),
    subscribeChannel: vi.fn((_listener: () => void) => () => {}),
  }
})
vi.mock('./start.tsx', () => ({ startSheetEditorPage: h.mount }))
vi.mock('../../shared/lib/browser-connection.ts', () => ({ watchBrowserConnection: () => h.stopConnection }))
vi.mock('../../shared/lib/session-channel.ts', () => ({ openSessionChannel: () => ({ subscribe: h.subscribeChannel, close: h.closeChannel }) }))

const mounted = () => ({ page: { importCreatedCsv: h.apply, save: h.save, view: () => ({ load: { kind: 'ready' }, surface: 'ready' }) }, loaded: Promise.resolve(), dispose: h.dispose })
const cleanups: (() => void)[] = []

beforeEach(() => {
  h.mount.mockResolvedValue(mounted())
  h.apply.mockResolvedValue(true)
  history.replaceState(null, '', csvCreatePagePath({ spaceId: CSV_CREATOR.personalSpace.id }))
  installFakeApi({
    'GET /api/auth/session': () => json(200, CSV_CREATOR),
    [`GET /api/spaces/${CSV_CREATOR.personalSpace.id}`]: () => json(200, {
      id: CSV_CREATOR.personalSpace.id,
      name: '我的空间',
      type: 'personal',
      status: 'active',
      role: 'admin',
      visibleToAll: false,
      permissions: { canCreateDocuments: true, canCreateFolders: true, canViewMembers: false, canManageMembers: false, canRename: false, canPurgeTrash: true },
    }),
    'POST /api/documents': () => json(201, CSV_CREATED),
  })
})
afterEach(() => {
  act(() => cleanups.splice(0).forEach(clean => clean()))
  setCsrfToken(undefined)
  vi.clearAllMocks()
  history.replaceState(null, '', '/')
})

async function start() {
  const chrome = document.createElement('header')
  const surface = document.createElement('div')
  const runtime = await act(async () => startCsvCreatePage({ chrome, surface }))
  if (!runtime)
    throw new Error('应挂载创建页面')
  cleanups.push(runtime.dispose)
  await waitFor(() => expect(runtime.controller.view().stage).toBe('selecting'))
  await act(async () => runtime.controller.chooseFile(csvFile('甲,001')))
  return { ...runtime, chrome, surface }
}

describe('CSV 创建与同页正式宿主的交接', () => {
  it('只替换地址且不携带 CSV；沿原页头保存，页面关闭只清 CSV、保留原页收尾', async () => {
    const runtime = await start()
    expect(runtime.surface.hidden).toBe(true)
    await act(async () => runtime.controller.confirm())
    expect(runtime.controller.view().stage).toBe('done')
    expect(location.pathname).toBe(`/documents/${CSV_CREATED.id}`)
    expect(location.search).toBe('?edit=new')
    expect(h.mount).toHaveBeenCalledOnce()
    expect(h.apply.mock.calls[0]?.[0]).toEqual({ rows: [['甲', '001']], rowCount: 1, columnCount: 2 })
    expect(h.apply.mock.calls[0]?.[1]).toMatchObject({ documentId: CSV_CREATED.id, userId: CSV_CREATOR.user.id, csrfToken: CSV_CREATOR.csrfToken })
    expect(h.save).toHaveBeenCalledOnce()
    expect(runtime.surface.hidden).toBe(false)
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(h.dispose).not.toHaveBeenCalled()
    expect(runtime.surface.hidden).toBe(false)
    expect(runtime.chrome.children).toHaveLength(1)
    expect(h.closeChannel).toHaveBeenCalledOnce()
  })

  it('预览有离开提醒，创建完成后提醒转交原页；应用失败重用宿主', async () => {
    const runtime = await start()
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    h.apply.mockResolvedValueOnce(false)
    await act(async () => runtime.controller.confirm())
    expect(runtime.controller.view().problem).toBe('import-failed')
    await act(async () => runtime.controller.retry())
    expect(h.mount).toHaveBeenCalledOnce()
    expect(h.dispose).not.toHaveBeenCalled()
    expect(h.save).toHaveBeenCalledOnce()
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it('页面关闭后晚到的挂载立即释放，不再显示或应用', async () => {
    const runtime = await start()
    const opening = pending<ReturnType<typeof mounted>>()
    h.mount.mockImplementationOnce(async () => opening.promise)
    let creation: Promise<void> | undefined
    act(() => {
      creation = runtime.controller.confirm()
    })
    await waitFor(() => expect(h.mount).toHaveBeenCalledOnce())
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    await act(async () => {
      opening.resolve(mounted())
      await creation
    })
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(h.apply).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
    expect(runtime.surface.hidden).toBe(true)
  })

  it('初次加载失败释放未展示的宿主；重试打开已创建文档', async () => {
    const runtime = await start()
    h.mount.mockResolvedValueOnce({ ...mounted(), page: { ...mounted().page, view: () => ({ load: { kind: 'failed' }, surface: 'failed' }) } })
    await act(async () => runtime.controller.confirm())
    expect(runtime.controller.view().problem).toBe('open-failed')
    expect(h.dispose).toHaveBeenCalledOnce()
    expect(runtime.surface.hidden).toBe(true)
    await act(async () => runtime.controller.retry())
    expect(runtime.controller.view().stage).toBe('done')
    expect(h.mount).toHaveBeenCalledTimes(2)
    expect(h.apply).toHaveBeenCalledOnce()
  })

  it('同人换令牌取消旧文件；已打开的正式宿主保留以保护正文', async () => {
    const runtime = await start()
    h.apply.mockResolvedValueOnce(false)
    await act(async () => runtime.controller.confirm())
    act(() => setApiSession({ ...CSV_CREATOR, csrfToken: 'new-session-token' }))
    expect(runtime.controller.view().stage).toBe('invalid')
    expect(runtime.controller.view().preview).toBeUndefined()
    expect(h.dispose).not.toHaveBeenCalled()
    expect(runtime.surface.hidden).toBe(false)
  })

  it('其他标签页的会话消息取消尚未创建的文件，不能以新会话继续', async () => {
    const runtime = await start()
    act(() => h.subscribeChannel.mock.calls[0]?.[0]())
    expect(runtime.controller.view().stage).toBe('invalid')
    await act(async () => runtime.controller.confirm())
    expect(h.mount).not.toHaveBeenCalled()
  })

  it('本机停止事件只取消原用户同一代次，不误伤别的来源', async () => {
    const runtime = await start()
    const session = currentApiSession()
    if (!session)
      throw new Error('缺少已采纳会话')
    const permit = testSessionPermit(session.user.id)
    rememberSessionPermit(session, permit)
    act(() => publishLocalSession({ kind: 'stopped', previous: { ...permit, generation: 'another-generation' }, cleanup: undefined }))
    expect(runtime.controller.view().stage).toBe('preview')
    act(() => publishLocalSession({ kind: 'stopped', previous: { ...permit, userId: 'another-user' }, cleanup: undefined }))
    expect(runtime.controller.view().stage).toBe('preview')
    act(() => publishLocalSession({ kind: 'stopped', previous: permit, cleanup: undefined }))
    expect(runtime.controller.view().stage).toBe('invalid')
  })

  it('挂载入口拒绝时也恢复创建界面，已有文档仍可重试', async () => {
    const runtime = await start()
    h.mount.mockRejectedValueOnce(new Error('mount failed'))
    await act(async () => runtime.controller.confirm())
    expect(runtime.controller.view().problem).toBe('open-failed')
    expect(runtime.surface.hidden).toBe(true)
    await act(async () => runtime.controller.retry())
    expect(runtime.controller.view().stage).toBe('done')
  })

  it('无效目标不启动请求或正式编辑器，只显示返回说明', () => {
    history.replaceState(null, '', '/documents/new/csv?spaceId=bad')
    const chrome = document.createElement('header')
    const surface = document.createElement('div')
    expect(startCsvCreatePage({ chrome, surface })).toBeUndefined()
    expect(chrome.textContent).toContain('创建位置不正确')
    expect(h.mount).not.toHaveBeenCalled()
  })
})

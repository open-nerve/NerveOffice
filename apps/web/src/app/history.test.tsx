import type { CreatedDocument } from '@nerve-office/contracts'
import { documentPagePath, historyPagePath, historyPreviewPagePath, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { HISTORY_DOCUMENT_ID as DOC, historyItem, HISTORY_SESSION as SESSION } from '../shared/testing/history.test-support.ts'
import { foldersKey, noFolders, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const item = historyItem()
const GET = `GET /api/documents/${DOC}/history`
const POST = `POST /api/documents/${DOC}/history/${item.id}/restore`
const copy: CreatedDocument = {
  id: '0199a2c4-0000-7000-8000-0000000000f1',
  title: '历史周报 的副本',
  type: 'sheet',
  spaceId: SESSION.personalSpace.id,
  space: { id: SESSION.personalSpace.id, type: 'personal' },
  folderId: null,
  accessVia: 'space',
  createdAt: item.createdAt,
  updatedAt: item.createdAt,
  revision: 1,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: UNIVER_SDK_VERSION,
  formulasPending: false,
  replayed: false,
  permissions: { canEdit: true, canViewHistory: true, canClearHistory: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
}
function setup(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [foldersKey(SESSION.personalSpace.id)]: noFolders,
    [GET]: () => json(200, { items: [item], nextCursor: null }),
    ...handlers,
  })
}

describe('US-M5-10 历史列表、只读预览入口和恢复为副本', () => {
  it('每条显示保存时间、人和修订，预览新标签；没有历史如实说明', async () => {
    const api = setup()
    const runtime = renderApp(historyPagePath(DOC))
    expect(await screen.findByRole('heading', { name: '文档历史', level: 1 })).toBeInTheDocument()
    const row = await screen.findByRole('row', { name: /历史周报/ })
    expect(row).toHaveTextContent('修订 2')
    expect(row).toHaveTextContent('艾米')
    const preview = within(row).getByRole('link', { name: '只读预览' })
    expect(preview).toHaveAttribute('href', historyPreviewPagePath(DOC, item.id))
    expect(preview).toHaveAttribute('target', '_blank')
    expect(preview).toHaveAttribute('rel', 'noopener')
    api.on(GET, () => json(200, { items: [], nextCursor: null }))
    await runtime.queryClient.invalidateQueries({ queryKey: ['document-history', DOC] })
    expect(await screen.findByText('最近 7 天没有可用的历史。当前正文不会被当作历史。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复为副本' })).toBeNull()
  })

  it('加载中可感知；失败重试后展示；分页后焦点到新内容', async () => {
    let answer: (response: Response) => void = () => {}
    const api = setup({ [GET]: async () => new Promise<Response>((done) => {
      answer = done
    }) })
    renderApp(historyPagePath(DOC))
    expect(await screen.findByRole('status', { name: '正在加载历史…' })).toBeInTheDocument()
    api.on(GET, () => apiError(500, 'INTERNAL_ERROR'))
    answer(apiError(500, 'INTERNAL_ERROR'))
    expect(await screen.findByText('历史没能加载', {}, { timeout: 3000 })).toBeInTheDocument()
    api.on(GET, () => json(200, { items: [item], nextCursor: 'next' }))
    api.on(`${GET}?cursor=next`, () => json(200, { items: [historyItem({ id: copy.id, title: '更早的历史', revision: 1 })], nextCursor: null }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    const more = await screen.findByRole('button', { name: '加载更多' })
    more.focus()
    fireEvent.click(more)
    const older = await screen.findByRole('row', { name: /更早的历史/ })
    await waitFor(() => expect(within(older).getByRole('link', { name: '只读预览' })).toHaveFocus())
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull()
  })

  it.each([403, 404])('撤权或消失 %i：隐藏缓存的历史及恢复面板', async (status) => {
    const api = setup()
    const runtime = renderApp(historyPagePath(DOC))
    fireEvent.click(await screen.findByRole('button', { name: '恢复为副本' }))
    await screen.findByText('恢复会创建一份新文档，原件及其编辑会话保持不变。')
    api.on(GET, () => apiError(status, status === 403 ? 'PERMISSION_DENIED' : 'NOT_FOUND'))
    await runtime.queryClient.invalidateQueries({ queryKey: ['document-history', DOC] })
    expect(await screen.findByText('这份文档的历史已不可用，或你没有查看历史的权限。')).toBeInTheDocument()
    expect(screen.queryByText('历史周报')).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复到这里' })).toBeNull()
    api.on(GET, () => json(200, { items: [item], nextCursor: null }))
    await runtime.queryClient.invalidateQueries({ queryKey: ['document-history', DOC] })
    await screen.findByRole('button', { name: '恢复为副本' })
    expect(screen.queryByRole('button', { name: '恢复到这里' })).toBeNull()
  })

  it('不支持的历史保留格式说明，不能提交恢复', async () => {
    setup({ [GET]: () => json(200, { items: [historyItem({ compatibility: 'unsupported' })], nextCursor: null }) })
    renderApp(historyPagePath(DOC))
    expect(await screen.findByText('当前版本不支持这份历史的格式。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复为副本' })).toBeNull()
  })

  it('结果未知沿用同一请求重试；成功给新副本链接并聚焦，原页不导航', async () => {
    const api = setup({ [POST]: () => apiError(500, 'INTERNAL_ERROR') })
    const runtime = renderApp(historyPagePath(DOC))
    fireEvent.click(await screen.findByRole('button', { name: '恢复为副本' }))
    fireEvent.click(await screen.findByRole('button', { name: '恢复到这里' }))
    expect(await screen.findByText(/暂时无法确认恢复是否完成/)).toBeInTheDocument()
    api.on(POST, () => json(201, { ...copy, replayed: true }))
    fireEvent.click(screen.getByRole('button', { name: '恢复到这里' }))
    const link = await screen.findByRole('link', { name: '打开新副本' })
    expect(link).toHaveAttribute('href', documentPagePath(copy.id))
    expect(link).toHaveAttribute('target', '_blank')
    await waitFor(() => expect(link).toHaveFocus())
    expect(screen.getByText('上一次恢复已经完成。')).toBeInTheDocument()
    expect(runtime.page.visits).toEqual([])
    const sent = api.requests.filter(request => request.key === POST)
    expect(sent).toHaveLength(2)
    expect(sent[0]?.body).toEqual(sent[1]?.body)
    expect(sent[0]?.body).toMatchObject({ spaceId: SESSION.personalSpace.id })
  })

  it('无效历史拒绝给明确原因，取消后焦点回到对应恢复按钮', async () => {
    setup({ [POST]: () => apiError(422, 'HISTORY_UNUSABLE', '这份历史的内容或格式无法恢复，请尝试其他历史') })
    renderApp(historyPagePath(DOC))
    const recover = await screen.findByRole('button', { name: '恢复为副本' })
    recover.focus()
    fireEvent.click(recover)
    fireEvent.click(await screen.findByRole('button', { name: '恢复到这里' }))
    expect(await screen.findByText('这份历史的内容或格式无法恢复，请尝试其他历史')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '打开新副本' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(recover).toHaveFocus())
  })
})

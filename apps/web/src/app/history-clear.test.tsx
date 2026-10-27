import { historyPagePath } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { HISTORY_DOCUMENT_ID as DOC, historyItem, HISTORY_SESSION as SESSION } from '../shared/testing/history.test-support.ts'
import { foldersKey, noFolders, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const GET = `GET /api/documents/${DOC}/history`
const DELETE = `DELETE /api/documents/${DOC}/history`
const item = historyItem()
const later = historyItem({ id: '0199a2c4-0000-7000-8000-0000000000f2', title: '下一小时的新历史', revision: 3 })
function list(items = [item], canClearHistory = true) {
  return json(200, { items, nextCursor: null, canClearHistory })
}
function setup(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [foldersKey(SESSION.personalSpace.id)]: noFolders,
    [GET]: () => list(),
    ...handlers,
  })
}
async function openConfirmation() {
  fireEvent.click(await screen.findByRole('button', { name: '清除历史' }))
  return screen.findByRole('dialog', { name: '清除文档历史' })
}

describe('US-M5-11 清除历史确认与未知结果', () => {
  it('取消不请求；成功先清缓存，关闭后播报数量并把焦点交给标题', async () => {
    let cleared = false
    const api = setup({
      [GET]: () => list(cleared ? [] : [item, later]),
      [DELETE]: () => {
        cleared = true
        return json(200, { cleared: 2 })
      },
    })
    renderApp(historyPagePath(DOC))
    let dialog = await openConfirmation()
    expect(dialog).toHaveTextContent('清除后无法撤销')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.requests.filter(request => request.key === DELETE)).toHaveLength(0)
    dialog = await openConfirmation()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清除' }))
    expect(await screen.findByText('已清除 2 条历史。')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('row', { name: /历史周报|下一小时/ })).toBeNull()
    expect(screen.getByText(/最近 7 天没有可用的历史/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: '文档历史', level: 1 })).toHaveFocus())
    expect(api.requests.filter(request => request.key === DELETE)).toHaveLength(1)
  })

  it('编辑者无清除入口；管理员确认期间降级后旧弹窗也不能继续', async () => {
    const api = setup({ [GET]: () => list([item], false) })
    const runtime = renderApp(historyPagePath(DOC))
    await screen.findByRole('row', { name: /历史周报/ })
    expect(screen.queryByRole('button', { name: '清除历史' })).toBeNull()
    api.on(GET, () => list())
    await runtime.queryClient.invalidateQueries({ queryKey: ['document-history', DOC] })
    const dialog = await openConfirmation()
    api.on(GET, () => list([item], false))
    await runtime.queryClient.invalidateQueries({ queryKey: ['document-history', DOC] })
    const confirm = within(dialog).getByRole('button', { name: '确认清除' })
    await waitFor(() => expect(confirm).toHaveAttribute('aria-disabled', 'true'))
    fireEvent.click(confirm)
    expect(api.requests.filter(request => request.key === DELETE)).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '文档历史', level: 1 })).toHaveFocus())
  })

  it('未知结果后刷新出了新小时历史，本次确认禁重试；关闭核对后才能发起新确认', async () => {
    let attempted = false
    const api = setup({
      [GET]: () => list(attempted ? [later] : [item]),
      [DELETE]: () => {
        attempted = true
        return apiError(500, 'INTERNAL_ERROR')
      },
    })
    renderApp(historyPagePath(DOC))
    const dialog = await openConfirmation()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清除' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('清除可能已生效，已重新读取历史')
    const retry = within(dialog).getByRole('button', { name: '确认清除' })
    expect(retry).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(retry)
    expect(api.requests.filter(request => request.key === DELETE)).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(await screen.findByRole('row', { name: /下一小时的新历史/ })).toBeInTheDocument()
    const next = await openConfirmation()
    expect(within(next).getByRole('button', { name: '确认清除' })).toHaveAttribute('aria-disabled', 'false')
    expect(api.requests.filter(request => request.key === DELETE)).toHaveLength(1)
  })

  it('未知结果且列表刷新失败：关闭后仍不能重新确认，直到重新加载历史成功', async () => {
    let attempted = false
    const api = setup({
      [GET]: () => attempted ? apiError(500, 'INTERNAL_ERROR') : list(),
      [DELETE]: () => {
        attempted = true
        return apiError(500, 'INTERNAL_ERROR')
      },
    })
    renderApp(historyPagePath(DOC))
    const dialog = await openConfirmation()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清除' }))
    expect(await within(dialog).findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('清除可能已生效，但历史列表尚未刷新成功')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    const opener = await screen.findByRole('button', { name: '清除历史' })
    expect(opener).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(opener)
    expect(screen.queryByRole('dialog')).toBeNull()
    api.on(GET, () => list([later]))
    fireEvent.click(screen.getByRole('button', { name: '重新加载历史' }))
    await waitFor(() => expect(opener).toHaveAttribute('aria-disabled', 'false'))
    expect(await screen.findByRole('row', { name: /下一小时的新历史/ })).toBeInTheDocument()
    expect(api.requests.filter(request => request.key === DELETE)).toHaveLength(1)
  })

  it('服务端已成功但刷新失败：显示确定的清除结果，不能把旧缓存留在列表', async () => {
    let cleared = false
    setup({
      [GET]: () => cleared ? apiError(500, 'INTERNAL_ERROR') : list(),
      [DELETE]: () => {
        cleared = true
        return json(200, { cleared: 1 })
      },
    })
    renderApp(historyPagePath(DOC))
    const dialog = await openConfirmation()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认清除' }))
    expect(await screen.findByText('已清除 1 条历史。', {}, { timeout: 4000 })).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('row', { name: /历史周报/ })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

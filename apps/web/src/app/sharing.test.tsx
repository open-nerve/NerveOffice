// 平台页面里分享的入口（M2-P5 设计 §3.5，US-M2-10）：文档的行操作里，只在能分享时（canShare）出现；点了才下载对话框的代码，
// 打开时焦点进对话框、关闭之后回到入口；对话框里被拒绝之后先刷新文档详情（入口随之消失），关闭之后整页的列表跟上。
// 左侧导航里有"与我共享"。接口用假的 fetch。对话框本身的各种状态见 features/sharing/share-dialog.test.tsx，
// 代码没能下载下来的说明见 sharing-chunk.test.tsx。
import type { DocumentDetail, DocumentSummary, SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, inTurn, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { currentPath, renderApp } from './render-app.test-support.tsx'

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
  features: { localDraftsEnabled: true },
}

const WEEKLY: DocumentSummary = { id: '0199a2c4-0000-7000-8000-0000000000d1', title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }
const BUDGET: DocumentSummary = { ...WEEKLY, id: '0199a2c4-0000-7000-8000-0000000000d2', title: '预算' }

function detail(document: DocumentSummary, canShare: boolean): DocumentDetail {
  return {
    ...document,
    spaceId: SESSION.personalSpace.id,
    space: { id: SESSION.personalSpace.id, type: 'personal' },
    folderId: null,
    accessVia: 'space',
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    sdkVersion: '1.0.1',
    formulasPending: false,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare, canTakeOver: canShare },
  }
}

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [documentsKey(SESSION)]: () => json(200, { items: [WEEKLY, BUDGET], nextCursor: null }),
    [`GET /api/documents/${WEEKLY.id}`]: () => json(200, detail(WEEKLY, true)),
    [`GET /api/documents/${BUDGET.id}`]: () => json(200, detail(BUDGET, false)),
    ...handlers,
  })
}

/** 展开一行的操作面板，等到面板里的按钮出现 */
async function openActions(title: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `操作 ${title}` }))
  await screen.findByRole('button', { name: '改名' })
}

function requestsTo(api: { readonly requests: readonly { readonly key: string }[] }, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

describe('US-M2-10 平台页面里分享的入口', () => {
  it('能分享的文档（canShare）：行操作里有"分享"；打开对话框时焦点进去，关闭之后回到"分享"', async () => {
    loggedIn({ [`GET /api/documents/${WEEKLY.id}/grants`]: () => json(200, { items: [] }) })
    renderApp('/')
    await openActions('周报')
    const entry = screen.getByRole('button', { name: '分享' })
    entry.focus()
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: '分享「周报」' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(await within(dialog).findByText('还没有单独分享给任何人。')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '分享' }))
  })

  it('不能分享的文档（编辑者、查看者、归档的空间里，canShare 为假）：行操作里没有"分享"', async () => {
    loggedIn()
    renderApp('/')
    await openActions('预算')
    expect(screen.queryByRole('button', { name: '分享' })).toBeNull()
  })

  it('对话框里被拒绝（例如空间刚被归档）：先刷新文档详情，"分享"随新的权限消失；关闭之后焦点交给面板里的"取消"，整页的列表跟上', async () => {
    const api = loggedIn({
      [`GET /api/documents/${WEEKLY.id}`]: inTurn(() => json(200, detail(WEEKLY, true)), () => json(200, detail(WEEKLY, false)), () => json(200, detail(WEEKLY, false))),
      [`GET /api/documents/${WEEKLY.id}/grants`]: () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享'),
    })
    renderApp('/')
    await openActions('周报')
    const entry = screen.getByRole('button', { name: '分享' })
    entry.focus()
    fireEvent.click(entry)
    const dialog = await screen.findByRole('dialog', { name: '分享「周报」' })
    expect(await within(dialog).findByText('空间已归档，恢复之后才能调整分享')).toBeInTheDocument()
    // 对话框打开着：文档详情刷新了（入口随之消失），列表先不动——对话框里正说明原因
    await waitFor(() => expect(requestsTo(api, `GET /api/documents/${WEEKLY.id}`)).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: '分享' })).toBeNull())
    const listed = requestsTo(api, documentsKey(SESSION))
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(requestsTo(api, documentsKey(SESSION))).toBeGreaterThan(listed))
  })

  it('左侧导航里有"与我共享"', async () => {
    loggedIn({ 'GET /api/shared': () => json(200, { items: [], nextCursor: null }) })
    const app = renderApp('/')
    const nav = await screen.findByRole('navigation', { name: '空间' })
    fireEvent.click(within(nav).getByRole('link', { name: '与我共享' }))
    expect(await screen.findByRole('heading', { level: 1, name: '与我共享' })).toBeInTheDocument()
    expect(currentPath(app)).toBe('/shared')
    expect(within(nav).getByRole('link', { name: '与我共享' })).toHaveAttribute('aria-current', 'page')
  })
})

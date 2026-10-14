import type { SessionResponse } from '@nerve-office/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { draftDocumentIds } from '../shared/outbox/draft-index.ts'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

vi.mock('../shared/outbox/draft-index.ts', () => ({ draftDocumentIds: vi.fn() }))
const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
  features: { localDraftsEnabled: false },
}
const DOC = { id: '0199a2c4-0000-7000-8000-0000000000d1', title: '本机待同步的周报', type: 'sheet', createdAt: '2026-10-14T01:00:00.000Z', updatedAt: '2026-10-14T02:00:00.000Z' }
const CLEAN = { ...DOC, id: '0199a2c4-0000-7000-8000-0000000000d2', title: '已同步的报表' }
const SPACE = { id: SESSION.personalSpace.id, type: 'personal', owner: SESSION.user }
function api() {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [documentsKey(SESSION)]: () => json(200, { items: [DOC, CLEAN], nextCursor: null }),
    'GET /api/shared': () => json(200, { items: [DOC, CLEAN].map(document => ({ ...document, space: SPACE, contentRole: 'viewer' })), nextCursor: null }),
    'GET /api/search?query=local': () => json(200, { items: [DOC, CLEAN].map(document => ({ ...document, space: SPACE, folderId: null, folderPath: [], accessVia: 'space' })), nextCursor: null }),
  })
}
beforeEach(() => {
  vi.mocked(draftDocumentIds).mockReset().mockResolvedValue(new Set([DOC.id]))
})

describe('本机草稿的入口和全站标记', () => {
  it('部署关闭新写后，账户入口与按需页面仍可访问', async () => {
    api()
    renderApp('/local-drafts')
    expect(await screen.findByRole('heading', { name: '本机草稿', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '本机草稿' })).toHaveAttribute('href', '/local-drafts')
  })

  it.each(['/', '/shared', '/search?q=local'])('%s 列表按本人轻量索引显示标记；不取钥、不请求草稿事实', async (path) => {
    const http = api()
    renderApp(path)
    const row = (await screen.findByRole('link', { name: new RegExp(DOC.title) })).closest('li')!
    await waitFor(() => expect(within(row).getByText('本机有未同步修改')).toBeInTheDocument())
    const clean = screen.getByRole('link', { name: new RegExp(CLEAN.title) }).closest('li')!
    expect(within(clean).queryByText('本机有未同步修改')).not.toBeInTheDocument()
    expect(draftDocumentIds).toHaveBeenCalledExactlyOnceWith(SESSION.user.id)
    expect(http.requests.some(request => /local-key|draft-facts/.test(request.key))).toBe(false)
  })
})

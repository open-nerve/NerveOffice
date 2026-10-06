// 组件级的按需加载没能下载下来（M2-P5 S3：分享对话框的代码）：入口旁边说明——连不上服务器、已部署新版本、分块本身下载不下来
// 分开说，"重试"整页重新加载；不自动整页重新加载（页面上可能有用户正在做的事），页面的其余部分照常可用；下载与判断中读屏读得到。
// 分享对话框的模块在这个文件里一律加载失败（相当于断网或者旧的分块已经不在）。路由级的见 route-chunk.test.tsx。
import type { DocumentDetail, DocumentSummary, SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { documentsKey, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
import { settle } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

vi.mock('../features/sharing/index.ts', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/sharing-old.js')
})

const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米', systemRole: 'member' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000a1', name: '艾米' },
  csrfToken: 'csrf-1',
}

const WEEKLY: DocumentSummary = { id: '0199a2c4-0000-7000-8000-0000000000d1', title: '周报', type: 'sheet', createdAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T02:00:00.000Z' }

const DETAIL: DocumentDetail = {
  ...WEEKLY,
  spaceId: SESSION.personalSpace.id,
  space: { id: SESSION.personalSpace.id, type: 'personal' },
  folderId: null,
  accessVia: 'space',
  revision: 1,
  profile: 'sheet@1',
  formatVersion: 1,
  sdkVersion: '1.0.1',
  formulasPending: false,
  permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
}

/** 服务端现在的入口页：带着这些模块脚本 */
function entryPage(...scripts: readonly string[]): () => Response {
  return () => new Response(`<!doctype html><html><head>${scripts.map(src => `<script type="module" crossorigin src="${src}"></script>`).join('')}</head><body><div id="root"></div></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } })
}

function loggedIn(handlers: Parameters<typeof installFakeApi>[0] = {}) {
  return installFakeApi({
    'GET /api/auth/session': () => json(200, SESSION),
    ...spaceRoutes(SESSION),
    [documentsKey(SESSION)]: () => json(200, { items: [WEEKLY], nextCursor: null }),
    [`GET /api/documents/${WEEKLY.id}`]: () => json(200, DETAIL),
    ...handlers,
  })
}

/** 当前页面加载的入口脚本 */
function currentScripts(...scripts: readonly string[]): void {
  document.head.innerHTML = scripts.map(src => `<script type="module" src="${src}"></script>`).join('')
  onTestFinished(() => {
    document.head.innerHTML = ''
  })
}

/** 展开"周报"的操作面板，点"分享" */
async function share(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: '操作 周报' }))
  const entry = await screen.findByRole('button', { name: '分享' })
  entry.focus()
  fireEvent.click(entry)
  return entry
}

afterEach(() => {
  sessionStorage.clear()
})

describe('US-M2-10 分享对话框的代码没能下载下来（组件级的按需加载）', () => {
  it('连不上服务器：说明请检查网络后重试；不自动整页重新加载；焦点留在入口上，页面的其余部分照常', async () => {
    // 不登记 GET /：假的 fetch 失败，相当于连不上
    loggedIn()
    const app = renderApp('/')
    const entry = await share()
    expect(await screen.findByRole('alert')).toHaveTextContent('没能加载分享：连不上服务器，请检查网络后重试。')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(entry)
    expect(screen.getByRole('heading', { level: 1, name: '我的空间' })).toBeInTheDocument()
    await settle()
    expect(app.page.visits).toEqual([])
    // 重试：整页重新加载（浏览器记住了失败的模块，在这一页里再下载也还是失败）
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(app.page.visits).toEqual(['reload'])
  })

  it('已部署新版本（入口脚本变了，旧的分块已经不在）：说明服务器上已是新版本、重新加载之后就能用；不自动整页重新加载', async () => {
    currentScripts('/assets/index-old.js')
    loggedIn({ 'GET /': entryPage('/assets/index-new.js') })
    const app = renderApp('/')
    await share()
    expect(await screen.findByRole('alert')).toHaveTextContent('没能加载分享：服务器上已经部署了新版本，这个页面还是旧的。重试（重新加载页面）之后就能用了。')
    await settle()
    expect(app.page.visits).toEqual([])
  })

  it('服务器连得上、版本也没变（分块本身没下载下来）：不说是网络的问题，一直这样要告诉管理员', async () => {
    currentScripts('/assets/index-same.js')
    loggedIn({ 'GET /': entryPage('/assets/index-same.js') })
    renderApp('/')
    await share()
    expect(await screen.findByRole('alert')).toHaveTextContent('没能加载分享：它的代码没能下载下来（服务器连得上，版本也没有变）。可以重试；一直这样的话，请告诉管理员。')
    expect(screen.queryByText(/检查网络/)).toBeNull()
  })

  it('下载与判断原因的期间：入口标为忙碌，状态读屏读得到', async () => {
    let answer: (response: Response) => void = () => {}
    loggedIn({ 'GET /': async () => new Promise<Response>((resolve) => {
      answer = resolve
    }) })
    renderApp('/')
    const entry = await share()
    await waitFor(() => expect(screen.getByRole('status', { name: '' })).toHaveTextContent('正在打开分享…'))
    expect(entry).toHaveAttribute('aria-busy', 'true')
    expect(entry).toHaveAttribute('aria-disabled', 'true')
    answer(entryPage('/assets/index-x.js')())
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(entry).toHaveAttribute('aria-busy', 'false')
  })
})

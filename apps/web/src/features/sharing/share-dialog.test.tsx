// 分享对话框（M2-P5 设计 §3.5，US-M2-10）：授权列表（人名组件）、按名字选同事（排除自己与已有授权的人）、选角色、调整、取消（确认的弹窗）；
// 结果未知与被拒绝之后按共用的做法刷新（授权列表、文档详情与"与我共享"）再说明，403 显示服务端的说明；焦点进对话框、关闭之后回到入口。
// 接口用假的 fetch；宿主（平台页面或编辑器页）给出的"刷新文档详情"用记录调用的假实现。
import type { DocumentGrant, SharedListResponse } from '@nerve-office/contracts'
import type { ShareDialogProps } from './share-dialog.tsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SHARED_LIST_QUERY_KEY } from '../../shared/api/shared-list-key.ts'
import { OUTCOME_REFRESH_TIME_LIMIT_MS } from '../../shared/api/write-outcome.ts'
import { watchAnnouncement } from '../../shared/testing/announcement.test-support.ts'
import { apiError, installFakeApi, inTurn, json, networkFailure } from '../../shared/testing/fake-api.test-support.ts'
import { personIn, plainName, shownName } from '../../shared/testing/people.test-support.ts'
import { ShareDialog } from './share-dialog.tsx'
import { grantsQueryKey } from './sharing-api.ts'

const DOCUMENT_ID = '0199a2c4-0000-7000-8000-0000000000d1'
const ME = { id: '0199a2c4-0000-7000-8000-00000000000a', username: 'amy', displayName: '艾米' }
const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
const CAT = { id: '0199a2c4-0000-7000-8000-00000000000c', username: 'cat', displayName: '凯特' }
const DAN = { id: '0199a2c4-0000-7000-8000-00000000000d', username: 'dan', displayName: '丹' }

const GRANTS_KEY = `GET /api/documents/${DOCUMENT_ID}/grants`

function grantOf(user: typeof BEN, changes: Partial<DocumentGrant> = {}): DocumentGrant {
  return { user, status: 'active', role: 'viewer', grantedBy: ME, grantedAt: '2026-10-02T01:00:00.000Z', ...changes }
}

function grants(...items: DocumentGrant[]): Response {
  return json(200, { items })
}

function putKey(userId: string): string {
  return `PUT /api/documents/${DOCUMENT_ID}/grants/${userId}`
}

function deleteKey(userId: string): string {
  return `DELETE /api/documents/${DOCUMENT_ID}/grants/${userId}`
}

function colleaguesKey(query: string): string {
  return `GET /api/users?${new URLSearchParams({ query }).toString()}`
}

/** 宿主：打开对话框的按钮（入口）与对话框；refreshDocument 记下调用 */
function Host({ refreshDocument, props }: { readonly refreshDocument: () => void, readonly props?: Partial<ShareDialogProps> }) {
  const [open, setOpen] = useState(false)
  const entryRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={entryRef} type="button" onClick={() => setOpen(true)}>分享</button>
      <ShareDialog documentId={DOCUMENT_ID} documentTitle="周报" currentUserId={ME.id} open={open} onOpenChange={setOpen} refreshDocument={refreshDocument} entry={entryRef} fallbackFocus={() => {}} {...props} />
    </>
  )
}

/** "与我共享"已经取过一次（不在显示）：写操作之后要把它作废，下次显示时重新请求 */
const SHARED_PAGE: SharedListResponse = { items: [], nextCursor: null }

function renderDialog(handlers: Parameters<typeof installFakeApi>[0], props?: Partial<ShareDialogProps>) {
  const api = installFakeApi(handlers)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(SHARED_LIST_QUERY_KEY, { pages: [SHARED_PAGE], pageParams: [null] })
  const refreshDocument = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <Host refreshDocument={refreshDocument} props={props} />
    </QueryClientProvider>,
  )
  return { api, client, refreshDocument }
}

async function openDialog(): Promise<HTMLElement> {
  const entry = screen.getByRole('button', { name: '分享' })
  entry.focus()
  fireEvent.click(entry)
  return screen.findByRole('dialog', { name: '分享「周报」' })
}

function requestsTo(api: { readonly requests: readonly { readonly key: string }[] }, key: string): number {
  return api.requests.filter(request => request.key === key).length
}

/** 在同事选择里按名字找人：输入停下之后才查找 */
async function search(dialog: HTMLElement, keyword: string): Promise<HTMLElement> {
  fireEvent.change(within(dialog).getByLabelText('要分享给的同事'), { target: { value: keyword } })
  return within(dialog).findByRole('list', { name: '找到的同事' }, { timeout: 2000 })
}

/**
 * 对话框自己的状态区：做完一件事的说明（"已分享给…""已取消分享给…"，同事选择里另有一个查找进展的状态区）。
 * 确认框打开时 Radix 把它之外的内容标为 aria-hidden，按角色查不到，直接按元素找
 */
function noticeIn(dialog: HTMLElement): HTMLElement {
  const notice = dialog.querySelector<HTMLElement>(':scope > [data-slot="status-region"]')
  if (notice === null)
    throw new Error('对话框里没有做完一件事的说明的状态区')
  return notice
}

describe('US-M2-10 分享对话框：列表与人名', () => {
  it('打开时焦点进对话框；授权列表的被授权人与设置人都用人名组件（登录名在前），停用的标出来；关闭之后焦点回到入口', async () => {
    renderDialog({ [GRANTS_KEY]: () => grants(grantOf(BEN, { role: 'editor' }), grantOf(CAT, { status: 'disabled' })) })
    const dialog = await openDialog()
    // 说明不假定对方在这个空间里没有角色（M2-P5 审查 B 的 S4）
    expect(dialog).toHaveAccessibleDescription(/这条分享只给这一份，不给它所在空间里的其他内容；对方在这个空间里另有角色的，照样按那个角色访问。/)
    expect(dialog.contains(document.activeElement)).toBe(true)
    const list = await within(dialog).findByRole('list', { name: '已分享给' })
    const [ben, cat] = within(list).getAllByRole('listitem')
    personIn(ben as HTMLElement, '本', 'ben')
    personIn(cat as HTMLElement, '凯特', 'cat')
    expect(within(cat as HTMLElement).getByText('已停用')).toBeInTheDocument()
    // 最后设置它的人同样经人名组件
    expect(within(ben as HTMLElement).getByText((_content, element) => element?.tagName === 'P' && element.textContent?.startsWith(`由 ${shownName('艾米', 'amy')} 设置于`) === true)).toBeInTheDocument()
    expect(within(ben as HTMLElement).getByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })).toHaveValue('editor')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '分享' }))
  })

  it('打开之前入口没有焦点（WebKit 点按钮不移焦点，打开时记不下）：关闭之后焦点照样回到入口', async () => {
    renderDialog({ [GRANTS_KEY]: () => grants() })
    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    const dialog = await screen.findByRole('dialog', { name: '分享「周报」' })
    await within(dialog).findByText('还没有单独分享给任何人。')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '分享' })))
  })

  it('加载中读屏读得到（状态写在骨架屏的容器上）；还没有分享给任何人时说明', async () => {
    let answer: (response: Response) => void = () => {}
    renderDialog({ [GRANTS_KEY]: async () => new Promise<Response>((resolve) => {
      answer = resolve
    }) })
    const dialog = await openDialog()
    expect(within(dialog).getByRole('status', { name: '正在加载分享的情况…' })).toBeInTheDocument()
    answer(grants())
    expect(await within(dialog).findByText('还没有单独分享给任何人。')).toBeInTheDocument()
  })

  it('分享给我自己的那一条（别的空间管理员分享的）：不能调整，只能取消', async () => {
    renderDialog({ [GRANTS_KEY]: () => grants(grantOf(ME, { grantedBy: BEN })) })
    const dialog = await openDialog()
    const item = within(await within(dialog).findByRole('list', { name: '已分享给' })).getByRole('listitem')
    expect(within(item).queryByRole('combobox')).toBeNull()
    expect(within(item).getByText('这是分享给你自己的，只能取消')).toBeInTheDocument()
    expect(within(item).getByRole('button', { name: `取消分享 ${plainName('艾米', 'amy')}` })).toBeInTheDocument()
  })

  it('被授权人已停用：只给"取消分享"，不给调整角色（服务端对停用的人调整一律 409，M2-P5 审查 B 的 S3）；有效的人照常能调整', async () => {
    renderDialog({ [GRANTS_KEY]: () => grants(grantOf(BEN), grantOf(CAT, { status: 'disabled', role: 'editor' })) })
    const dialog = await openDialog()
    const [ben, cat] = within(await within(dialog).findByRole('list', { name: '已分享给' })).getAllByRole('listitem')
    // 前提：两行都在，对照的那一行（有效的人）照常有角色的选择
    expect(within(ben as HTMLElement).getByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })).toHaveValue('viewer')
    expect(within(cat as HTMLElement).queryByRole('combobox')).toBeNull()
    expect(within(cat as HTMLElement).getByText('编辑者')).toBeInTheDocument()
    expect(within(cat as HTMLElement).getByText('对方的账户已停用，只能取消')).toBeInTheDocument()
    expect(within(cat as HTMLElement).getByRole('button', { name: `取消分享 ${plainName('凯特', 'cat')}` })).toBeInTheDocument()
  })

  it('加载失败：说明原因，可以重试', async () => {
    const api = renderDialog({ [GRANTS_KEY]: inTurn(() => apiError(500, 'INTERNAL_ERROR'), () => grants(grantOf(BEN))) }).api
    const dialog = await openDialog()
    expect(await within(dialog).findByText('分享的情况没能加载')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByRole('list', { name: '已分享给' })).toBeInTheDocument()
    expect(requestsTo(api, GRANTS_KEY)).toBe(2)
  })

  it('打开时就被拒绝（403：例如空间刚被归档）：显示服务端的说明，不给加人；入口所依据的文档详情随之刷新', async () => {
    const { refreshDocument } = renderDialog({ [GRANTS_KEY]: () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享') })
    const dialog = await openDialog()
    expect(await within(dialog).findByText('空间已归档，恢复之后才能调整分享')).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('要分享给的同事')).toBeNull()
    await waitFor(() => expect(refreshDocument).toHaveBeenCalled())
  })

  it('看不到这份文档了（404）：说明已经不在了', async () => {
    renderDialog({ [GRANTS_KEY]: () => apiError(404, 'NOT_FOUND') })
    const dialog = await openDialog()
    expect(await within(dialog).findByText('这份文档已经不在了，或者你已经不能访问它。')).toBeInTheDocument()
  })
})

describe('分享对话框：授权列表第一次就没取到之后的"重试"（规范 §2.4）', () => {
  /** 由测试决定何时回来的那一次请求 */
  function holdNext(api: ReturnType<typeof renderDialog>['api']): { readonly answer: (response: Response) => void } {
    let answer: (response: Response) => void = () => {}
    api.on(GRANTS_KEY, async () => new Promise<Response>((resolve) => {
      answer = resolve
    }))
    return { answer: response => answer(response) }
  }

  it('按"重试"：重试期间说明与同一个按钮留着（不可用、说正在重试，不换成加载中），焦点还在它上面；又失败时换成新的原因；取到之后焦点交给对话框里一直在的说明，不落到对话框本身', async () => {
    const { api } = renderDialog({ [GRANTS_KEY]: () => apiError(500, 'INTERNAL_ERROR') })
    const dialog = await openDialog()
    const alert = (await within(dialog).findByText('分享的情况没能加载')).closest('[role="alert"]') as HTMLElement
    expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试')
    const retry = within(alert).getByRole('button', { name: '重试' })
    const held = holdNext(api)
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(within(dialog).getByText('分享的情况没能加载').closest('[role="alert"]')).toBe(alert)
    // 上一次的原因不再给（请求缓存已经清掉了它）
    expect(alert.textContent).toBe('分享的情况没能加载正在重试…')
    expect(retry).toHaveAttribute('aria-disabled', 'true')
    expect(retry).toHaveAttribute('aria-busy', 'true')
    expect(within(dialog).queryByRole('status', { name: '正在加载分享的情况…' })).toBeNull()
    expect(document.activeElement).toBe(retry)

    held.answer(apiError(429, 'TOO_MANY_ATTEMPTS'))
    await waitFor(() => expect(alert).toHaveTextContent('尝试次数过多，请稍后再试'))
    expect(retry).toHaveTextContent(/^重试$/)
    expect(retry).toHaveAttribute('aria-disabled', 'false')
    expect(document.activeElement).toBe(retry)

    api.on(GRANTS_KEY, () => grants(grantOf(BEN)))
    fireEvent.click(retry)
    expect(await within(dialog).findByRole('list', { name: '已分享给' })).toBeInTheDocument()
    expect(retry).not.toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByText(/^分享给同事之后，对方在"与我共享"里看得到这份文档。/)))
    expect(requestsTo(api, GRANTS_KEY)).toBe(3)
  })

  it('重试之后得到 403（例如空间刚被归档）：说明服务端给的原因、不给重试，焦点同样交给对话框里的说明', async () => {
    const { api } = renderDialog({ [GRANTS_KEY]: () => apiError(500, 'INTERNAL_ERROR') })
    const dialog = await openDialog()
    const retry = within(await within(dialog).findByRole('alert')).getByRole('button', { name: '重试' })
    api.on(GRANTS_KEY, () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享'))
    retry.focus()
    fireEvent.click(retry)
    expect(await within(dialog).findByText('空间已归档，恢复之后才能调整分享')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /重试/ })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByText(/^分享给同事之后/)))
  })

  it('留着之前的列表、刷新却失败了（"没能刷新"）：重试成功之后焦点交给"已分享给"，不落到对话框本身', async () => {
    const { api, client } = renderDialog({ [GRANTS_KEY]: () => grants(grantOf(BEN)) })
    const dialog = await openDialog()
    expect(await within(dialog).findByRole('list', { name: '已分享给' })).toBeInTheDocument()
    api.on(GRANTS_KEY, () => apiError(500, 'INTERNAL_ERROR'))
    await act(async () => {
      await client.refetchQueries({ queryKey: grantsQueryKey(DOCUMENT_ID) })
    })
    const problem = await within(dialog).findByRole('alert')
    expect(problem).toHaveTextContent('分享的情况没能刷新，显示的还是之前的内容')
    api.on(GRANTS_KEY, () => grants(grantOf(BEN), grantOf(CAT)))
    const retry = within(problem).getByRole('button', { name: '重试' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
    expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '已分享给' }))
  })
})

describe('US-M2-10 分享对话框：加人', () => {
  it('同事选择排除自己与已有授权的人', async () => {
    renderDialog({
      [GRANTS_KEY]: () => grants(grantOf(BEN)),
      [colleaguesKey('a')]: () => json(200, { items: [ME, BEN, DAN] }),
    })
    const dialog = await openDialog()
    await within(dialog).findByRole('list', { name: '已分享给' })
    const candidates = await search(dialog, 'a')
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual([shownName('丹', 'dan')])
  })

  it('选人、选角色、分享：请求带着角色；成功之后说明已分享给谁（人名组件），列表随即刷新，选择清掉', async () => {
    const { api } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(), () => grants(grantOf(DAN, { role: 'editor' }))),
      [colleaguesKey('dan')]: () => json(200, { items: [DAN] }),
      [putKey(DAN.id)]: () => json(200, grantOf(DAN, { role: 'editor' })),
    })
    const dialog = await openDialog()
    await within(dialog).findByText('还没有单独分享给任何人。')
    fireEvent.click(within(await search(dialog, 'dan')).getByRole('button', { name: shownName('丹', 'dan') }))
    fireEvent.change(within(dialog).getByLabelText('角色'), { target: { value: 'editor' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '分享' }))
    const notice = await within(dialog).findByText((_content, element) => element?.getAttribute('role') === 'status' && element.textContent === `已分享给 ${shownName('丹', 'dan')}（编辑者）`)
    personIn(notice, '丹', 'dan')
    expect(api.requests.find(request => request.key === putKey(DAN.id))?.body).toEqual({ role: 'editor' })
    expect(await within(dialog).findByRole('list', { name: '已分享给' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('要分享给的同事')).toHaveValue('')
  })

  it('结果未知（网络）：授权列表、文档详情与"与我共享"按共用的做法刷新，说明可能已经生效；对话框的状态区不说"已分享给…"', async () => {
    const { api, client, refreshDocument } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(), () => grants(grantOf(DAN))),
      [colleaguesKey('dan')]: () => json(200, { items: [DAN] }),
      [putKey(DAN.id)]: networkFailure,
    })
    const dialog = await openDialog()
    await within(dialog).findByText('还没有单独分享给任何人。')
    fireEvent.click(within(await search(dialog, 'dan')).getByRole('button', { name: shownName('丹', 'dan') }))
    fireEvent.click(within(dialog).getByRole('button', { name: '分享' }))
    expect(await within(dialog).findByText(/没能确认是否已经完成（网络连接失败，请检查网络后重试）。可能已经生效：页面已按服务端现在的状态刷新/)).toBeInTheDocument()
    expect(requestsTo(api, GRANTS_KEY)).toBe(2)
    expect(refreshDocument).toHaveBeenCalled()
    expect(client.getQueryState(SHARED_LIST_QUERY_KEY)?.isInvalidated).toBe(true)
    // 没有确认成功：做完一件事的说明是空的（刷新之后列表里有丹，那是服务端的状态，不是"这次分享成功了"，M2-P5 审查 A 的建议 2）
    expect(noticeIn(dialog)).toBeEmptyDOMElement()
    // "已分享给"是列表的标题；说明是"已分享给 某人（角色）"
    expect(within(dialog).queryByText(/已分享给 /)).toBeNull()
  })

  it('被拒绝（403）：显示服务端的说明；授权列表与文档详情随之刷新（入口随新的权限消失）', async () => {
    const { refreshDocument } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(), () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享')),
      [colleaguesKey('dan')]: () => json(200, { items: [DAN] }),
      [putKey(DAN.id)]: () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享'),
    })
    const dialog = await openDialog()
    await within(dialog).findByText('还没有单独分享给任何人。')
    fireEvent.click(within(await search(dialog, 'dan')).getByRole('button', { name: shownName('丹', 'dan') }))
    fireEvent.click(within(dialog).getByRole('button', { name: '分享' }))
    // 列表重新请求也被拒绝：不再显示能操作的表单，说明换成服务端给的原因
    await waitFor(() => expect(within(dialog).queryByLabelText('要分享给的同事')).toBeNull())
    expect(within(dialog).getByText('空间已归档，恢复之后才能调整分享')).toBeInTheDocument()
    expect(refreshDocument).toHaveBeenCalled()
  })
})

describe('US-M2-10 分享对话框：调整与取消', () => {
  it('调整：选好之后点"保存"才提交；结果未知时按共用的做法刷新（授权列表、文档详情与"与我共享"），在这一行说明可能已经生效', async () => {
    const { api, client, refreshDocument } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN)), () => grants(grantOf(BEN))),
      [putKey(BEN.id)]: () => apiError(502, 'INTERNAL_ERROR'),
    })
    const dialog = await openDialog()
    const role = await within(dialog).findByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })
    fireEvent.change(role, { target: { value: 'editor' } })
    expect(api.requests.some(request => request.key === putKey(BEN.id))).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: `保存 ${plainName('本', 'ben')} 的角色` }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/没能确认是否已经完成.*可能已经生效：页面已按服务端现在的状态刷新/)
    expect(api.requests.find(request => request.key === putKey(BEN.id))?.body).toEqual({ role: 'editor' })
    expect(requestsTo(api, GRANTS_KEY)).toBe(2)
    expect(refreshDocument).toHaveBeenCalled()
    expect(client.getQueryState(SHARED_LIST_QUERY_KEY)?.isInvalidated).toBe(true)
    expect(within(dialog).getByRole('combobox', { name: `${plainName('本', 'ben')} 的角色` })).toHaveValue('viewer')
  })

  it('取消：先确认（标题里的人名登录名在前）；取消之后说明，列表与"与我共享"随之刷新，那一行不在了，焦点交给"已分享给"', async () => {
    const { client } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN)), () => grants()),
      [deleteKey(BEN.id)]: () => new Response(null, { status: 204 }),
    })
    const dialog = await openDialog()
    // 点按钮时焦点在它身上（jsdom 的 click 不移焦点）：确认框关闭时要回到的就是它，那一行随取消消失
    const revoke = await within(dialog).findByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` })
    revoke.focus()
    fireEvent.click(revoke)
    const confirm = await screen.findByRole('dialog', { name: `取消分享给 ${plainName('本', 'ben')}？` })
    // 确认框的说明不假定对方在这个空间里没有角色：取消的是这一条分享（M2-P5 审查 B 的 S4）
    expect(confirm).toHaveAccessibleDescription('取消之后，对方立即不能再凭这条分享访问这份文档，已经打开的页面也一样；他在这个空间里另有角色的，照样按那个角色访问。')
    const announced = watchAnnouncement(`已取消分享给 ${shownName('本', 'ben')}`)
    fireEvent.click(within(confirm).getByRole('button', { name: '取消分享' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^取消分享给/ })).toBeNull())
    expect(await within(dialog).findByText((_content, element) => element?.getAttribute('role') === 'status' && element.textContent === `已取消分享给 ${shownName('本', 'ben')}`)).toBeInTheDocument()
    // 说明等确认框关掉、焦点交还之后才写进状态区（M2-P5 复验 S1）：确认框开着时 Radix 把对话框标为 aria-hidden，那时写进去的读屏多半不播报
    expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
    expect(await within(dialog).findByText('还没有单独分享给任何人。')).toBeInTheDocument()
    expect(client.getQueryState(SHARED_LIST_QUERY_KEY)?.isInvalidated).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '已分享给' })))
  })

  it('取消的结果未知：确认框里说明可能已经生效；授权列表、文档详情与"与我共享"按共用的做法刷新', async () => {
    const { api, client, refreshDocument } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN)), () => grants()),
      [deleteKey(BEN.id)]: () => apiError(500, 'INTERNAL_ERROR'),
    })
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` }))
    const confirm = await screen.findByRole('dialog', { name: `取消分享给 ${plainName('本', 'ben')}？` })
    fireEvent.click(within(confirm).getByRole('button', { name: '取消分享' }))
    expect(await within(confirm).findByText(/没能确认是否已经完成.*可能已经生效：页面已按服务端现在的状态刷新/)).toBeInTheDocument()
    expect(requestsTo(api, GRANTS_KEY)).toBe(2)
    expect(refreshDocument).toHaveBeenCalled()
    expect(client.getQueryState(SHARED_LIST_QUERY_KEY)?.isInvalidated).toBe(true)
  })

  it('取消时这份文档已经不在了（404）：确认框里说明已经不在了', async () => {
    renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN)), () => apiError(404, 'NOT_FOUND')),
      [deleteKey(BEN.id)]: () => apiError(404, 'NOT_FOUND'),
    })
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` }))
    const confirm = await screen.findByRole('dialog', { name: `取消分享给 ${plainName('本', 'ben')}？` })
    fireEvent.click(within(confirm).getByRole('button', { name: '取消分享' }))
    expect(await within(confirm).findByText('这份文档已经不在了，或者你已经不能访问它。')).toBeInTheDocument()
  })

  // 取消没有确认成功（结果未知、被拒绝、文档已经不在了）：对话框的状态区（读屏会播报）不能说"已取消分享给…"——
  // 上面两条只核对确认框里的说明，把"已取消分享给…"挪到请求之前照样全绿（M2-P5 审查 A 的建议 2，回归用例 R2 并进来）
  it.each([
    ['结果未知（网络）', networkFailure],
    ['结果未知（500）', () => apiError(500, 'INTERNAL_ERROR')],
    ['被拒绝（403，空间刚被归档）', () => apiError(403, 'PERMISSION_DENIED', '空间已归档，恢复之后才能调整分享')],
    ['文档已经不在了（404）', () => apiError(404, 'NOT_FOUND')],
  ] as const)('取消没有确认成功——%s：对话框不说"已取消分享给…"', async (_name, failure) => {
    renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN)), () => grants(grantOf(BEN))),
      [deleteKey(BEN.id)]: failure,
    })
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` }))
    const confirm = await screen.findByRole('dialog', { name: `取消分享给 ${plainName('本', 'ben')}？` })
    fireEvent.click(within(confirm).getByRole('button', { name: '取消分享' }))
    // 确认框里给出了失败的说明（共用的做法），这时再看对话框的状态区
    await within(confirm).findByRole('alert')
    expect(noticeIn(dialog)).toBeEmptyDOMElement()
    expect(within(dialog).queryByText(/已取消分享给/)).toBeNull()
  })
})

// 写入已经确定成功之后的刷新（Codex 对抗评审 CX4、CX5，回归用例由 Codex 的前端探针改写）：
// - 刷新一直不回来：确认框原来一直停在"正在处理…"，取消与 Esc 都关不掉。现在最多等到时限，确认框照常关掉，说明在关掉之后写进状态区、
//   说列表还在刷新；那一行按确定的写入结果先去掉，焦点交给"已分享给"；后台的刷新回来之后说明不再说还在刷新；
// - 刷新失败（列表留着之前的数据）：原来照旧显示旧的授权，既不说没能刷新、也没有重试。现在列表上方明说没能刷新、给出重试
describe('US-M2-10 分享对话框：写入成功之后的刷新（Codex 对抗评审 CX4、CX5）', () => {
  const STILL = '列表还在刷新，显示的可能还是之前的，刷新好了会自动更新'

  it('取消分享：DELETE 204，随后刷新列表的请求一直不回来——到了时限确认框关掉，说明在关掉之后写进状态区（说列表还在刷新），那一行已经不在、焦点在"已分享给"；后台的刷新回来之后不再说还在刷新', async () => {
    // 跟着真实的时间走，另外可以一下子拨过时限；在前面留出 2 秒的余量，测试本身的耗时不会让时限提前到
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let finish: (response: Response) => void = () => {}
      const { api } = renderDialog({
        [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN), grantOf(CAT)), async () => new Promise<Response>((resolve) => {
          finish = resolve
        })),
        [deleteKey(BEN.id)]: () => new Response(null, { status: 204 }),
      })
      const dialog = await openDialog()
      const revoke = await within(dialog).findByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` })
      revoke.focus()
      fireEvent.click(revoke)
      const confirm = await screen.findByRole('dialog', { name: `取消分享给 ${plainName('本', 'ben')}？` })
      const announced = watchAnnouncement(`已取消分享给 ${shownName('本', 'ben')}`)
      fireEvent.click(within(confirm).getByRole('button', { name: '取消分享' }))
      // 前提：DELETE 已经成功，刷新的请求已经发出、还没有回来
      await waitFor(() => expect(requestsTo(api, GRANTS_KEY)).toBe(2))
      expect(requestsTo(api, deleteKey(BEN.id))).toBe(1)
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS - 2_000))
      // 时限之前照旧在等（与失败之后的刷新同一个时限）：还在进行中，说明还没有写
      expect(within(confirm).getByRole('button', { name: '正在处理…' })).toHaveAttribute('aria-disabled', 'true')
      expect(noticeIn(dialog)).toBeEmptyDOMElement()
      await act(async () => vi.advanceTimersByTimeAsync(2_000))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /^取消分享给/ })).toBeNull())
      expect(noticeIn(dialog)).toHaveTextContent(`已取消分享给 ${shownName('本', 'ben')}；${STILL}`)
      // 写进去的那一刻确认框已经关掉、对话框不在 aria-hidden 之下、焦点已经交还（M2-P5 复验 S1 的约定照旧）
      expect(announced()).toEqual({ ariaHidden: false, focusReturned: true })
      // 那一行按确定的写入结果已经去掉（刷新还没回来），另一个人还在；焦点交给"已分享给"
      const list = within(dialog).getByRole('list', { name: '已分享给' })
      expect(within(list).queryByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` })).toBeNull()
      expect(within(list).getByRole('button', { name: `取消分享 ${plainName('凯特', 'cat')}` })).toBeInTheDocument()
      await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: '已分享给' })))
      // 后台的刷新回来了：说明不再说还在刷新，列表是服务端现在的样子
      await act(async () => finish(grants(grantOf(CAT))))
      await waitFor(() => expect(noticeIn(dialog)).toHaveTextContent(new RegExp(`^已取消分享给 ${shownName('本', 'ben')}$`)))
      expect(within(dialog).getAllByRole('listitem')).toHaveLength(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('分享给一个人：PUT 成功，随后刷新一直不回来——到了时限照常结束（按钮不再"正在分享…"），这个人已经按响应放进列表，说明说列表还在刷新', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderDialog({
        [GRANTS_KEY]: inTurn(() => grants(), async () => new Promise<Response>(() => {})),
        [colleaguesKey('dan')]: () => json(200, { items: [DAN] }),
        [putKey(DAN.id)]: () => json(200, grantOf(DAN, { role: 'editor' })),
      })
      const dialog = await openDialog()
      await within(dialog).findByText('还没有单独分享给任何人。')
      fireEvent.click(within(await search(dialog, 'dan')).getByRole('button', { name: shownName('丹', 'dan') }))
      fireEvent.change(within(dialog).getByLabelText('角色'), { target: { value: 'editor' } })
      fireEvent.click(within(dialog).getByRole('button', { name: '分享' }))
      expect(await within(dialog).findByRole('button', { name: '正在分享…' })).toBeInTheDocument()
      await act(async () => vi.advanceTimersByTimeAsync(OUTCOME_REFRESH_TIME_LIMIT_MS))
      await waitFor(() => expect(noticeIn(dialog)).toHaveTextContent(`已分享给 ${shownName('丹', 'dan')}（编辑者）；${STILL}`))
      expect(within(dialog).getByRole('button', { name: '分享' })).toBeInTheDocument()
      expect(within(dialog).getByRole('combobox', { name: `${plainName('丹', 'dan')} 的角色` })).toHaveValue('editor')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('取消分享成功（204），随后刷新列表回 500：列表上方说明没能刷新（原因）、给出重试，那一行按确定的写入结果已经去掉；重试成功之后说明消失，列表是新的', async () => {
    const { api } = renderDialog({
      [GRANTS_KEY]: inTurn(() => grants(grantOf(BEN), grantOf(CAT)), () => apiError(500, 'INTERNAL_ERROR'), () => grants(grantOf(CAT), grantOf(DAN))),
      [deleteKey(BEN.id)]: () => new Response(null, { status: 204 }),
    })
    const dialog = await openDialog()
    fireEvent.click(await within(dialog).findByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` }))
    const confirm = await screen.findByRole('dialog', { name: `取消分享给 ${plainName('本', 'ben')}？` })
    fireEvent.click(within(confirm).getByRole('button', { name: '取消分享' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^取消分享给/ })).toBeNull())
    // 写入成功：说明照常（刷新已经有了结果，不说还在刷新）；刷新失败不算这次操作失败。
    // 要等：说明在确认框关掉、焦点交还之后才写（Radix 卸下之后延后一个任务交还焦点），确认框不在了的那一刻还没写——
    // 原来这里同步断言，推送前的快速门禁在负载下失败过一次
    await waitFor(() => expect(noticeIn(dialog)).toHaveTextContent(new RegExp(`^已取消分享给 ${shownName('本', 'ben')}$`)))
    const problem = await within(dialog).findByRole('alert')
    expect(problem).toHaveTextContent('分享的情况没能刷新，显示的还是之前的内容')
    expect(problem).toHaveTextContent('服务器出了点问题，请稍后重试')
    // 在列表上方
    const heading = within(dialog).getByRole('heading', { name: '已分享给' })
    expect(problem.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 之前的列表照常显示：取消掉的那一行按确定的写入结果已经去掉，另一个人还在
    expect(within(dialog).queryByRole('button', { name: `取消分享 ${plainName('本', 'ben')}` })).toBeNull()
    expect(within(dialog).getByRole('button', { name: `取消分享 ${plainName('凯特', 'cat')}` })).toBeInTheDocument()
    fireEvent.click(within(problem).getByRole('button', { name: '重试' }))
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull())
    expect(requestsTo(api, GRANTS_KEY)).toBe(3)
    expect(within(dialog).getByRole('button', { name: `取消分享 ${plainName('丹', 'dan')}` })).toBeInTheDocument()
  })
})

// 按名字选同事（按关键词选一项，M2-P2 设计 §3.10）：输入停下之后才查找；候选排除给定的人；选中之后显示成标签，
// "重新选择"带上选的是什么；选中与重新选择之后焦点移到新出现的元素上；只显示与输入框一致的候选；查找失败可以重试
// （重新查找期间说明与"重试"留着，有了结果之后焦点交给输入框，规范 §2.4）；查找的进展放在一直在的状态容器里。接口用假的 fetch。
import type { UserSummary } from '@nerve-office/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
import { personIn } from '../../shared/testing/people.test-support.ts'
import { ColleaguePicker } from './colleague-picker.tsx'

const BEN = { id: '0199a2c4-0000-7000-8000-00000000000b', username: 'ben', displayName: '本' }
const BEA = { id: '0199a2c4-0000-7000-8000-00000000000d', username: 'bea', displayName: '本雅' }

function usersKey(keyword: string): string {
  return `GET /api/users?${new URLSearchParams({ query: keyword }).toString()}`
}

function Picker({ exclude }: { readonly exclude?: ReadonlySet<string> }) {
  const [user, setUser] = useState<UserSummary>()
  return <ColleaguePicker label="首个空间管理员" selected={user} onSelect={setUser} exclude={exclude} />
}

function renderPicker(exclude?: ReadonlySet<string>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Picker exclude={exclude} />
    </QueryClientProvider>,
  )
}

function input(): HTMLElement {
  return screen.getByLabelText('首个空间管理员')
}

describe('ColleaguePicker', () => {
  it('输入停下之后按去掉首尾空白的关键词查找；排除的人不作为候选', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => json(200, { items: [BEN, BEA] }) })
    renderPicker(new Set([BEA.id]))
    expect(input()).toHaveAttribute('placeholder', '按名字或登录名搜索同事')
    fireEvent.change(input(), { target: { value: ' 本 ' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual(['@ben 本'])
    expect(api.requests.map(request => request.key)).toEqual([usersKey('本')])
    // 找到了：状态容器里没有文字
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('选中之后显示成标签，标签仍在原处，焦点移到"重新选择 <标签>"；重新选择之后输入框是空的、焦点回到它，上一次的候选不再出现（审查 B10、B11、B14）', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => json(200, { items: [BEN] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    fireEvent.click(await screen.findByRole('button', { name: '@ben 本' }))
    expect(screen.getByText('已选择：')).toHaveTextContent('已选择：@ben 本')
    expect(screen.getByText('首个空间管理员')).toBeInTheDocument()
    const change = screen.getByRole('button', { name: '重新选择 首个空间管理员' })
    expect(change).toHaveTextContent('重新选择')
    await waitFor(() => expect(document.activeElement).toBe(change))

    fireEvent.click(change)
    await waitFor(() => expect(document.activeElement).toBe(input()))
    expect(input()).toHaveValue('')
    // 防抖之后的查询还是"本"：它的候选不挂在空的输入框下面，也不为它再请求
    expect(screen.queryByRole('list', { name: '找到的同事' })).toBeNull()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(screen.queryByRole('list', { name: '找到的同事' })).toBeNull()
    expect(api.requests).toHaveLength(1)
  })

  it('输入还没停下时不显示上一个关键词的候选，显示查找中（审查 B11）', async () => {
    installFakeApi({
      [usersKey('本')]: () => json(200, { items: [BEN] }),
      [usersKey('本x')]: () => json(200, { items: [] }),
    })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    expect(await screen.findByRole('list', { name: '找到的同事' })).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: '本x' } })
    expect(screen.queryByRole('list', { name: '找到的同事' })).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('正在查找…')
    expect(await screen.findByText('没有找到这个人')).toBeInTheDocument()
  })

  it('查找的进展（查找中、没有找到）：状态容器先在（空的），输入之后往里填文字，容器本身不换（复验：与内容一起插入的 role="status" 部分读屏软件不播报）', async () => {
    installFakeApi({ [usersKey('本x')]: () => json(200, { items: [] }) })
    renderPicker()
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()
    fireEvent.change(input(), { target: { value: '本x' } })
    expect(status).toHaveTextContent('正在查找…')
    await waitFor(() => expect(status).toHaveTextContent('没有找到这个人'))
    expect(screen.getByRole('status')).toBe(status)
    // 清空关键词：文字随之清掉，容器仍在
    fireEvent.change(input(), { target: { value: '' } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
  })

  it('显示名里写了"（登录名）"冒充别人：候选与已选都把登录名放在单独的元素里，两个人分得清（M2-P6 复核 M2）', async () => {
    const real = { id: '0199a2c4-0000-7000-8000-000000000021', username: 'lisi', displayName: '李四' }
    const spoof = { id: '0199a2c4-0000-7000-8000-000000000022', username: 'mallory', displayName: '李四（lisi）' }
    installFakeApi({ [usersKey('李四')]: () => json(200, { items: [real, spoof] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: '李四' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    // 每个候选里：显示名在 <bdi> 里，登录名是另一个元素（等宽、前面带 @），显示名里的"（lisi）"只是显示名的一部分
    const realName = personIn(candidates, '李四', 'lisi')
    const spoofName = personIn(candidates, '李四（lisi）', 'mallory')
    expect(realName.closest('button')).not.toBe(spoofName.closest('button'))
    expect(spoofName.querySelector('[data-slot="person-username"]')).toHaveClass('font-mono')
    // 按钮的可读名称同样分得清
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual(['@lisi 李四', '@mallory 李四（lisi）'])

    fireEvent.click(screen.getByRole('button', { name: '@mallory 李四（lisi）' }))
    const chosen = screen.getByText('已选择：')
    expect(personIn(chosen, '李四（lisi）', 'mallory')).toBeInTheDocument()
  })

  it('登录名与显示名同样醒目（需求方 2026-10-02 的决定，第三批 S-d）：登录名不是次要色、不小一号、不另设粗细，只用等宽字体与 @ 区分；候选与已选都是这样', async () => {
    const spoof = { id: '0199a2c4-0000-7000-8000-000000000023', username: 'mallory', displayName: '李四（lisi）' }
    installFakeApi({ [usersKey('李四')]: () => json(200, { items: [spoof] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: '李四' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    function expectSameProminence(person: HTMLElement): void {
      const login = person.querySelector('[data-slot="person-username"]')
      expect(login).toHaveClass('font-mono')
      expect(login).not.toHaveClass('text-muted-foreground')
      expect(login).not.toHaveClass('text-[0.9em]')
      expect(login).not.toHaveClass('font-normal')
      // 颜色、字号、粗细都随所在的地方（与显示名相同）：登录名自己不设任何文字的颜色、字号或粗细
      expect(login?.className).not.toMatch(/(?:^|\s)(?:text-|font-(?!mono(?:\s|$)))/)
      expect(person.querySelector('[data-slot="person-display-name"]')?.getAttribute('class')).toBeNull()
    }
    expectSameProminence(personIn(candidates, '李四（lisi）', 'mallory'))
    fireEvent.click(screen.getByRole('button', { name: '@mallory 李四（lisi）' }))
    expectSameProminence(personIn(screen.getByText('已选择：'), '李四（lisi）', 'mallory'))
  })

  it('显示名写成"李四 @lisi"冒充别人：候选与已选的可读名称都是登录名在前，从开头就分得清（M2-P6 复核第二批 M-1）', async () => {
    const real = { id: '0199a2c4-0000-7000-8000-000000000024', username: 'lisi', displayName: '李四' }
    const spoof = { id: '0199a2c4-0000-7000-8000-000000000025', username: 'eve', displayName: '李四 @lisi' }
    installFakeApi({ [usersKey('lisi')]: () => json(200, { items: [real, spoof] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: 'lisi' } })
    const candidates = await screen.findByRole('list', { name: '找到的同事' })
    // 读屏读出的候选（按钮的可读名称）：原来显示名在前，是"李四 @lisi"与"李四 @lisi @eve"，前缀相同；
    // 登录名在前之后，冒充者的可读名称从第一个词起就不同，以真人的可读名称开头的只有真人一个
    const names = within(candidates).getAllByRole('button').map(button => button.textContent ?? '')
    expect(names).toEqual(['@lisi 李四', '@eve 李四 @lisi'])
    expect(names.filter(name => name.startsWith('@lisi '))).toEqual(['@lisi 李四'])
    expect(screen.getByRole('button', { name: '@eve 李四 @lisi' })).toBeInTheDocument()
    personIn(candidates, '李四 @lisi', 'eve')

    fireEvent.click(screen.getByRole('button', { name: '@eve 李四 @lisi' }))
    // 已选的标签同样登录名在前
    expect(screen.getByText('已选择：')).toHaveTextContent(/^已选择：@eve 李四 @lisi$/)
  })

  it('从右到左的显示名：用 <bdi> 隔离，不打乱旁边的字（M2-P6 复核 M2）', async () => {
    const hebrew = { id: '0199a2c4-0000-7000-8000-000000000023', username: 'shalom', displayName: 'שלום' }
    installFakeApi({ [usersKey('shalom')]: () => json(200, { items: [hebrew] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: 'shalom' } })
    const name = personIn(await screen.findByRole('list', { name: '找到的同事' }), 'שלום', 'shalom')
    expect(name.querySelector('bdi')).toHaveTextContent('שלום')
  })

  it('查找失败、按"重试"：重新查找期间说明与同一个按钮留着（不可用、说正在重试，不换成"正在查找…"），焦点还在它上面；又失败时换成新的原因；找到之后说明消失，焦点交给输入框（规范 §2.4）', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => apiError(500, 'INTERNAL_ERROR') })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('查找失败：服务器出了点问题，请稍后重试')
    const retry = within(alert).getByRole('button', { name: '重试' })
    let answer: (response: Response) => void = () => {}
    api.on(usersKey('本'), async () => new Promise<Response>((resolve) => {
      answer = resolve
    }))
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(screen.getByRole('alert')).toBe(alert)
    // 上一次的原因不再给（请求缓存已经清掉了它）
    expect(alert.textContent).toBe('查找失败正在重试…')
    expect(retry).toHaveAttribute('aria-disabled', 'true')
    expect(retry).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
    expect(document.activeElement).toBe(retry)
    // 进行中再按：交回在途的那一次，不重复请求
    fireEvent.click(retry)
    expect(api.requests.filter(request => request.key === usersKey('本'))).toHaveLength(2)

    answer(apiError(429, 'TOO_MANY_ATTEMPTS'))
    await waitFor(() => expect(alert).toHaveTextContent('查找失败：尝试次数过多，请稍后再试'))
    expect(retry).toHaveTextContent(/^重试$/)
    expect(retry).toHaveAttribute('aria-disabled', 'false')
    expect(document.activeElement).toBe(retry)

    api.on(usersKey('本'), () => json(200, { items: [BEN] }))
    fireEvent.click(retry)
    expect(await screen.findByRole('button', { name: '@ben 本' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('同一个关键词之前找到过、这次重新查找失败了：只说失败（不留之前的候选）；按"重试"期间说明与按钮留着，找到之后焦点交给输入框', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => json(200, { items: [BEN] }), [usersKey('本x')]: () => json(200, { items: [] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    expect(await screen.findByRole('list', { name: '找到的同事' })).toBeInTheDocument()
    fireEvent.change(input(), { target: { value: '本x' } })
    expect(await screen.findByText('没有找到这个人')).toBeInTheDocument()
    // 回到"本"：缓存里有之前的候选，重新查找失败了
    api.on(usersKey('本'), () => apiError(500, 'INTERNAL_ERROR'))
    fireEvent.change(input(), { target: { value: '本' } })
    const alert = await screen.findByRole('alert', {}, { timeout: 2000 })
    expect(alert).toHaveTextContent('查找失败：服务器出了点问题，请稍后重试')
    expect(screen.queryByRole('list', { name: '找到的同事' })).toBeNull()

    let answer: (response: Response) => void = () => {}
    api.on(usersKey('本'), async () => new Promise<Response>((resolve) => {
      answer = resolve
    }))
    const retry = within(alert).getByRole('button', { name: '重试' })
    retry.focus()
    fireEvent.click(retry)
    await waitFor(() => expect(retry).toHaveTextContent('正在重试…'))
    expect(screen.getByRole('alert')).toBe(alert)
    expect(screen.queryByRole('list', { name: '找到的同事' })).toBeNull()
    expect(document.activeElement).toBe(retry)
    answer(json(200, { items: [BEN] }))
    expect(await screen.findByRole('button', { name: '@ben 本' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(input())
  })

  it('回到之前查找失败过的关键词：重新查找期间是"正在查找…"（没有人按过"重试"，不说正在重试）', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => apiError(500, 'INTERNAL_ERROR'), [usersKey('本x')]: () => json(200, { items: [] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('查找失败')
    fireEvent.change(input(), { target: { value: '本x' } })
    expect(await screen.findByText('没有找到这个人')).toBeInTheDocument()
    let answer: (response: Response) => void = () => {}
    api.on(usersKey('本'), async () => new Promise<Response>((resolve) => {
      answer = resolve
    }))
    fireEvent.change(input(), { target: { value: '本' } })
    await waitFor(() => expect(api.requests.filter(request => request.key === usersKey('本'))).toHaveLength(2), { timeout: 2000 })
    expect(screen.getByRole('status')).toHaveTextContent('正在查找…')
    expect(screen.queryByRole('alert')).toBeNull()
    answer(json(200, { items: [BEN] }))
    expect(await screen.findByRole('button', { name: '@ben 本' })).toBeInTheDocument()
  })

  it('查找失败：说明原因，可以重试（审查 B14）', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => apiError(500, 'INTERNAL_ERROR') })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('查找失败：服务器出了点问题，请稍后重试')
    api.on(usersKey('本'), () => json(200, { items: [BEN] }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '@ben 本' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

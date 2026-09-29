// 按名字选同事（按关键词选一项，M2-P2 设计 §3.10）：输入停下之后才查找；候选排除给定的人；选中之后显示成标签，
// "重新选择"带上选的是什么；选中与重新选择之后焦点移到新出现的元素上；只显示与输入框一致的候选；查找失败可以重试；
// 查找的进展放在一直在的状态容器里。接口用假的 fetch。
import type { UserSummary } from '@nerve-office/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { apiError, installFakeApi, json } from '../../shared/testing/fake-api.test-support.ts'
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
    expect(within(candidates).getAllByRole('button').map(button => button.textContent)).toEqual(['本（ben）'])
    expect(api.requests.map(request => request.key)).toEqual([usersKey('本')])
    // 找到了：状态容器里没有文字
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('选中之后显示成标签，标签仍在原处，焦点移到"重新选择 <标签>"；重新选择之后输入框是空的、焦点回到它，上一次的候选不再出现（审查 B10、B11、B14）', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => json(200, { items: [BEN] }) })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    fireEvent.click(await screen.findByRole('button', { name: '本（ben）' }))
    expect(screen.getByText('已选择：本（ben）')).toBeInTheDocument()
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

  it('查找失败：说明原因，可以重试（审查 B14）', async () => {
    const api = installFakeApi({ [usersKey('本')]: () => apiError(500, 'INTERNAL_ERROR') })
    renderPicker()
    fireEvent.change(input(), { target: { value: '本' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('查找失败：服务器出了点问题，请稍后重试')
    api.on(usersKey('本'), () => json(200, { items: [BEN] }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '本（ben）' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// 写操作成功之后、到了时限还在后台的刷新（Codex 对抗评审 CX4）：说明里接着说列表还在刷新，刷新有了结果之后不再说
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../api/client.ts'
import { refreshAfterSuccess } from '../api/write-outcome.ts'
import { StillRefreshing } from './still-refreshing.tsx'

/** 由用例决定何时有结果的刷新，时限很短：拿到在后台的刷新 */
async function backgroundRefresh() {
  let finish: (ok: boolean) => void = () => {}
  const background = await refreshAfterSuccess(async () => new Promise<void>((resolve, reject) => {
    finish = ok => (ok ? resolve() : reject(new NetworkError('网络请求失败')))
  }), { timeLimitMs: 10 })
  if (background === undefined)
    throw new Error('前提：到了时限还没有结果')
  return { background, finish: (ok: boolean) => finish(ok) }
}

describe('StillRefreshing', () => {
  it('没有在后台的刷新（在时限之内已经有了结果）：什么也不显示，说明原样', () => {
    render(
      <p role="status">
        已取消分享给 某人
        <StillRefreshing refresh={undefined} />
      </p>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/^已取消分享给 某人$/)
  })

  it.each([['成功', true], ['失败', false]] as const)('还在后台刷新：接在说明后面（分号隔开）说列表还在刷新；刷新随后%s，不再说', async (_name, ok) => {
    const { background, finish } = await backgroundRefresh()
    render(
      <p role="status">
        已复制出「周报 的副本」
        <StillRefreshing refresh={background} list="成员列表" />
      </p>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/^已复制出「周报 的副本」；成员列表还在刷新，显示的可能还是之前的，刷新好了会自动更新$/)
    await act(async () => finish(ok))
    expect(screen.getByRole('status')).toHaveTextContent(/^已复制出「周报 的副本」$/)
  })

  it('刷新在说明写出之前就有了结果：一开始就不说还在刷新', async () => {
    const { background, finish } = await backgroundRefresh()
    finish(true)
    await vi.waitFor(() => expect(background.settled()).toBe(true))
    render(
      <p role="status">
        已完成
        <StillRefreshing refresh={background} />
      </p>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/^已完成$/)
  })
})

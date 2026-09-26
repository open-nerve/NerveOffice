import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSessionChannel } from './session-channel.ts'

const opened: { close: () => void }[] = []

function open(): ReturnType<typeof openSessionChannel> {
  const channel = openSessionChannel()
  opened.push(channel)
  return channel
}

afterEach(() => {
  opened.splice(0).forEach(channel => channel.close())
})

/** BroadcastChannel 的消息异步送达：等到监听者被调用，或者确认没有被调用 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('openSessionChannel', () => {
  it('一个标签页宣布会话变了：其他标签页收到，自己收不到', async () => {
    const mine = open()
    const other = open()
    const onMine = vi.fn()
    const onOther = vi.fn()
    mine.subscribe(onMine)
    other.subscribe(onOther)
    mine.announce()
    await vi.waitFor(() => expect(onOther).toHaveBeenCalledTimes(1))
    await settle()
    expect(onMine).not.toHaveBeenCalled()
  })

  it('取消订阅之后不再收到', async () => {
    const mine = open()
    const other = open()
    const listener = vi.fn()
    const unsubscribe = other.subscribe(listener)
    unsubscribe()
    mine.announce()
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })

  it('同名通道上别的消息不理会', async () => {
    const other = open()
    const listener = vi.fn()
    other.subscribe(listener)
    const raw = new BroadcastChannel('nerve-office:session')
    opened.push(raw)
    raw.postMessage({ unrelated: true })
    await settle()
    expect(listener).not.toHaveBeenCalled()
  })

  it('浏览器没有 BroadcastChannel：退化为不通知，不报错', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const channel = openSessionChannel()
    const listener = vi.fn()
    const unsubscribe = channel.subscribe(listener)
    channel.announce()
    unsubscribe()
    channel.close()
    expect(listener).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSessionChannel } from './session-channel.ts'

const opened: { close: () => void }[] = []

function open(create = openSessionChannel): ReturnType<typeof openSessionChannel> {
  const channel = create()
  opened.push(channel)
  return channel
}

/** 每个 Document 有自己的模块实例；原生 BroadcastChannel 仍负责真实异步传送。 */
async function otherDocument(): Promise<ReturnType<typeof openSessionChannel>> {
  vi.resetModules()
  return open((await import('./session-channel.ts')).openSessionChannel)
}

afterEach(() => {
  opened.splice(0).forEach(channel => channel.close())
})

/** BroadcastChannel 的消息异步送达：等到监听者被调用，或者确认没有被调用 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

describe('openSessionChannel', () => {
  it('同页运行时与短命通知者共用通道：其他页面收到，本页所有调用者都不回声', async () => {
    const runtime = open()
    const notifier = open()
    const other = await otherDocument()
    const onRuntime = vi.fn()
    const onNotifier = vi.fn()
    const onOther = vi.fn()
    runtime.subscribe(onRuntime)
    notifier.subscribe(onNotifier)
    other.subscribe(onOther)
    notifier.announce()
    notifier.close()
    await vi.waitFor(() => expect(onOther).toHaveBeenCalledTimes(1))
    await settle()
    expect(onRuntime).not.toHaveBeenCalled()
    expect(onNotifier).not.toHaveBeenCalled()
  })

  it('别的 Document 宣布会话变了：本页各个订阅者都收到，发送页收不到', async () => {
    const mine = open()
    const maintenance = open()
    const other = await otherDocument()
    const onMine = vi.fn()
    const onMaintenance = vi.fn()
    const onOther = vi.fn()
    mine.subscribe(onMine)
    maintenance.subscribe(onMaintenance)
    other.subscribe(onOther)
    other.announce()
    await vi.waitFor(() => {
      expect(onMine).toHaveBeenCalledTimes(1)
      expect(onMaintenance).toHaveBeenCalledTimes(1)
    })
    await settle()
    expect(onOther).not.toHaveBeenCalled()
  })

  it('关闭一个调用者只撤掉它的订阅，其余调用者仍能收发', async () => {
    const closed = open()
    const remaining = open()
    const other = await otherDocument()
    const onClosed = vi.fn()
    const onRemaining = vi.fn()
    const onOther = vi.fn()
    closed.subscribe(onClosed)
    remaining.subscribe(onRemaining)
    other.subscribe(onOther)
    closed.close()
    other.announce()
    await vi.waitFor(() => expect(onRemaining).toHaveBeenCalledTimes(1))
    remaining.announce()
    await vi.waitFor(() => expect(onOther).toHaveBeenCalledTimes(1))
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('最后一个调用者关闭后可以重开；旧句柄重复关闭不会关掉新的通道', async () => {
    const previous = open()
    previous.close()
    const current = open()
    const other = await otherDocument()
    const listener = vi.fn()
    current.subscribe(listener)
    previous.close()
    other.announce()
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  })

  it('已经关闭的句柄不能继续发送或增加订阅，也不会影响同页仍在使用的通道', async () => {
    const closed = open()
    const active = open()
    const other = await otherDocument()
    const onClosed = vi.fn()
    const onOther = vi.fn()
    const onActive = vi.fn()
    other.subscribe(onOther)
    active.subscribe(onActive)
    closed.close()
    const unsubscribe = closed.subscribe(onClosed)
    expect(() => closed.announce()).not.toThrow()
    other.announce()
    await vi.waitFor(() => expect(onActive).toHaveBeenCalledTimes(1))
    unsubscribe()
    expect(onClosed).not.toHaveBeenCalled()
    expect(onOther).not.toHaveBeenCalled()
  })

  it('取消订阅之后不再收到', async () => {
    const mine = await otherDocument()
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

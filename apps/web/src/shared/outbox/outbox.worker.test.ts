import { afterEach, describe, expect, it, vi } from 'vitest'
import { OUTBOX_PROTOCOL_VERSION } from './outbox-protocol.ts'

// 生产的发件箱 Worker 入口（审查 B3）：一启动就开 100 ms 的空定时器（DEF-011，ADR-020：WebKit 上 Worker 空闲之后第一次异步操作的停顿），
// 生产里握手的 keepAlive: false 也停不掉它（停掉的分支只在测试构建里）。桩出 Worker 的全局（addEventListener、postMessage）之后引入入口

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('生产的发件箱 Worker 入口', () => {
  it('一启动就开 100 ms 的空定时器；握手 keepAlive: false 照样回复 ready，而空定时器停不掉', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const listeners = new Map<string, (event: { readonly data: unknown }) => void>()
    vi.spyOn(globalThis, 'addEventListener').mockImplementation(((type: string, listener: (event: { readonly data: unknown }) => void) => {
      listeners.set(type, listener)
    }) as typeof globalThis.addEventListener)
    const posted: unknown[] = []
    vi.spyOn(globalThis, 'postMessage').mockImplementation(((message: unknown) => {
      posted.push(message)
    }) as typeof globalThis.postMessage)

    await import('./outbox.worker.ts')
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 100)
    expect([...listeners.keys()].sort()).toEqual(['message', 'messageerror'])

    listeners.get('message')?.({ data: { v: OUTBOX_PROTOCOL_VERSION, id: 1, type: 'hello', keepAlive: false } })
    await vi.waitFor(() => expect(posted).toEqual([{ v: OUTBOX_PROTOCOL_VERSION, id: 1, ok: true, result: { kind: 'ready' } }]))
    expect(clearIntervalSpy, '生产里没有停掉空定时器的办法').not.toHaveBeenCalled()
  })
})

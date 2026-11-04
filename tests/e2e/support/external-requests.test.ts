import type { BrowserContext } from '@playwright/test'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { watchExternalRequests } from './external-requests.ts'

function source() {
  const events = new EventEmitter()
  return {
    context: events as unknown as Pick<BrowserContext, 'on' | 'off'>,
    emit: (url: string) => events.emit('request', { url: () => url }),
    listeners: () => events.listenerCount('request'),
  }
}

describe('整个浏览器上下文的外部请求观察', () => {
  it('同源请求不计入；协议、主机或端口不同都保留，重复请求不去重', () => {
    const input = source()
    const watcher = watchExternalRequests(input.context, 'http://127.0.0.1:3000/documents/one')
    const external = ['https://127.0.0.1:3000/a', 'http://localhost:3000/a', 'http://127.0.0.1:3001/a', 'http://127.0.0.1:3001/a']
    input.emit('http://127.0.0.1:3000/api/assets/one')
    for (const url of external)
      input.emit(url)
    expect(watcher.list()).toEqual(external)
    watcher.stop()
  })

  it('不把 data/blob/about 当 HTTP 请求，也不查询 Worker 未必具备的 frame', () => {
    const input = source()
    const watcher = watchExternalRequests(input.context, 'https://test.invalid')
    for (const url of ['data:image/png;base64,AA==', 'blob:https://test.invalid/one', 'about:blank'])
      input.emit(url)
    input.emit('https://external.invalid/worker')
    expect(watcher.list()).toEqual(['https://external.invalid/worker'])
    watcher.stop()
  })

  it('返回独立快照，停止后不再收集，重复停止不撤其他观察者', () => {
    const input = source()
    const first = watchExternalRequests(input.context, 'https://test.invalid')
    const second = watchExternalRequests(input.context, 'https://test.invalid')
    expect(input.listeners()).toBe(2)
    input.emit('https://external.invalid/one')
    const snapshot = first.list()
    expect(snapshot).not.toBe(first.list())
    first.stop()
    first.stop()
    expect(input.listeners()).toBe(1)
    input.emit('https://external.invalid/two')
    expect(snapshot).toEqual(['https://external.invalid/one'])
    expect(first.list()).toEqual(snapshot)
    expect(second.list()).toEqual(['https://external.invalid/one', 'https://external.invalid/two'])
    second.stop()
    expect(input.listeners()).toBe(0)
  })
})

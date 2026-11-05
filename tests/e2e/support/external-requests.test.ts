import type { Page, WebSocket } from '@playwright/test'
import type { ObservedContext } from './external-requests.ts'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { watchExternalRequests } from './external-requests.ts'

const SITE = 'https://app.test:8443'
type Listener = Parameters<EventEmitter['on']>[1]

/** 只有观察器会用到的上下文与页面接口：事件的注册、撤销与当前页面 */
function fakeContext(pages: EventEmitter[] = []) {
  const events = new EventEmitter()
  const context = {
    on: (name: string, listener: Listener) => events.on(name, listener),
    off: (name: string, listener: Listener) => events.off(name, listener),
    pages: () => pages as unknown as Page[],
  } as unknown as ObservedContext
  const request = (url: string) => events.emit('request', { url: () => url })
  const page = () => {
    const emitter = new EventEmitter()
    events.emit('page', emitter)
    return emitter
  }
  return { context, events, request, page }
}

const socket = (url: string) => ({ url: () => url }) as unknown as WebSocket

describe('M5R-M-15 外部请求观察器', () => {
  it('只记站外的 HTTP(S) 请求，同站与 data/blob 不记', () => {
    const h = fakeContext()
    const watcher = watchExternalRequests(h.context, SITE)
    h.request(`${SITE}/api/documents`)
    h.request('data:image/png;base64,AA==')
    h.request('blob:https://app.test:8443/x')
    h.request('https://app.test/other-port')
    h.request('http://127.0.0.1:9/probe')
    expect(watcher.list()).toEqual(['https://app.test/other-port', 'http://127.0.0.1:9/probe'])
  })

  it('第二个上下文经 watch 加入，同样观察；stop 一起撤下', () => {
    const first = fakeContext()
    const second = fakeContext()
    const watcher = watchExternalRequests(first.context, SITE)
    watcher.watch(second.context)
    second.request('http://127.0.0.1:9/second')
    expect(watcher.list()).toEqual(['http://127.0.0.1:9/second'])
    watcher.stop()
    first.request('http://127.0.0.1:9/after-first')
    second.request('http://127.0.0.1:9/after-second')
    expect(watcher.list()).toEqual(['http://127.0.0.1:9/second'])
    expect(first.events.listenerCount('request') + second.events.listenerCount('request') + first.events.listenerCount('page') + second.events.listenerCount('page')).toBe(0)
  })

  it('WebSocket 握手：已有页面与之后新开的页面都观察，站外的才记；stop 后撤下', () => {
    const existing = new EventEmitter()
    const h = fakeContext([existing])
    const watcher = watchExternalRequests(h.context, SITE)
    existing.emit('websocket', socket('wss://app.test:8443/live'))
    existing.emit('websocket', socket('wss://socket.example.test/feed'))
    const later = h.page()
    later.emit('websocket', socket('ws://127.0.0.1:9/ws'))
    expect(watcher.list()).toEqual(['wss://socket.example.test/feed', 'ws://127.0.0.1:9/ws'])
    watcher.stop()
    expect(existing.listenerCount('websocket') + later.listenerCount('websocket')).toBe(0)
  })
})

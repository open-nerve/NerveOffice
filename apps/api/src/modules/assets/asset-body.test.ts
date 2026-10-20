import type { Request } from 'express'
import { Buffer } from 'node:buffer'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { setImmediate } from 'node:timers/promises'
import { ASSET_MAX_BYTES } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAssetBody } from './asset-body.ts'

const requests: IncomingMessage[] = []
afterEach(() => {
  for (const request of requests.splice(0))
    request.destroy()
  vi.useRealTimers()
})

// 使用 Node 的真实请求流，控制正文分段和 EOF；代理与 HTTP 连接另由部署/集成测试覆盖。
function start(headers: IncomingMessage['headers'] = {}) {
  const request = new IncomingMessage(new Socket())
  request.headers = { 'content-type': 'image/png', 'x-asset-extension': 'png', ...headers }
  requests.push(request)
  const controller = new AbortController()
  let settled = false
  const result = readAssetBody(request as Request, controller.signal).then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  ).then((outcome) => {
    settled = true
    return outcome
  })
  return { request, controller, result, settled: () => settled }
}

describe('图片请求正文的有限读取与拒绝清理', () => {
  it('恰好 5 MiB 的有效声明仍完整交给处理器，后缀规范化', async () => {
    const read = start({ 'content-length': String(ASSET_MAX_BYTES), 'x-asset-extension': 'PNG' })
    const bytes = Buffer.alloc(ASSET_MAX_BYTES, 7)
    read.request.push(bytes)
    read.request.push(null)
    const outcome = await read.result
    if ('error' in outcome)
      throw outcome.error
    const { data, ...metadata } = outcome.value
    expect(metadata).toEqual({ mimeType: 'image/png', extension: 'png' })
    // 原生逐字节比较，避免断言库遍历 5 MiB 的数百万个属性而耗尽测试期限。
    expect(Buffer.from(data).equals(bytes)).toBe(true)
  })

  it.each([
    [{ 'content-length': String(ASSET_MAX_BYTES + 1) }, 'PAYLOAD_TOO_LARGE'],
    [{ 'content-type': 'image/svg+xml' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ 'content-encoding': 'gzip' }, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ 'x-asset-extension': '../private.png' }, 'REQUEST_INVALID'],
    [{ 'content-length': 'invalid' }, 'REQUEST_INVALID'],
  ] as const)('声明已拒绝时先丢弃有限正文，结束之后才回业务错误：%j', async (headers, code) => {
    const read = start(headers)
    read.request.push(Buffer.alloc(512))
    await setImmediate()
    expect(read.settled()).toBe(false)
    read.request.push(Buffer.alloc(512))
    read.request.push(null)
    expect(await read.result).toMatchObject({ error: { code, headers: { Connection: 'close' } } })
  })

  it('分块正文越过 5 MiB 后仍丢弃余下部分，到 EOF 才拒绝', async () => {
    const read = start()
    read.request.push(Buffer.alloc(ASSET_MAX_BYTES))
    read.request.push(Buffer.alloc(1))
    await setImmediate()
    expect(read.settled()).toBe(false)
    read.request.push(Buffer.alloc(512 * 1024))
    read.request.push(null)
    expect(await read.result).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
  })

  it.each([false, true])('拒绝读取的 6 MiB 总预算包含此前前缀，超过即结束连接：已知超限=%s', async (declared) => {
    const read = start(declared ? { 'content-length': String(7 * 1024 * 1024) } : {})
    read.request.push(Buffer.alloc(ASSET_MAX_BYTES))
    read.request.push(Buffer.alloc(1024 * 1024))
    await setImmediate()
    expect(read.settled()).toBe(false)
    read.request.push(Buffer.alloc(1))
    expect(await read.result).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(read.request.destroyed).toBe(true)
    expect(read.request.listenerCount('data')).toBe(0)
  })

  it.each([false, true])('拒绝清理总期限为十秒，持续来字节不重新计时：已知超限=%s', async (declared) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const read = start(declared ? { 'content-length': String(ASSET_MAX_BYTES + 1) } : {})
    read.request.push(Buffer.alloc(declared ? 1 : ASSET_MAX_BYTES + 1))
    await setImmediate()
    await vi.advanceTimersByTimeAsync(9999)
    read.request.push(Buffer.alloc(1))
    await setImmediate()
    expect(read.settled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await read.result).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } })
    expect(read.request.destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正常上传不受拒绝清理期限影响，声明长度仍须相符', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const read = start({ 'content-length': '2' })
    read.request.push(Buffer.from([1]))
    await setImmediate()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(read.settled()).toBe(false)
    read.request.push(null)
    expect(await read.result).toMatchObject({ error: { code: 'REQUEST_INVALID' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['abort', 'disconnect', 'error', 'end'] as const)('拒绝状态仍响应 %s，清掉监听和定时器', async (action) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const read = start({ 'content-length': String(ASSET_MAX_BYTES + 1) })
    read.request.push(Buffer.alloc(1))
    await setImmediate()
    expect(read.settled()).toBe(false)
    if (action === 'abort')
      read.controller.abort('private reason')
    else if (action === 'disconnect')
      read.request.destroy()
    else if (action === 'error')
      read.request.emit('error', new Error('private fragment'))
    else
      read.request.push(null)
    expect(await read.result).toMatchObject({
      error: action === 'abort' || action === 'disconnect'
        ? { name: 'AbortError', message: '图片请求已取消' }
        : { code: action === 'end' ? 'PAYLOAD_TOO_LARGE' : 'REQUEST_INVALID' },
    })
    expect(read.request.listenerCount('data')).toBe(0)
    expect(read.request.listenerCount('aborted')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

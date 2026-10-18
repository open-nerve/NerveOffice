import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import { ASSET_MAX_BYTES } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkError, ResponseFormatError, setCsrfToken } from '../api/client.ts'
import { apiError, installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { AssetInputError, AssetReadError, readAsset, uploadAsset } from './asset-api.ts'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SOURCE = `/api/assets/${ID}`
const DATA = new Uint8Array([1, 2, 3])
const UPLOADED = { assetId: ID, url: SOURCE, mimeType: 'image/png', width: 2, height: 3, bytes: 27 }

function imageResponse(data: Uint8Array<ArrayBuffer> = DATA, headers: Record<string, string> = {}): Response {
  return new Response(data, { headers: { 'content-type': 'image/png', 'x-asset-status': '200', ...headers } })
}

afterEach(() => {
  setCsrfToken(undefined)
  vi.restoreAllMocks()
})

describe('图片上传字节客户端', () => {
  it.each<[AssetMimeType, AssetExtension]>([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/jpeg', 'jpeg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ])('%s / %s 只发送原字节、类型、后缀与 CSRF，校验返回契约', async (mimeType, extension) => {
    let init: RequestInit | undefined
    const api = installFakeApi({ 'POST /api/assets': (options) => {
      init = options
      return json(201, UPLOADED)
    } })
    setCsrfToken('controlled-csrf')
    await expect(uploadAsset({ data: DATA, mimeType, extension })).resolves.toEqual(UPLOADED)
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.headers).toEqual({ 'accept': 'application/json', 'content-type': mimeType, 'x-asset-extension': extension, 'x-csrf-token': 'controlled-csrf' })
    expect(init?.body).toEqual(DATA)
    expect(init?.credentials).toBe('same-origin')
    expect(init?.redirect).toBe('error')
  })

  it.each([1, ASSET_MAX_BYTES])('接受 %s 字节，响应尺寸使用处理后的契约', async (size) => {
    installFakeApi({ 'POST /api/assets': () => json(201, UPLOADED) })
    await expect(uploadAsset({ data: new Uint8Array(size), mimeType: 'image/png', extension: 'png' })).resolves.toEqual(UPLOADED)
  })

  it.each([0, ASSET_MAX_BYTES + 1])('拒绝 %s 字节，不发请求', async (size) => {
    const api = installFakeApi()
    await expect(uploadAsset({ data: new Uint8Array(size), mimeType: 'image/png', extension: 'png' })).rejects.toMatchObject({ name: 'AssetInputError', reason: 'size' })
    expect(api.requests).toHaveLength(0)
  })

  it.each([
    ['image/png', 'gif'],
    ['image/jpeg', 'png'],
    ['image/gif', 'jpg'],
    ['image/webp', 'jpeg'],
    ['image/svg+xml', 'png'],
    ['image/png', '../png'],
    ['', 'png'],
  ])('拒绝类型/后缀 %s / %s，不发请求', async (mimeType, extension) => {
    const api = installFakeApi()
    await expect(uploadAsset({ data: DATA, mimeType: mimeType as AssetMimeType, extension: extension as AssetExtension })).rejects.toMatchObject({ name: 'AssetInputError', reason: 'type' })
    expect(api.requests).toHaveLength(0)
  })

  it.each([
    { url: 'https://outside.invalid/image.png' },
    { assetId: ID.toUpperCase() },
    { width: 0 },
    { height: 8193 },
    { width: 8192, height: 8192 },
    { bytes: ASSET_MAX_BYTES + 1 },
    { mimeType: 'image/svg+xml' },
  ])('服务端成功但响应不自洽时拒绝，不重试：%j', async (change) => {
    const api = installFakeApi({ 'POST /api/assets': () => json(201, { ...UPLOADED, ...change }) })
    await expect(uploadAsset({ data: DATA, mimeType: 'image/png', extension: 'png' })).rejects.toBeInstanceOf(ResponseFormatError)
    expect(api.requests).toHaveLength(1)
  })

  it.each([[401, 'UNAUTHENTICATED'], [413, 'ASSET_TOO_LARGE'], [415, 'ASSET_UNSUPPORTED_TYPE'], [503, 'ASSET_BUSY']] as const)('HTTP %s 的原错误与退避头保留，不自动重发上传', async (status, code) => {
    const api = installFakeApi({ 'POST /api/assets': () => apiError(status, code, '受控错误', { 'retry-after': '10' }) })
    await expect(uploadAsset({ data: DATA, mimeType: 'image/png', extension: 'png' })).rejects.toMatchObject({ name: 'ApiError', status, code, retryAfterSeconds: 10 })
    expect(api.requests).toHaveLength(1)
  })
})

describe('图片读取字节客户端', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const)('%s 明确重新请求，消费完整字节并保留媒体类型', async (mimeType) => {
    let init: RequestInit | undefined
    const api = installFakeApi({ [`GET ${SOURCE}`]: (options) => {
      init = options
      return imageResponse(DATA, { 'content-type': mimeType })
    } })
    await expect(readAsset(SOURCE)).resolves.toEqual({ data: DATA, mimeType })
    expect(api.requests).toHaveLength(1)
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    expect(new Headers(init?.headers).get('accept')).toBe('image/png, image/jpeg, image/webp, image/gif')
  })

  it('连续读取同一地址确实发两次请求，不用内存字节冒充重读', async () => {
    let counter = 0
    const api = installFakeApi({ [`GET ${SOURCE}`]: () => imageResponse(new Uint8Array([++counter])) })
    expect((await readAsset(SOURCE)).data).toEqual(new Uint8Array([1]))
    expect((await readAsset(SOURCE)).data).toEqual(new Uint8Array([2]))
    expect(api.requests).toHaveLength(2)
  })

  it.each([
    `https://outside.invalid${SOURCE}`,
    `https://docs.example.com${SOURCE}`,
    `//outside.invalid${SOURCE}`,
    `${SOURCE}?token=private`,
    `${SOURCE}#private`,
    SOURCE.toUpperCase(),
    `${SOURCE}/`,
    'data:image/png;base64,AQID',
    'blob:controlled',
    '/api/assets/not-an-id',
  ])('非规范相对地址不发请求且错误不回显输入：%s', async (source) => {
    const api = installFakeApi()
    const error: unknown = await readAsset(source).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AssetInputError)
    expect(error).toMatchObject({ reason: 'address' })
    expect(String(error)).not.toContain(source)
    expect(api.requests).toHaveLength(0)
  })

  it.each([404, 500, 503] as const)('HTTP 200 / X-Asset-Status %s 拒绝占位，取消其正文并保留重试提示', async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(DATA) },
      cancel,
    })
    const api = installFakeApi({ [`GET ${SOURCE}`]: () => new Response(body, { headers: { 'content-type': 'image/png', 'x-asset-status': String(status), 'retry-after': '10' } }) })
    const error: unknown = await readAsset(SOURCE).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AssetReadError)
    expect(error).toMatchObject({ status, retryAfterSeconds: 10 })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(api.requests).toHaveLength(1)
  })

  it.each([undefined, '', '201', '401', '0200', 'unknown'])('状态头 %s 不冒充真实图片，取消正文', async (status) => {
    const cancel = vi.fn()
    const headers = new Headers({ 'content-type': 'image/png' })
    if (status !== undefined)
      headers.set('x-asset-status', status)
    installFakeApi({ [`GET ${SOURCE}`]: () => new Response(new ReadableStream({ cancel }), { headers }) })
    await expect(readAsset(SOURCE)).rejects.toBeInstanceOf(ResponseFormatError)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['text/html', 'image/svg+xml', '', 'application/octet-stream'])('未知媒体类型 %s 不被交给解码器', async (mimeType) => {
    installFakeApi({ [`GET ${SOURCE}`]: () => imageResponse(DATA, { 'content-type': mimeType }) })
    await expect(readAsset(SOURCE)).rejects.toBeInstanceOf(ResponseFormatError)
  })

  it.each([201, 206])('HTTP %s 即使带成功资源头，也不当作完整图片响应', async (status) => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(DATA)
        controller.close()
      },
      cancel,
    })
    installFakeApi({ [`GET ${SOURCE}`]: () => new Response(body, { status, headers: { 'content-type': 'image/png', 'x-asset-status': '200' } }) })
    await expect(readAsset(SOURCE)).rejects.toBeInstanceOf(ResponseFormatError)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([null, new Uint8Array()])('空响应拒绝，不返回空图片', async (data) => {
    installFakeApi({ [`GET ${SOURCE}`]: () => new Response(data, { headers: { 'content-type': 'image/png', 'x-asset-status': '200' } }) })
    await expect(readAsset(SOURCE)).rejects.toBeInstanceOf(ResponseFormatError)
  })

  it('完整 5 MiB 流按顺序拼接，不因边界恰好相等拒绝', async () => {
    const data = new Uint8Array(ASSET_MAX_BYTES)
    data[0] = 17
    data[ASSET_MAX_BYTES - 1] = 29
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(data.slice(0, 123))
        controller.enqueue(data.slice(123))
        controller.close()
      },
    })
    const response = new Response(body, { headers: { 'content-type': 'image/png', 'x-asset-status': '200' } })
    installFakeApi({ [`GET ${SOURCE}`]: () => response })
    expect((await readAsset(SOURCE)).data).toEqual(data)
  })

  it('流在下次拉取时复用小缓冲，不会改写已经收到的字节', async () => {
    const chunk = new Uint8Array(1)
    let next = 1
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === 4) {
          controller.close()
          return
        }
        chunk[0] = next++
        controller.enqueue(chunk)
      },
    }, { highWaterMark: 0 })
    installFakeApi({ [`GET ${SOURCE}`]: () => new Response(body, { headers: { 'content-type': 'image/png', 'x-asset-status': '200' } }) })
    expect((await readAsset(SOURCE)).data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it.each([undefined, '1'])('无长度或谎报长度 %s：实际超 5 MiB 时立即取消，不读完剩余流', async (length) => {
    let pulls = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
      cancel,
    })
    const headers: Record<string, string> = { 'content-type': 'image/png', 'x-asset-status': '200' }
    if (length !== undefined)
      headers['content-length'] = length
    installFakeApi({ [`GET ${SOURCE}`]: () => new Response(body, { headers }) })
    await expect(readAsset(SOURCE)).rejects.toBeInstanceOf(ResponseFormatError)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pulls).toBeLessThanOrEqual(7)
  })

  it('收到部分字节之后网络断流，交回 NetworkError，不返回截断字节', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0)
          controller.enqueue(DATA)
        else
          controller.error(new TypeError('controlled disconnect'))
      },
    })
    installFakeApi({ [`GET ${SOURCE}`]: () => new Response(body, { headers: { 'content-type': 'image/png', 'x-asset-status': '200' } }) })
    await expect(readAsset(SOURCE)).rejects.toBeInstanceOf(NetworkError)
  })
})

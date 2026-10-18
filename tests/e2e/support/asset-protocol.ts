// 图片公开协议的真实上传、主动重读与浏览器解码；不代替 P2 的 SDK 图片入口验收。
import type { Page, Response } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { acquiredEditLeaseSchema, assetUploadResponseSchema, EDIT_LEASE_HEADER, saveContentResponseSchema } from '@nerve-office/contracts'
import { clientFormatQuery, CURRENT_CLIENT } from './client-format.ts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'

/** 新建文档经真实租约/保存协议建立图片引用；不直接布置 document_asset_links。 */
export async function saveAssetSnapshot(page: Page, documentId: string, raw: string): Promise<void> {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const common = { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken }
  const clientInstanceId = randomUUID()
  const leasePath = `/api/documents/${documentId}/edit-lease`
  const response = await page.request.post(leasePath, { headers: common, data: { clientInstanceId, ...CURRENT_CLIENT } })
  expect(response.status(), await response.text()).toBe(201)
  const lease = acquiredEditLeaseSchema.parse(await response.json())
  const authorized = { ...common, [EDIT_LEASE_HEADER]: lease.token }
  try {
    const query = new URLSearchParams({ ...clientFormatQuery(), clientInstanceId, writeEpoch: String(lease.writeEpoch), baseRevision: '1', requestId: randomUUID(), localSeq: '1' })
    const saved = await page.request.put(`/api/documents/${documentId}/content?${query.toString()}`, { headers: { ...authorized, 'content-type': 'application/gzip' }, data: gzipSync(Buffer.from(raw)) })
    expect(saved.status(), await saved.text()).toBe(200)
    expect(saveContentResponseSchema.parse(await saved.json())).toMatchObject({ revision: 2, unchanged: false })
  }
  finally {
    expect((await page.request.delete(leasePath, { headers: authorized })).status()).toBe(204)
  }
}

export async function uploadAsset(page: Page, file = 'rgba-text.png', mime = 'image/png', extension = 'png') {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const bytes = await readFile(new URL(`../../../apps/api/src/modules/assets/testdata/${file}`, import.meta.url))
  const response = await page.request.post('/api/assets', { data: bytes, headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, 'content-type': mime, 'X-Asset-Extension': extension } })
  expect(response.status(), await response.text()).toBe(201)
  return assetUploadResponseSchema.parse(await response.json())
}

/**
 * 首次可直接加载 img；主动重读用真实 fetch(no-store) 再解码该次返回的 blob。
 * HTML 的 available-images 会复用同页已经解码的图片，即使响应为 no-store；重新给 img 相同 src 不等于重新请求。
 * 这是服务协议测试辅助，不是 P2 的 SDK 接线；后者仍需验证权限变化时主动复核和旧图清理。
 */
export async function renderAsset(page: Page, path: string, direct = false): Promise<{ response: Response, width: number, height: number, body: Buffer }> {
  const [response, size] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET'),
    page.evaluate(async ({ source, direct }) => {
      const image = new Image()
      let objectUrl: string | undefined
      let data: number[] | undefined
      image.alt = '图片读取协议验证'
      try {
        if (direct) {
          image.src = source
        }
        else {
          const response = await fetch(source, { cache: 'no-store', credentials: 'same-origin' })
          if (response.status !== 200 || !['200', '404', '500', '503'].includes(response.headers.get('x-asset-status') ?? ''))
            throw new Error('图片读取响应不符合协议')
          const blob = await response.blob()
          data = Array.from(new Uint8Array(await blob.arrayBuffer()))
          objectUrl = URL.createObjectURL(blob)
          image.src = objectUrl
        }
        document.body.append(image)
        await image.decode()
        return { width: image.naturalWidth, height: image.naturalHeight, data }
      }
      finally {
        image.remove()
        if (objectUrl !== undefined)
          URL.revokeObjectURL(objectUrl)
      }
    }, { source: path, direct }),
  ])
  // Chromium 的自动化网络接口在 img→fetch 同 URL 的场景可能交出空正文；主动读取直接核对页面取得并解码的那份字节。
  return { response, width: size.width, height: size.height, body: size.data === undefined ? await response.body() : Buffer.from(size.data) }
}

export async function expectAssetHeaders(response: Response, status: 200 | 404, mime: string): Promise<void> {
  expect(response.status()).toBe(200)
  const headers = await response.allHeaders()
  expect(headers['x-asset-status']).toBe(String(status))
  expect(headers['content-type']).toBe(mime)
  expect(headers['cache-control']).toBe(status === 200 ? 'private, no-store' : 'no-store')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers.etag).toBeUndefined()
  expect(headers['last-modified']).toBeUndefined()
  expect(headers['content-range']).toBeUndefined()
}

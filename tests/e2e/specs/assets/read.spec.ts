// M5-P1 的图片服务协议：真实上传、鉴权读取、浏览器解码与撤权后重读；不开放编辑器图片入口。
import type { Page, Response } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assetUploadResponseSchema } from '@nerve-office/contracts'
import { createDocument, createUser, withDatabase } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'

test.describe.configure({ timeout: 90_000 })

async function upload(page: Page, file = 'rgba-text.png', mime = 'image/png', extension = 'png') {
  const { csrfToken } = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string }
  const bytes = await readFile(new URL(`../../../../apps/api/src/modules/assets/testdata/${file}`, import.meta.url))
  const response = await page.request.post('/api/assets', { data: bytes, headers: { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken, 'content-type': mime, 'X-Asset-Extension': extension } })
  expect(response.status(), await response.text()).toBe(201)
  return assetUploadResponseSchema.parse(await response.json())
}

/**
 * 首次可直接加载 img；主动重读用真实 fetch(no-store) 再解码该次返回的 blob。
 * HTML 的 available-images 会复用同页已经解码的图片，即使响应为 no-store；重新给 img 相同 src 不等于重新请求。
 * 这是服务协议测试辅助，不是 P2 的 SDK 接线；后者仍需验证权限变化时主动复核和旧图清理。
 */
async function render(page: Page, path: string, direct = false): Promise<{ response: Response, width: number, height: number, body: Buffer }> {
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

async function expectHeaders(response: Response, status: 200 | 404, mime: string): Promise<void> {
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

test('四格式真实上传后直接显示；主动重读同一地址经过服务端并解码本次响应', async ({ page }) => {
  await loginThroughApi(page, await createUser('asset-formats'))
  await page.goto('/')
  for (const [file, mime, extension] of [
    ['minimum.png', 'image/png', 'png'],
    ['orientation.jpg', 'image/jpeg', 'jpg'],
    ['animated.webp', 'image/webp', 'webp'],
    ['zero-delay-gif.gif', 'image/gif', 'gif'],
  ]) {
    const uploaded = await upload(page, file, mime, extension)
    const first = await render(page, uploaded.url, true)
    await expectHeaders(first.response, 200, uploaded.mimeType)
    expect({ width: first.width, height: first.height }).toEqual({ width: uploaded.width, height: uploaded.height })
    expect(first.body).toHaveLength(uploaded.bytes)
    const second = await render(page, uploaded.url)
    await expectHeaders(second.response, 200, uploaded.mimeType)
    expect(second.body).toEqual(first.body)
    expect(await second.response.headerValue('x-request-id')).not.toBe(await first.response.headerValue('x-request-id'))
  }
})

test('有当前引用才可读；撤销分享后同一地址重读变为可解码占位，未知资源完全相同', async ({ page, anotherDevice }) => {
  const owner = await createUser('asset-owner')
  const viewer = await createUser('asset-viewer')
  await loginThroughApi(anotherDevice, owner)
  await loginThroughApi(page, viewer)
  await page.goto('/')
  const asset = await upload(anotherDevice)
  const documentId = await createDocument(owner, '图片读取当前来源')
  // S4 只测试读取；引用的正式保存接线在 S5，前置关系通过隔离测试库布置。
  await withDatabase(async (client) => {
    await client.query('UPDATE assets SET created_at = now() - interval \'25 hours\' WHERE id = $1', [asset.assetId])
    await client.query('INSERT INTO document_asset_links (document_id, asset_id) VALUES ($1,$2)', [documentId, asset.assetId])
  })
  const denied = await render(page, asset.url)
  await expectHeaders(denied.response, 404, 'image/png')
  expect({ width: denied.width, height: denied.height }).toEqual({ width: 24, height: 24 })
  await actAs(anotherDevice, 'PUT', `/api/documents/${documentId}/grants/${viewer.id}`, { role: 'viewer' })
  const allowed = await render(page, asset.url)
  await expectHeaders(allowed.response, 200, asset.mimeType)
  expect({ width: allowed.width, height: allowed.height }).toEqual({ width: asset.width, height: asset.height })
  await actAs(anotherDevice, 'DELETE', `/api/documents/${documentId}/grants/${viewer.id}`)
  const revoked = await render(page, asset.url)
  await expectHeaders(revoked.response, 404, 'image/png')
  expect({ width: revoked.width, height: revoked.height }).toEqual({ width: 24, height: 24 })
  const unknown = await render(page, `/api/assets/${randomUUID()}`)
  await expectHeaders(unknown.response, 404, 'image/png')
  expect(revoked.body).toEqual(unknown.body)
  expect(revoked.body).toEqual(denied.body)
  expect(await revoked.response.headerValue('x-request-id')).not.toBe(await allowed.response.headerValue('x-request-id'))
})

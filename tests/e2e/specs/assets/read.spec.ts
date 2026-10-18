// M5-P1 的图片服务协议：真实上传、鉴权读取、浏览器解码与撤权后重读；不开放编辑器图片入口。
import { randomUUID } from 'node:crypto'
import { expectAssetHeaders, renderAsset, uploadAsset } from '../../support/asset-protocol.ts'
import { createDocument, createUser, withDatabase } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'

test.describe.configure({ timeout: 90_000 })

test('四格式真实上传后直接显示；主动重读同一地址经过服务端并解码本次响应', async ({ page }) => {
  await loginThroughApi(page, await createUser('asset-formats'))
  await page.goto('/')
  for (const [file, mime, extension] of [
    ['minimum.png', 'image/png', 'png'],
    ['orientation.jpg', 'image/jpeg', 'jpg'],
    ['animated.webp', 'image/webp', 'webp'],
    ['zero-delay-gif.gif', 'image/gif', 'gif'],
  ]) {
    const uploaded = await uploadAsset(page, file, mime, extension)
    const first = await renderAsset(page, uploaded.url, true)
    await expectAssetHeaders(first.response, 200, uploaded.mimeType)
    expect({ width: first.width, height: first.height }).toEqual({ width: uploaded.width, height: uploaded.height })
    expect(first.body).toHaveLength(uploaded.bytes)
    const second = await renderAsset(page, uploaded.url)
    await expectAssetHeaders(second.response, 200, uploaded.mimeType)
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
  const asset = await uploadAsset(anotherDevice)
  const documentId = await createDocument(owner, '图片读取当前来源')
  // S4 只测试读取；引用的正式保存接线在 S5，前置关系通过隔离测试库布置。
  await withDatabase(async (client) => {
    await client.query('UPDATE assets SET created_at = now() - interval \'25 hours\' WHERE id = $1', [asset.assetId])
    await client.query('INSERT INTO document_asset_links (document_id, asset_id) VALUES ($1,$2)', [documentId, asset.assetId])
  })
  const denied = await renderAsset(page, asset.url)
  await expectAssetHeaders(denied.response, 404, 'image/png')
  expect({ width: denied.width, height: denied.height }).toEqual({ width: 24, height: 24 })
  await actAs(anotherDevice, 'PUT', `/api/documents/${documentId}/grants/${viewer.id}`, { role: 'viewer' })
  const allowed = await renderAsset(page, asset.url)
  await expectAssetHeaders(allowed.response, 200, asset.mimeType)
  expect({ width: allowed.width, height: allowed.height }).toEqual({ width: asset.width, height: asset.height })
  await actAs(anotherDevice, 'DELETE', `/api/documents/${documentId}/grants/${viewer.id}`)
  const revoked = await renderAsset(page, asset.url)
  await expectAssetHeaders(revoked.response, 404, 'image/png')
  expect({ width: revoked.width, height: revoked.height }).toEqual({ width: 24, height: 24 })
  const unknown = await renderAsset(page, `/api/assets/${randomUUID()}`)
  await expectAssetHeaders(unknown.response, 404, 'image/png')
  expect(revoked.body).toEqual(unknown.body)
  expect(revoked.body).toEqual(denied.body)
  expect(await revoked.response.headerValue('x-request-id')).not.toBe(await allowed.response.headerValue('x-request-id'))
})

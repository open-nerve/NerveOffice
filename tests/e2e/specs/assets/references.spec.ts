// P1 验证正式 HTTP 协议与浏览器解码；图片编辑入口、原生剪贴板和 SDK 缓存清理仍由 P2 验收。
import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createdDocumentSchema, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { expectAssetHeaders, renderAsset, saveAssetSnapshot, uploadAsset } from '../../support/asset-protocol.ts'
import { clientFormatQuery } from '../../support/client-format.ts'
import { createUser, withDatabase } from '../../support/database.ts'
import { e2eOrigin } from '../../support/environment.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, savedContent } from '../../support/sheet.ts'

test.describe.configure({ timeout: 90_000 })

async function headers(page: Page): Promise<Record<string, string>> {
  const session = await page.request.get('/api/auth/session')
  expect(session.status()).toBe(200)
  const { csrfToken } = await session.json() as { csrfToken: string }
  return { 'origin': e2eOrigin(), 'x-csrf-token': csrfToken }
}
function snapshot(unitId: string, urls: readonly string[], marker: string): string {
  return JSON.stringify({ ...SHEET_TEMPLATE, id: unitId, extra: { urls, marker } })
}
async function prepareCopy(page: Page, kind: '普通复制' | '本机副本', source: string, spaceId: string, original: string, draft: string) {
  const common = await headers(page)
  const requestId = randomUUID()
  const text = kind === '普通复制' ? original : draft
  const query = new URLSearchParams({ ...clientFormatQuery(), requestId, title: '图片引用本机副本' })
  const send = async () => kind === '普通复制'
    ? page.request.post(`/api/documents/${source}/copy`, { headers: common, data: { requestId, spaceId } })
    : page.request.post(`/api/documents/${source}/conflict-copies?${query.toString()}`, { headers: { ...common, 'content-type': 'application/gzip' }, data: gzipSync(Buffer.from(text)) })
  return { text, send }
}

for (const kind of ['普通复制', '本机副本'] as const) {
  test(`US-M5-07 ${kind}：上传与保存建立当前引用，撤销原文档分享后副本仍可读，未知地址始终为占位`, async ({ page, anotherDevice }) => {
    const owner = await createUser('asset-reference-owner')
    const copier = await createUser('asset-reference-copy')
    await loginThroughApi(anotherDevice, owner)
    await loginThroughApi(page, copier)
    await page.goto('/')
    const image = await uploadAsset(anotherDevice)
    const source = await createSheetThroughApi(anotherDevice, '图片引用原文档')
    const unitId = (await savedContent(anotherDevice, source)).snapshot.id
    const unknown = `/api/assets/${randomUUID()}`
    const sourceText = snapshot(unitId, [image.url, unknown], '原文档内容')
    await saveAssetSnapshot(anotherDevice, source, sourceText)
    // 只推进上传时间，不布置或修改图片关系；关系必须由正式保存/复制事务生成。
    await withDatabase(async client => client.query('UPDATE assets SET created_at=now()-interval \'25 hours\' WHERE id=$1', [image.assetId]))
    const denied = await renderAsset(page, image.url)
    await expectAssetHeaders(denied.response, 404, 'image/png')
    await actAs(anotherDevice, 'PUT', `/api/documents/${source}/grants/${copier.id}`, { role: 'viewer' })
    const before = await renderAsset(page, image.url)
    await expectAssetHeaders(before.response, 200, image.mimeType)
    expect({ width: before.width, height: before.height }).toEqual({ width: image.width, height: image.height })
    const copy = await prepareCopy(page, kind, source, copier.personalSpaceId, sourceText, snapshot(unitId, [unknown, image.url], '本机尚未保存的内容'))
    const copied = await copy.send()
    expect(copied.status(), await copied.text()).toBe(201)
    const document = createdDocumentSchema.parse(await copied.json())
    expect(document).toMatchObject({ spaceId: copier.personalSpaceId, replayed: false })
    expect((await savedContent(page, document.id)).text).toBe(copy.text)
    await actAs(anotherDevice, 'DELETE', `/api/documents/${source}/grants/${copier.id}`)
    expect((await page.request.get(`/api/documents/${source}`)).status()).toBe(404)
    const independent = await renderAsset(page, image.url)
    await expectAssetHeaders(independent.response, 200, image.mimeType)
    expect(independent.body).toEqual(before.body)
    const missing = await renderAsset(page, unknown)
    await expectAssetHeaders(missing.response, 404, 'image/png')
    expect(missing.body).toEqual(denied.body)
    const replayed = await copy.send()
    expect(replayed.status(), await replayed.text()).toBe(201)
    expect(createdDocumentSchema.parse(await replayed.json())).toMatchObject({ id: document.id, replayed: true })
    await actAs(page, 'DELETE', `/api/documents/${document.id}`)
    const removed = await renderAsset(page, image.url)
    await expectAssetHeaders(removed.response, 404, 'image/png')
    expect(removed.body).toEqual(missing.body)
    expect({ width: removed.width, height: removed.height }).toEqual({ width: 24, height: 24 })
  })
}

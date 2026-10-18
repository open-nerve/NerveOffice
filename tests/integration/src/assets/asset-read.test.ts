import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AssetReadService } from '@nerve-office/api/testing'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { testAssetRoot } from '../support/asset-root.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { removeGrant, setGrant } from '../support/grants.ts'
import { whileHolding } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace, setSpaceState } from '../support/spaces.ts'

interface Client { readonly account: TestAccount, readonly session: LoggedIn }
let database: TestDatabase
let app: TestApp
let owner: Client
let reader: Client
let outsider: Client
let administrator: Client
let member: Client
let placeholder: Buffer | undefined

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_DATABASE_STATEMENT_TIMEOUT_MS: '500' } })
  const client = async (username: string, systemRole: 'member' | 'admin' = 'member'): Promise<Client> => {
    const account = await createAccount(database, { username, systemRole })
    return { account, session: await login(app.baseUrl, username, account.password) }
  }
  owner = await client('image-read-owner')
  reader = await client('image-read-viewer')
  outsider = await client('image-read-outsider')
  administrator = await client('image-read-admin', 'admin')
  member = await client('image-read-member')
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  expect(app.logs.text()).not.toContain(testAssetRoot(database.url))
  await database?.drop()
})

async function upload(client = owner, file = 'minimum.png', mime = 'image/png', extension = 'png') {
  return uploadTestAsset(app.baseUrl, client.session, file, mime, extension)
}
async function get(id: string, client = owner, headers: Record<string, string> = {}, method = 'GET') {
  return asUser(app.baseUrl, client.session, `/api/assets/${id}`, { method, headers })
}
async function expectImage(response: Response, status = 200, mime = 'image/png'): Promise<Buffer> {
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Asset-Status')).toBe(String(status))
  expect(response.headers.get('content-type')).toBe(mime)
  expect(response.headers.get('cache-control')).toBe(status === 200 ? 'private, no-store' : 'no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  expect(response.headers.get('etag')).toBeNull()
  expect(response.headers.get('last-modified')).toBeNull()
  const data = Buffer.from(await response.arrayBuffer())
  expect(response.headers.get('content-length')).toBe(String(data.length))
  if (status !== 200) {
    expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    if (placeholder === undefined)
      placeholder = data
    else
      expect(data).toEqual(placeholder)
  }
  return data
}
async function expire(id: string): Promise<void> {
  await database.query(async client => client.query('UPDATE assets SET created_at = now() - interval \'25 hours\' WHERE id = $1', [id]))
}
async function link(id: string, spaceId = owner.account.personalSpaceId): Promise<string> {
  const document = await seedDocument(database, { spaceId, createdBy: owner.account.id, title: '当前图片引用' })
  await database.query(async client => client.query('INSERT INTO document_asset_links (document_id, asset_id) VALUES ($1,$2)', [document.id, id]))
  return document.id
}
async function objectOf(id: string): Promise<{ sha256: string, storage_key: string }> {
  return database.query(async client => (await client.query<{ sha256: string, storage_key: string }>('SELECT o.sha256, o.storage_key FROM assets a JOIN asset_objects o ON o.sha256 = a.object_hash WHERE a.id = $1', [id])).rows[0]!)
}

describe('图片读取的身份、当前引用与输出契约', () => {
  it('无会话仍是既有 401 JSON，已登录的未知/非规范 ID 是同一 404 占位', async () => {
    const anonymous = await fetch(`${app.baseUrl}/api/assets/${randomUUID()}`)
    expect(anonymous.status).toBe(401)
    expect(errorResponseSchema.parse(await anonymous.json()).error.code).toBe('UNAUTHENTICATED')
    for (const id of [randomUUID(), 'not-an-id', randomUUID().toUpperCase()])
      await expectImage(await get(id), 404)
  })

  it.each([
    ['minimum.png', 'image/png', 'png'],
    ['orientation.jpg', 'image/jpeg', 'jpg'],
    ['animated.webp', 'image/webp', 'webp'],
    ['zero-delay-gif.gif', 'image/gif', 'gif'],
  ])('本人窗口内读取 %s，完整字节与已上传对象一致', async (file, mime, extension) => {
    const uploaded = await upload(owner, file, mime, extension)
    const bytes = await expectImage(await get(uploaded.assetId), 200, mime)
    expect(bytes.length).toBe(uploaded.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe((await objectOf(uploaded.assetId)).sha256)
  })

  it('同图不同上传记录不合并身份；陌生人和没有内容权限的系统管理员均无权', async () => {
    const first = await upload()
    const second = await upload(outsider)
    await expectImage(await get(first.assetId, outsider), 404)
    await expectImage(await get(first.assetId, administrator), 404)
    await expectImage(await get(second.assetId, outsider))
    await expire(first.assetId)
    await expectImage(await get(first.assetId), 404)
    await expectImage(await get(second.assetId, outsider))
  })

  it('窗口外本人通过个人空间当前引用读取，单独分享允许读；撤销后恢复占位', async () => {
    const uploaded = await upload()
    await expire(uploaded.assetId)
    const documentId = await link(uploaded.assetId)
    await expectImage(await get(uploaded.assetId))
    await expectImage(await get(uploaded.assetId, reader), 404)
    await setGrant(database, { documentId, userId: reader.account.id, role: 'viewer', grantedBy: owner.account.id })
    await expectImage(await get(uploaded.assetId, reader))
    await removeGrant(database, documentId, reader.account.id)
    await expectImage(await get(uploaded.assetId, reader), 404)
    expect((await asUser(app.baseUrl, owner.session, `/api/documents/${documentId}`, { method: 'DELETE' })).status).toBe(204)
    await expectImage(await get(uploaded.assetId), 404)
  })

  it('团队成员、全员可见和归档复用现有内容权限；系统管理员不会自动获得读取权', async () => {
    const uploaded = await upload()
    await expire(uploaded.assetId)
    const team = await createTeamSpace(database, { name: '图片读取测试团队', createdBy: administrator.account.id, members: { [owner.account.id]: 'admin', [member.account.id]: 'viewer' } })
    await link(uploaded.assetId, team)
    await expectImage(await get(uploaded.assetId, member))
    await expectImage(await get(uploaded.assetId, outsider), 404)
    await expectImage(await get(uploaded.assetId, administrator), 404)
    await setSpaceState(database, team, { visibleToAll: true, status: 'archived' })
    await expectImage(await get(uploaded.assetId, outsider))
    await expectImage(await get(uploaded.assetId, member))
    await setSpaceState(database, team, { visibleToAll: false })
    await expectImage(await get(uploaded.assetId, outsider), 404)
  })

  it('HEAD、范围及条件请求仍重新鉴权，不产生 206/304 或可复用的响应', async () => {
    const uploaded = await upload()
    const conditions: Record<string, string>[] = [{ Range: 'bytes=0-3' }, { 'If-None-Match': '*' }, { 'If-Modified-Since': 'Fri, 01 Jan 2999 00:00:00 GMT' }]
    for (const headers of conditions) {
      const response = await get(uploaded.assetId, owner, headers)
      expect(response.headers.get('content-range')).toBeNull()
      expect((await expectImage(response)).length).toBe(uploaded.bytes)
    }
    const head = await get(uploaded.assetId, owner, {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.headers.get('X-Asset-Status')).toBe('200')
    expect(head.headers.get('content-length')).toBe(String(uploaded.bytes))
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    await expire(uploaded.assetId)
    await expectImage(await get(uploaded.assetId, owner, { 'If-None-Match': '*' }), 404)
    const refused = await get(uploaded.assetId, owner, {}, 'HEAD')
    expect(refused.headers.get('X-Asset-Status')).toBe('404')
    expect((await refused.arrayBuffer()).byteLength).toBe(0)
  })

  it('文件丢失/损坏对有权者是 500 占位，无权者不探测文件，响应和日志没有私有详情', async () => {
    const uploaded = await upload(owner, 'rgba-text.png')
    const object = await objectOf(uploaded.assetId)
    const path = join(testAssetRoot(database.url), object.storage_key)
    const original = await readFile(path)
    await rename(path, `${path}.held`)
    try {
      await expectImage(await get(uploaded.assetId), 500)
      await expectImage(await get(uploaded.assetId, outsider), 404)
    }
    finally {
      await rename(`${path}.held`, path)
    }
    try {
      await writeFile(path, 'invalid image')
      await expectImage(await get(uploaded.assetId), 500)
    }
    finally {
      await writeFile(path, original)
    }
    const injected = vi.spyOn(app.runtime.get(AssetReadService), 'readAuthorized').mockRejectedValueOnce(new Error(`private-diagnostic ${path} ${object.sha256}`))
    await expectImage(await get(uploaded.assetId), 500)
    injected.mockRestore()
    expect(app.logs.text()).not.toContain(object.sha256)
    expect(app.logs.text()).not.toContain('private-diagnostic')
    expect(app.logs.entries()).toContainEqual(expect.objectContaining({ level: 'error', code: 'ASSET_READ_FAILED' }))
    await expectImage(await get(uploaded.assetId))
  })

  it('无权、未知及非规范 ID 均不会调用文件读取，正常授权只读一次', async () => {
    const uploaded = await upload()
    const read = vi.spyOn(app.runtime.get(AssetReadService), 'readAuthorized')
    for (const id of [uploaded.assetId, randomUUID(), 'invalid'])
      await expectImage(await get(id, outsider), 404)
    expect(read).not.toHaveBeenCalled()
    await expectImage(await get(uploaded.assetId))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('认证后图片查询被真实表锁阻塞，超时返回逻辑 503 占位，释放后正常恢复', async () => {
    const uploaded = await upload()
    const response = await whileHolding(database, async client => client.query('LOCK TABLE asset_objects IN ACCESS EXCLUSIVE MODE'), async () => get(uploaded.assetId))
    expect(response.headers.get('retry-after')).toBe('5')
    await expectImage(response, 503)
    await expectImage(await get(uploaded.assetId))
  })
})

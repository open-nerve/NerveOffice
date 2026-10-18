import type { AssetUploadResponse } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSET_MAX_BYTES, assetUploadResponseSchema, CSRF_TOKEN_HEADER, errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let session: LoggedIn
let other: LoggedIn
let directory: string
let root: string
const logs: string[] = []
async function fixture(name: string): Promise<Buffer> {
  return readFile(new URL(`../../../../apps/api/src/modules/assets/testdata/${name}`, import.meta.url))
}
async function upload(bytes: Uint8Array, mime = 'image/png', extension = 'png', headers: Record<string, string | undefined> = {}, user = session): Promise<Response> {
  return asUser(app.baseUrl, user, '/api/assets', { method: 'POST', binary: { contentType: mime, bytes }, headers: { 'x-asset-extension': extension, ...headers } })
}
async function success(response: Response): Promise<AssetUploadResponse> {
  expect(response.status, await response.clone().text()).toBe(201)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return parseExact(assetUploadResponseSchema, await response.json())
}
async function rejected(response: Response, status: number, code: string, details?: object): Promise<void> {
  expect(response.status).toBe(status)
  expect(parseExact(errorResponseSchema, await response.json()).error).toMatchObject({ code, ...(details === undefined ? {} : { details }) })
}
beforeAll(async () => {
  database = await createTestDatabase()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'nerve-assets-http-')))
  root = join(directory, 'private-assets')
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
  for (const username of ['assets-uploader', 'assets-other']) {
    const account = await createAccount(database, { username })
    const loggedIn = await login(app.baseUrl, account.username, account.password)
    if (username === 'assets-uploader')
      session = loggedIn
    else
      other = loggedIn
  }
})
afterAll(async () => {
  await app?.close()
  logs.push(app.logs.text())
  await database?.drop()
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true })
  expect(logs.join('\n')).not.toContain(root)
  expect(logs.join('\n')).not.toContain('private-filename')
})

describe('图片上传 HTTP 与真实文件/处理进程', () => {
  it.each([
    ['minimum.png', 'image/png', 'PNG'],
    ['orientation.jpg', 'image/jpeg', 'jpg'],
    ['animated.webp', 'image/webp', 'webp'],
    ['zero-delay-gif.gif', 'image/gif', 'gif'],
  ])('%s 完整处理、提交元数据后返回独立地址，私有对象与摘要一致', async (file, mime, extension) => {
    const result = await success(await upload(await fixture(file), mime, extension))
    const object = await database.query(async client => (await client.query<{ storage_key: string, sha256: string, bytes: number }>('SELECT o.storage_key, o.sha256, o.bytes FROM assets a JOIN asset_objects o ON o.sha256 = a.object_hash WHERE a.id = $1', [result.assetId])).rows[0])
    expect(object).toBeDefined()
    const data = await readFile(join(root, object!.storage_key))
    expect(data.length).toBe(result.bytes)
    expect(createHash('sha256').update(data).digest('hex')).toBe(object!.sha256)
    expect(JSON.stringify(result)).not.toContain(object!.sha256)
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it('不同账户上传同图有不同 ID，复用同一完整对象', async () => {
    const data = await fixture('minimum.png')
    const first = await success(await upload(data))
    const second = await success(await upload(data, 'image/png', 'png', {}, other))
    expect(second.assetId).not.toBe(first.assetId)
    const records = await database.query(async client => (await client.query<{ object_hash: string, uploader_id: string }>('SELECT object_hash, uploader_id FROM assets WHERE id = ANY($1::uuid[])', [[first.assetId, second.assetId]])).rows)
    expect(new Set(records.map(row => row.object_hash)).size).toBe(1)
    expect(new Set(records.map(row => row.uploader_id)).size).toBe(2)
  })

  it('认证与 CSRF/Origin 在媒体检查和正文解析之前', async () => {
    const data = Buffer.from('{invalid json and private-filename.jpg')
    const response = await fetch(`${app.baseUrl}/api/assets`, { method: 'POST', headers: { 'content-type': 'application/json', 'origin': TEST_PUBLIC_ORIGIN }, body: data })
    await rejected(response, 401, 'UNAUTHENTICATED')
    await rejected(await upload(data, 'application/json', 'png', { [CSRF_TOKEN_HEADER]: undefined }), 403, 'CSRF_TOKEN_INVALID')
    await rejected(await upload(data, 'application/json', 'png', { origin: 'https://elsewhere.example' }), 403, 'ORIGIN_NOT_ALLOWED')
    // Express 默认大小写不敏感且允许末尾斜杠，原始体延迟读取也必须覆盖同一组路径。
    await rejected(await fetch(`${app.baseUrl}/api/ASSETS/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: data }), 401, 'UNAUTHENTICATED')
  })

  it('媒体/编码/后缀的拒绝没有原始值；格式伪装与空体是有限的图片规则', async () => {
    const data = await fixture('minimum.png')
    await rejected(await upload(data, 'image/svg+xml'), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await rejected(await upload(data, 'application/json'), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await rejected(await upload(data, 'image/png', 'png', { 'content-encoding': 'gzip' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    for (const extension of ['private-filename.png', '../png', 'p ng', '', 'svg'])
      await rejected(await upload(data, 'image/png', extension), 400, 'REQUEST_INVALID')
    await rejected(await upload(data, 'image/jpeg', 'jpg'), 422, 'ASSET_INVALID', { rule: 'type' })
    await rejected(await upload(Buffer.alloc(0)), 422, 'ASSET_INVALID', { rule: 'corrupt' })
  })

  it('输入超限返回 413，随后正常上传仍成功', async () => {
    await rejected(await upload(Buffer.alloc(ASSET_MAX_BYTES + 1)), 413, 'PAYLOAD_TOO_LARGE')
    await success(await upload(await fixture('minimum.png')))
  })

  it('服务重启复用既有私有文件与配额，不重收相同对象字节', async () => {
    const before = await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes, used_assets FROM asset_quota')).rows[0]!)
    await app.close()
    logs.push(app.logs.text())
    app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
    await success(await upload(await fixture('minimum.png')))
    const after = await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes, used_assets FROM asset_quota')).rows[0]!)
    expect(after.used_bytes).toBe(before.used_bytes)
    expect(after.used_assets).toBe(before.used_assets + 1)
  })

  it('下调记录上限后 HTTP 返回 409 与有限 count 详情，已发布文件和账目保持', async () => {
    await app.close()
    logs.push(app.logs.text())
    app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root, NERVE_ASSET_QUOTA_COUNT: '1' } })
    const before = await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes, used_assets FROM asset_quota')).rows)
    await rejected(await upload(await fixture('minimum.png')), 409, 'ASSET_QUOTA_EXCEEDED', { kind: 'count' })
    expect(await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes, used_assets FROM asset_quota')).rows)).toEqual(before)
    await app.close()
    logs.push(app.logs.text())
    app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
    await success(await upload(await fixture('minimum.png')))
  })

  it('先前未完成的持久预留也占字节，HTTP 返回 409 bytes；提高配额后下一份成功', async () => {
    // 真实库中布置一次未发布就结束的旧上传：claim 收费但还没有 object/asset。
    await database.query(async (client) => {
      await client.query('BEGIN')
      await client.query('INSERT INTO asset_object_claims (sha256, bytes) VALUES ($1, $2)', ['f'.repeat(64), ASSET_MAX_BYTES])
      await client.query('UPDATE asset_quota SET used_bytes = used_bytes + $1', [ASSET_MAX_BYTES])
      await client.query('COMMIT')
    })
    await app.close()
    logs.push(app.logs.text())
    app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root, NERVE_ASSET_QUOTA_BYTES: String(ASSET_MAX_BYTES) } })
    // 使用本文件前面尚未上传的格式样本，不能命中已有对象。
    await rejected(await upload(await fixture('rgba-text.png')), 409, 'ASSET_QUOTA_EXCEEDED', { kind: 'bytes' })
    await app.close()
    logs.push(app.logs.text())
    app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
    await success(await upload(await fixture('rgba-text.png')))
  })
})

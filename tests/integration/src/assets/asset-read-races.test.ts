import type { TestAccount } from '../support/accounts.ts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { TransactionRunner } from '@nerve-office/api'
import { APPLICATION_NAME, AssetReadService, DocumentsRepository } from '@nerve-office/api/testing'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { uploadTestAsset } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

interface Client { readonly account: TestAccount, readonly session: LoggedIn }
let database: TestDatabase
let app: TestApp
let root: Client
let owner: Client
let nextPerson = 0

async function person(role: 'member' | 'admin' = 'member'): Promise<Client> {
  nextPerson += 1
  const account = await createAccount(database, { username: `asset-race-${nextPerson}`, systemRole: role })
  return { account, session: await login(app.baseUrl, account.username, account.password) }
}
beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  root = await person('admin')
  owner = await person()
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await database?.drop()
})

async function read(client: Client, assetId: string): Promise<Response> {
  return asUser(app.baseUrl, client.session, `/api/assets/${assetId}`)
}
async function image(response: Response, status: 200 | 404): Promise<Buffer> {
  expect(response.status).toBe(200)
  expect(response.headers.get('x-asset-status')).toBe(String(status))
  expect(response.headers.get('cache-control')).toBe(status === 200 ? 'private, no-store' : 'no-store')
  return Buffer.from(await response.arrayBuffer())
}
async function referenced(spaceId = owner.account.personalSpaceId): Promise<{ assetId: string, documentId: string }> {
  const asset = await uploadTestAsset(app.baseUrl, owner.session)
  const document = await seedDocument(database, { spaceId, createdBy: owner.account.id, title: '图片权限交错' })
  await database.query(async (client) => {
    await client.query('UPDATE assets SET created_at = now() - interval \'25 hours\' WHERE id = $1', [asset.assetId])
    await client.query('INSERT INTO document_asset_links (document_id, asset_id) VALUES ($1,$2)', [document.id, asset.assetId])
  })
  return { assetId: asset.assetId, documentId: document.id }
}
async function share(documentId: string, client: Client): Promise<void> {
  const response = await asUser(app.baseUrl, owner.session, `/api/documents/${documentId}/grants/${client.account.id}`, { method: 'PUT', body: { role: 'viewer' } })
  expect(response.status).toBe(200)
}

/** 只暂停一次真实调用，放行后调用原实现。没有假权限、假元数据或假文件。 */
function signal() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function whilePaused<T extends object, K extends keyof T & string>(
  target: T,
  method: K,
  matches: (...args: unknown[]) => boolean,
  request: () => Promise<Response>,
  change: () => Promise<void>,
): Promise<Response> {
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target)
  const reached = signal()
  const release = signal()
  const spy = vi.spyOn(target, method as never).mockImplementationOnce((async (...args: unknown[]) => {
    expect(matches(...args), `停住的不是被测调用：${method}`).toBe(true)
    reached.resolve()
    await release.promise
    return original(...args)
  }) as never)
  const pending = request()
  try {
    const arrived = await Promise.race([reached.promise.then(() => true), pending.then(() => false)])
    expect(arrived, `请求未到达停点 ${method}`).toBe(true)
    await change()
  }
  finally {
    release.resolve()
    await pending.catch(() => undefined)
    spy.mockRestore()
  }
  return pending
}

describe('当前引用与身份撤销的确定交错', () => {
  it.each(['取消分享', '删除文档'] as const)('快照已开始后%s：原请求读旧快照，新请求不可读', async (change) => {
    const viewer = await person()
    const { assetId, documentId } = await referenced()
    await share(documentId, viewer)
    const before = await image(await read(viewer, assetId), 200)
    const response = await whilePaused(app.runtime.get(DocumentsRepository), 'firstAccessibleAssetSource', (_scope, id) => id === assetId, async () => read(viewer, assetId), async () => {
      const path = change === '取消分享' ? `/api/documents/${documentId}/grants/${viewer.account.id}` : `/api/documents/${documentId}`
      expect((await asUser(app.baseUrl, owner.session, path, { method: 'DELETE' })).status).toBe(204)
      await image(await read(viewer, assetId), 404)
    })
    expect(await image(response, 200)).toEqual(before)
    await image(await read(viewer, assetId), 404)
  })

  it.each(['移出团队', '文档移到私人空间'] as const)('快照已开始后%s：权限和文档位置不拼接两个时刻', async (change) => {
    const viewer = await person()
    const team = await createTeamSpace(database, { name: `图片交错${nextPerson}`, createdBy: root.account.id, members: { [owner.account.id]: 'admin', [viewer.account.id]: 'viewer' } })
    const { assetId, documentId } = await referenced(team)
    const before = await image(await read(viewer, assetId), 200)
    const response = await whilePaused(app.runtime.get(AssetReadService), 'metadata', id => id === assetId, async () => read(viewer, assetId), async () => {
      const result = change === '移出团队'
        ? await asUser(app.baseUrl, owner.session, `/api/spaces/${team}/members/${viewer.account.id}`, { method: 'DELETE' })
        : await asUser(app.baseUrl, owner.session, `/api/documents/${documentId}/move`, { method: 'POST', body: { spaceId: owner.account.personalSpaceId } })
      expect(result.status).toBe(change === '移出团队' ? 204 : 200)
      await image(await read(viewer, assetId), 404)
    })
    expect(await image(response, 200)).toEqual(before)
    await image(await read(viewer, assetId), 404)
  })

  it('守卫之后、快照之前退出：开场复核仍返回 SESSION_EXPIRED，不转成占位', async () => {
    const uploader = await person()
    const { assetId } = await uploadTestAsset(app.baseUrl, uploader.session)
    const response = await whilePaused(app.runtime.get(TransactionRunner), 'readSnapshot', () => true, async () => read(uploader, assetId), async () => {
      expect((await asUser(app.baseUrl, uploader.session, '/api/auth/logout', { method: 'POST' })).status).toBe(204)
      expect((await read(uploader, assetId)).status).toBe(401)
    })
    expect(response.status).toBe(401)
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('SESSION_EXPIRED')
    expect(response.headers.get('x-asset-status')).toBeNull()
  })

  it('守卫之后、快照之前撤销系统角色：沿用身份复核 403，下一次以新角色正常读取本人上传', async () => {
    const uploader = await person('admin')
    const { assetId } = await uploadTestAsset(app.baseUrl, uploader.session)
    const response = await whilePaused(app.runtime.get(TransactionRunner), 'readSnapshot', () => true, async () => read(uploader, assetId), async () => {
      expect((await asUser(app.baseUrl, root.session, `/api/admin/users/${uploader.account.id}/system-role`, { method: 'PUT', body: { systemRole: 'member' } })).status).toBe(200)
      await image(await read(uploader, assetId), 200)
    })
    expect(response.status).toBe(403)
    expect(errorResponseSchema.parse(await response.json()).error.code).toBe('PERMISSION_DENIED')
    expect(response.headers.get('x-asset-status')).toBeNull()
  })

  it('文件读取前事务已归还；此时撤权不倒改原快照，随后请求必须拒绝', async () => {
    const viewer = await person()
    const { assetId, documentId } = await referenced()
    await share(documentId, viewer)
    const before = await image(await read(viewer, assetId), 200)
    const response = await whilePaused(app.runtime.get(AssetReadService), 'readAuthorized', metadata => typeof metadata === 'object' && metadata !== null && 'assetId' in metadata && metadata.assetId === assetId, async () => read(viewer, assetId), async () => {
      const transactions = await database.query(async client => (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1 AND application_name = $2 AND xact_start IS NOT NULL', [database.name, APPLICATION_NAME])).rows[0]!.count)
      expect(transactions, '文件读取期间不能持有数据库事务').toBe(0)
      expect((await asUser(app.baseUrl, owner.session, `/api/documents/${documentId}/grants/${viewer.account.id}`, { method: 'DELETE' })).status).toBe(204)
      await image(await read(viewer, assetId), 404)
    })
    expect(await image(response, 200)).toEqual(before)
  })

  it('同一图片有多个当前来源：撤销一个仍能读，最后一个失效后才拒绝', async () => {
    const viewer = await person()
    const { assetId, documentId } = await referenced()
    const second = await seedDocument(database, { spaceId: owner.account.personalSpaceId, createdBy: owner.account.id, title: '第二个当前来源' })
    await database.query(async client => client.query('INSERT INTO document_asset_links (document_id, asset_id) VALUES ($1,$2)', [second.id, assetId]))
    await share(documentId, viewer)
    await share(second.id, viewer)
    for (const id of [documentId, second.id]) {
      await image(await read(viewer, assetId), 200)
      expect((await asUser(app.baseUrl, owner.session, `/api/documents/${id}/grants/${viewer.account.id}`, { method: 'DELETE' })).status).toBe(204)
    }
    await image(await read(viewer, assetId), 404)
  })
})

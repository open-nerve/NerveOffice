import { CSRF_TOKEN_HEADER, EDIT_LEASE_HEADER, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { describe, expect, it, vi } from 'vitest'
import { observeStaleSelftestSave } from './selftest-stale-save.ts'

const DOC = 'eb026042-d41d-4485-9455-bc6cc7613ec7'
const CLIENT = '5657752d-f93e-4b22-94fb-aa051daf0922'
const ORIGIN = 'http://127.0.0.1:3000'
const path = `/api/documents/${DOC}/content?baseRevision=2&requestId=old-request&clientInstanceId=${CLIENT}&localSeq=2&writeEpoch=1&formulasPending=false&clientBuild=build&univerVersion=0.12.4&profile=sheet-v1&formatVersion=1`
const headers = { [CSRF_TOKEN_HEADER]: 'private-csrf', [EDIT_LEASE_HEADER]: 'private-lease', 'content-type': SNAPSHOT_UPLOAD_CONTENT_TYPE }
const prepared = { clientInstanceId: CLIENT, localSeq: 3, compressed: new Uint8Array([31, 139, 8]) }

function fixture() {
  const actual = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const target = { fetch: actual as typeof fetch }
  const observer = observeStaleSelftestSave(DOC, ORIGIN, target)
  const save = async (url = path, status = 200) => {
    actual.mockResolvedValueOnce(new Response('{}', { status }))
    await target.fetch(url, { method: 'PUT', headers, credentials: 'same-origin', body: new Uint8Array([1]) })
  }
  return { actual, target, observer, save }
}

describe('本轮旧保存的直接拒绝核对', () => {
  it('原请求照常传递；只在准备后用同一租约、同一 client 和新的请求标识提交已持久的第三格，结果不含令牌', async () => {
    const { actual, observer, save } = fixture()
    await save()
    expect(actual).toHaveBeenCalledWith(path, expect.objectContaining({ method: 'PUT', headers }))
    observer.prepare(prepared)
    actual.mockResolvedValueOnce(Response.json({ error: { code: 'EDIT_LEASE_LOST', details: { reason: 'replaced' } } }, { status: 409 }))
    const receipt = await observer.attempt()
    expect(receipt).toMatchObject({ status: 409, code: 'EDIT_LEASE_LOST', reason: 'replaced' })
    expect(JSON.stringify(receipt)).not.toMatch(/private-(csrf|lease)/)
    const [url, init] = actual.mock.calls[1]!
    const query = new URL(String(url)).searchParams
    expect(query.get('requestId')).not.toBe('old-request')
    expect(query.get('requestId')).toBe(receipt.requestId)
    expect(query.get('baseRevision')).toBe('3')
    expect(query.get('localSeq')).toBe('3')
    expect(query.get('clientInstanceId')).toBe(CLIENT)
    expect(query.get('writeEpoch')).toBe('1')
    expect(query.get('clientBuild')).toBe('build')
    expect(init?.body).toEqual(prepared.compressed)
    expect(new Headers(init?.headers).get(EDIT_LEASE_HEADER)).toBe('private-lease')
    await expect(observer.attempt()).rejects.toThrow('不能重复')
    observer.dispose()
  })

  it.each(['foreign-origin', 'foreign-document', 'failed-save', 'read', 'missing-lease'])('没有同源同文档已成功的保存就不能准备：%s', async (change) => {
    const { actual, target, observer } = fixture()
    const url = change === 'foreign-origin' ? `http://127.0.0.1:4000${path}` : change === 'foreign-document' ? path.replace(DOC, CLIENT) : path
    const method = change === 'read' ? 'GET' : 'PUT'
    const actualHeaders = change === 'missing-lease' ? {} : headers
    actual.mockResolvedValueOnce(new Response('{}', { status: change === 'failed-save' ? 409 : 200 }))
    await target.fetch(url, { method, headers: actualHeaders })
    expect(() => observer.prepare(prepared)).toThrow()
    observer.dispose()
  })

  it('错 client、重复准备、准备前提交或释放后提交都拒绝；释放不覆盖后装的 fetch', async () => {
    const { actual, target, observer, save } = fixture()
    await expect(observer.attempt()).rejects.toThrow()
    await save()
    expect(() => observer.prepare({ ...prepared, clientInstanceId: DOC })).toThrow()
    observer.prepare(prepared)
    expect(() => observer.prepare(prepared)).toThrow()
    const later = vi.fn<typeof fetch>(async (...args) => actual(...args))
    target.fetch = later
    observer.dispose()
    expect(target.fetch).toBe(later)
    await expect(observer.attempt()).rejects.toThrow()
  })

  it.each([
    { status: 200, error: undefined },
    { status: 409, error: { code: 'REVISION_CONFLICT', details: { reason: 'replaced' } } },
    { status: 409, error: { code: 'EDIT_LEASE_LOST', details: { reason: 'none' } } },
    { status: 403, error: { code: 'EDIT_LEASE_LOST', details: { reason: 'replaced' } } },
  ])('只认旧代次被替换的 409，其他结果不能证明保存隔离：%j', async ({ status, error }) => {
    const { actual, observer, save } = fixture()
    await save()
    observer.prepare(prepared)
    actual.mockResolvedValueOnce(Response.json({ error }, { status }))
    await expect(observer.attempt()).rejects.toThrow('未确认')
    observer.dispose()
  })
})

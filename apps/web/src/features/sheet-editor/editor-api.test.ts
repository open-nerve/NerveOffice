import { afterEach, describe, expect, it } from 'vitest'
import { ApiError, NetworkError, setCsrfToken } from '../../shared/api/index.ts'
import { apiError, installFakeApi, json, networkFailure } from '../../shared/testing/fake-api.test-support.ts'
import { acquireEditLease, releaseEditLease, renewEditLease, saveContent } from './editor-api.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const LEASE = `/api/documents/${DOCUMENT_ID}/edit-lease`
const TOKEN = 'T'.repeat(43)
const ACQUIRED = { token: TOKEN, writeEpoch: 2, revision: 4, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null }

afterEach(() => {
  setCsrfToken(undefined)
})

describe('编辑租约的请求（M3-P1 设计 §3.2）', () => {
  it('申请：POST 本页这次加载的标识（带 CSRF 令牌），按契约读出令牌、代次与修订号；被占用时抛出 EDIT_LEASE_HELD', async () => {
    const api = installFakeApi({ [`POST ${LEASE}`]: () => json(201, ACQUIRED) })
    setCsrfToken('csrf-1')
    await expect(acquireEditLease(DOCUMENT_ID, PAGE_ID)).resolves.toEqual(ACQUIRED)
    expect(api.requests[0]).toMatchObject({ body: { clientInstanceId: PAGE_ID }, headers: { 'x-csrf-token': 'csrf-1' } })
    api.on(`POST ${LEASE}`, () => apiError(409, 'EDIT_LEASE_HELD'))
    await expect(acquireEditLease(DOCUMENT_ID, PAGE_ID)).rejects.toMatchObject({ code: 'EDIT_LEASE_HELD' })
  })

  it('续租：PUT 空闲的秒数，令牌只在请求头里（不进地址）', async () => {
    const api = installFakeApi({ [`PUT ${LEASE}`]: () => json(200, { expiresAt: '2026-10-04T03:01:40.000Z' }) })
    setCsrfToken('csrf-1')
    await expect(renewEditLease(DOCUMENT_ID, TOKEN, 12)).resolves.toEqual({ expiresAt: '2026-10-04T03:01:40.000Z' })
    expect(api.requests[0]).toMatchObject({ key: `PUT ${LEASE}`, body: { idleSeconds: 12 }, headers: { 'x-edit-lease': TOKEN, 'x-csrf-token': 'csrf-1' } })
  })

  it('释放：DELETE，keepalive，带令牌与 CSRF 两个请求头；204 时兑现，失败时抛出请求层的错误（续上要知道放掉了没有，审查 B9）', async () => {
    let init: RequestInit | undefined
    const api = installFakeApi({
      [`DELETE ${LEASE}`]: (received) => {
        init = received
        return new Response(null, { status: 204 })
      },
    })
    setCsrfToken('csrf-2')
    await expect(releaseEditLease(DOCUMENT_ID, TOKEN)).resolves.toBeUndefined()
    expect(api.requests[0]?.headers).toMatchObject({ 'x-edit-lease': TOKEN, 'x-csrf-token': 'csrf-2' })
    expect(init?.keepalive).toBe(true)
    // 断网（结果未知）与被拒（确定的回答）分得开：续上时前者不申请，后者照常申请；页面关闭时不看结果
    api.on(`DELETE ${LEASE}`, networkFailure)
    await expect(releaseEditLease(DOCUMENT_ID, TOKEN)).rejects.toBeInstanceOf(NetworkError)
    api.on(`DELETE ${LEASE}`, () => apiError(404, 'NOT_FOUND'))
    const refused = releaseEditLease(DOCUMENT_ID, TOKEN)
    await expect(refused).rejects.toBeInstanceOf(ApiError)
    await expect(refused).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    expect(api.requests).toHaveLength(3)
  })

  it('保存：查询参数带上代次，请求头带上令牌', async () => {
    const api = installFakeApi()
    api.on(`PUT /api/documents/${DOCUMENT_ID}/content?baseRevision=4&requestId=req-1&clientInstanceId=${PAGE_ID}&localSeq=3&writeEpoch=2`, () => json(200, { revision: 5, savedAt: '2026-10-04T03:00:00.000Z' }))
    const request = { baseRevision: 4, requestId: 'req-1', clientInstanceId: PAGE_ID, localSeq: 3, snapshot: '{}' }
    await expect(saveContent(DOCUMENT_ID, request, new Uint8Array([1]), { token: TOKEN, writeEpoch: 2 })).resolves.toEqual({ revision: 5, savedAt: '2026-10-04T03:00:00.000Z' })
    expect(api.requests[0]?.headers).toMatchObject({ 'x-edit-lease': TOKEN, 'content-type': 'application/gzip' })
  })
})

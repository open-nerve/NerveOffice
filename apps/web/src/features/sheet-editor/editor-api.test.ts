import { afterEach, describe, expect, it, vi } from 'vitest'
import { setCsrfToken } from '../../shared/api/index.ts'
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

  it('释放：DELETE，keepalive，带令牌与 CSRF 两个请求头；失败不抛出（结果不管）', async () => {
    let init: RequestInit | undefined
    const api = installFakeApi({
      [`DELETE ${LEASE}`]: (received) => {
        init = received
        return new Response(null, { status: 204 })
      },
    })
    setCsrfToken('csrf-2')
    releaseEditLease(DOCUMENT_ID, TOKEN)
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    expect(api.requests[0]?.headers).toMatchObject({ 'x-edit-lease': TOKEN, 'x-csrf-token': 'csrf-2' })
    expect(init?.keepalive).toBe(true)
    // 断网、被拒：都不抛出（没接住的 Promise 会让测试失败）
    api.on(`DELETE ${LEASE}`, networkFailure)
    releaseEditLease(DOCUMENT_ID, TOKEN)
    api.on(`DELETE ${LEASE}`, () => apiError(404, 'NOT_FOUND'))
    releaseEditLease(DOCUMENT_ID, TOKEN)
    await vi.waitFor(() => expect(api.requests).toHaveLength(3))
  })

  it('保存：查询参数带上代次，请求头带上令牌', async () => {
    const api = installFakeApi()
    api.on(`PUT /api/documents/${DOCUMENT_ID}/content?baseRevision=4&requestId=req-1&clientInstanceId=${PAGE_ID}&localSeq=3&writeEpoch=2`, () => json(200, { revision: 5, savedAt: '2026-10-04T03:00:00.000Z' }))
    const request = { baseRevision: 4, requestId: 'req-1', clientInstanceId: PAGE_ID, localSeq: 3, snapshot: '{}' }
    await expect(saveContent(DOCUMENT_ID, request, new Uint8Array([1]), { token: TOKEN, writeEpoch: 2 })).resolves.toEqual({ revision: 5, savedAt: '2026-10-04T03:00:00.000Z' })
    expect(api.requests[0]?.headers).toMatchObject({ 'x-edit-lease': TOKEN, 'content-type': 'application/gzip' })
  })
})

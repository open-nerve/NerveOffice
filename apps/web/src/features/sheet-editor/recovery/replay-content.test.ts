import type { SaveRequest } from '../../../shared/local-drafts/save-request.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { NetworkError, ResponseFormatError, setCsrfToken } from '../../../shared/api/index.ts'
import { apiError, installFakeApi, json, networkFailure } from '../../../shared/testing/fake-api.test-support.ts'
import { replayContent } from '../editor-api.ts'

const DOCUMENT = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const REQUEST: SaveRequest = {
  requestId: '0199b0c4-7d3e-7a3b-9c4e-0000000e0001',
  clientInstanceId: '0199b0c4-7d3e-7a3b-9c4e-0000000c1e01',
  localSeq: 73,
  baseRevision: 41,
  formulasPending: true,
  format: { clientBuild: '0.1.0+original', univerVersion: '0.9.0', profile: 'sheet@1', formatVersion: 1 },
}
const BODY = new Uint8Array([31, 139, 8, 71])
const PATH = `PUT /api/documents/${DOCUMENT}/content?${new URLSearchParams({
  baseRevision: '41',
  requestId: REQUEST.requestId,
  clientInstanceId: REQUEST.clientInstanceId,
  localSeq: '73',
  writeEpoch: '11',
  formulasPending: 'true',
  ...Object.fromEntries(Object.entries(REQUEST.format).map(([key, value]) => [key, String(value)])),
}).toString()}`
const SAVED = { revision: 42, savedAt: '2026-10-10T03:00:00.000Z', unchanged: false }

afterEach(() => setCsrfToken(undefined))

describe('恢复只核对原保存的回执（无租约重放）', () => {
  it.each([false, true])('固定原身份、格式、字节与公式标记，省略租约头，按原响应返回（unchanged=%s）', async (unchanged) => {
    let sent: BodyInit | null | undefined
    const api = installFakeApi({
      [PATH]: (init) => {
        sent = init?.body
        return json(200, { ...SAVED, unchanged })
      },
    })
    setCsrfToken('recovery-csrf')
    const before = BODY.slice()
    await expect(replayContent(DOCUMENT, REQUEST, BODY, 11)).resolves.toEqual({ ...SAVED, unchanged })
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.headers).toMatchObject({ 'content-type': 'application/gzip', 'x-csrf-token': 'recovery-csrf' })
    expect(api.requests[0]?.headers).not.toHaveProperty('x-edit-lease')
    expect(sent).toBe(BODY)
    expect(BODY).toEqual(before)
  })

  it.each([
    { status: 409, code: 'EDIT_LEASE_LOST' },
    { status: 409, code: 'REQUEST_ID_CONFLICT' },
    { status: 401, code: 'UNAUTHENTICATED' },
    { status: 403, code: 'PERMISSION_DENIED' },
    { status: 404, code: 'NOT_FOUND' },
    { status: 409, code: 'CLIENT_OUTDATED' },
  ])('$status $code 不换请求、不申请租约、不隐式重试', async ({ status, code }) => {
    const api = installFakeApi({ [PATH]: () => apiError(status, code) })
    await expect(replayContent(DOCUMENT, REQUEST, BODY, 11)).rejects.toMatchObject({ status, code })
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.headers).not.toHaveProperty('x-edit-lease')
  })

  it('网络错误仍是未知结果，不假装旧保存没发生', async () => {
    const api = installFakeApi({ [PATH]: networkFailure })
    await expect(replayContent(DOCUMENT, REQUEST, BODY, 11)).rejects.toBeInstanceOf(NetworkError)
    expect(api.requests).toHaveLength(1)
  })

  it('成功正文不符合回执契约不能作为确认', async () => {
    const api = installFakeApi({ [PATH]: () => json(200, { revision: 42 }) })
    await expect(replayContent(DOCUMENT, REQUEST, BODY, 11)).rejects.toBeInstanceOf(ResponseFormatError)
    expect(api.requests).toHaveLength(1)
  })
})

import { expect, it } from 'vitest'
import { setCsrfToken } from '../api/index.ts'
import { installFakeApi, json } from '../testing/fake-api.test-support.ts'
import { replayContent } from './content-api.ts'

it('共享恢复传输原样带回旧请求和 gzip，只用当前 CSRF，不带任何编辑租约', async () => {
  const documentId = '0199b0c4-7d3e-7a3b-9c4e-00000000d0c1'
  const request = { baseRevision: 7, requestId: 'old-request', clientInstanceId: 'old-page', localSeq: 9, formulasPending: true, format: { clientBuild: 'original-build', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 } }
  const query = new URLSearchParams({ baseRevision: '7', requestId: 'old-request', clientInstanceId: 'old-page', localSeq: '9', writeEpoch: '3', formulasPending: 'true', clientBuild: 'original-build', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: '1' })
  const gzip = new Uint8Array([0x1F, 0x8B, 4, 5])
  let body: unknown
  const api = installFakeApi({ [`PUT /api/documents/${documentId}/content?${query}`]: (init) => {
    body = init?.body
    return json(200, { revision: 8, savedAt: '2026-10-14T00:00:00.000Z', unchanged: false })
  } })
  setCsrfToken('current-session')
  try {
    expect(await replayContent(documentId, request, gzip, 3)).toMatchObject({ revision: 8 })
    expect(body).toEqual(gzip)
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]?.headers).toMatchObject({ 'x-csrf-token': 'current-session', 'content-type': 'application/gzip' })
    expect(api.requests[0]?.headers).not.toHaveProperty('x-edit-lease')
  }
  finally {
    setCsrfToken(undefined)
  }
})

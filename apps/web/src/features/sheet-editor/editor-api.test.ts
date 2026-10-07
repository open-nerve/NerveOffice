import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, NetworkError, ResponseFormatError, setCsrfToken } from '../../shared/api/index.ts'
import { apiError, installFakeApi, json, networkFailure } from '../../shared/testing/fake-api.test-support.ts'
import { PAGE_CLIENT_FORMAT } from './client-format.ts'
import { acquireEditLease, CONTENT_UNCHANGED, fetchContent, fetchContentIfChanged, fetchEditStatus, releaseEditLease, renewEditLease, saveConflictCopy, saveContent, snapshotDigest } from './editor-api.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const PAGE_ID = '0199a2c4-1f2e-4a3b-8c4d-00000000aaaa'
const LEASE = `/api/documents/${DOCUMENT_ID}/edit-lease`
const TOKEN = 'T'.repeat(43)
const ACQUIRED = { token: TOKEN, writeEpoch: 2, revision: 4, source: null, expiresAt: '2026-10-04T03:01:30.000Z', interruption: null, formulasPending: false }
/** 本页的构建与数据格式写成查询串（M3-P3）：保存与另存为副本都带 */
const FORMAT_QUERY = `clientBuild=${encodeURIComponent(PAGE_CLIENT_FORMAT.clientBuild)}&univerVersion=${PAGE_CLIENT_FORMAT.univerVersion}&profile=${encodeURIComponent(PAGE_CLIENT_FORMAT.profile)}&formatVersion=${PAGE_CLIENT_FORMAT.formatVersion}`

afterEach(() => {
  setCsrfToken(undefined)
})

describe('编辑租约的请求（M3-P1 设计 §3.2）', () => {
  it('申请：POST 本页这次加载的标识与本页的构建与数据格式（带 CSRF 令牌，M3-P3），按契约读出令牌、代次与修订号；被占用时抛出 EDIT_LEASE_HELD', async () => {
    const api = installFakeApi({ [`POST ${LEASE}`]: () => json(201, ACQUIRED) })
    setCsrfToken('csrf-1')
    await expect(acquireEditLease(DOCUMENT_ID, PAGE_ID)).resolves.toEqual(ACQUIRED)
    expect(api.requests[0]).toMatchObject({ body: { clientInstanceId: PAGE_ID, ...PAGE_CLIENT_FORMAT }, headers: { 'x-csrf-token': 'csrf-1' } })
    api.on(`POST ${LEASE}`, () => apiError(409, 'EDIT_LEASE_HELD'))
    await expect(acquireEditLease(DOCUMENT_ID, PAGE_ID)).rejects.toMatchObject({ code: 'EDIT_LEASE_HELD' })
  })

  it('申请：续上时另带本页的空闲秒数（M3-P5 设计 §3.5）；用户发起的申请不带', async () => {
    const api = installFakeApi({ [`POST ${LEASE}`]: () => json(201, ACQUIRED) })
    setCsrfToken('csrf-1')
    await acquireEditLease(DOCUMENT_ID, PAGE_ID, { idleSeconds: 37 })
    expect(api.requests[0]?.body).toEqual({ clientInstanceId: PAGE_ID, idleSeconds: 37, ...PAGE_CLIENT_FORMAT })
    await acquireEditLease(DOCUMENT_ID, PAGE_ID)
    expect(api.requests[1]?.body).toEqual({ clientInstanceId: PAGE_ID, ...PAGE_CLIENT_FORMAT })
  })

  it('申请："在此编辑"另带接管方式（takeover: self，M3-P5 设计 §3.7）', async () => {
    const api = installFakeApi({ [`POST ${LEASE}`]: () => json(201, ACQUIRED) })
    setCsrfToken('csrf-1')
    await acquireEditLease(DOCUMENT_ID, PAGE_ID, { takeover: 'self' })
    expect(api.requests[0]?.body).toEqual({ clientInstanceId: PAGE_ID, takeover: 'self', ...PAGE_CLIENT_FORMAT })
  })

  it('续租：PUT 空闲的秒数与本页的构建与数据格式（M3-P3），令牌只在请求头里（不进地址）', async () => {
    const api = installFakeApi({ [`PUT ${LEASE}`]: () => json(200, { expiresAt: '2026-10-04T03:01:40.000Z', request: null }) })
    setCsrfToken('csrf-1')
    await expect(renewEditLease(DOCUMENT_ID, TOKEN, 12)).resolves.toEqual({ expiresAt: '2026-10-04T03:01:40.000Z', request: null })
    expect(api.requests[0]).toMatchObject({ key: `PUT ${LEASE}`, body: { idleSeconds: 12, ...PAGE_CLIENT_FORMAT }, headers: { 'x-edit-lease': TOKEN, 'x-csrf-token': 'csrf-1' } })
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

  it('保存：查询参数带上代次、"公式待更新"与本页的构建与数据格式（M3-P3），请求头带上令牌；内容相同（unchanged）照样读出', async () => {
    const api = installFakeApi()
    api.on(`PUT /api/documents/${DOCUMENT_ID}/content?baseRevision=4&requestId=req-1&clientInstanceId=${PAGE_ID}&localSeq=3&writeEpoch=2&formulasPending=true&${FORMAT_QUERY}`, () => json(200, { revision: 4, savedAt: '2026-10-04T03:00:00.000Z', unchanged: true }))
    const request = { baseRevision: 4, requestId: 'req-1', clientInstanceId: PAGE_ID, localSeq: 3, snapshot: '{}', formulasPending: true }
    await expect(saveContent(DOCUMENT_ID, request, new Uint8Array([1]), { token: TOKEN, writeEpoch: 2 })).resolves.toEqual({ revision: 4, savedAt: '2026-10-04T03:00:00.000Z', unchanged: true })
    expect(api.requests[0]?.headers).toMatchObject({ 'x-edit-lease': TOKEN, 'content-type': 'application/gzip' })
  })

  it('本页过旧、文档比服务端新（M3-P3）：保存、申请、续租照常抛出 CLIENT_OUTDATED、DOCUMENT_TOO_NEW（ApiError，带原因）', async () => {
    const outdated = (reason: string): Response => json(409, { error: { code: 'CLIENT_OUTDATED', message: '页面的版本过旧', requestId: 'req-outdated', details: { reason } } })
    const api = installFakeApi({ [`POST ${LEASE}`]: () => apiError(409, 'DOCUMENT_TOO_NEW'), [`PUT ${LEASE}`]: () => outdated('build') })
    await expect(acquireEditLease(DOCUMENT_ID, PAGE_ID)).rejects.toMatchObject({ status: 409, code: 'DOCUMENT_TOO_NEW' })
    await expect(renewEditLease(DOCUMENT_ID, TOKEN, 0)).rejects.toMatchObject({ status: 409, code: 'CLIENT_OUTDATED', details: { reason: 'build' } })
    api.on(`PUT /api/documents/${DOCUMENT_ID}/content?baseRevision=4&requestId=req-1&clientInstanceId=${PAGE_ID}&localSeq=3&writeEpoch=2&formulasPending=false&${FORMAT_QUERY}`, () => outdated('format'))
    const request = { baseRevision: 4, requestId: 'req-1', clientInstanceId: PAGE_ID, localSeq: 3, snapshot: '{}', formulasPending: false }
    await expect(saveContent(DOCUMENT_ID, request, new Uint8Array([1]), { token: TOKEN, writeEpoch: 2 })).rejects.toMatchObject({ code: 'CLIENT_OUTDATED', details: { reason: 'format' } })
  })
})

const CONTENT = `/api/documents/${DOCUMENT_ID}/content`
const SNAPSHOT = '{"id":"unit-1"}'

function content(revision: number): Response {
  return new Response(SNAPSHOT, { status: 200, headers: { etag: `"${revision}"` } })
}

describe('内容的读取（P4 设计 §3.3；M3-P2 设计 §3.2 的条件读取）', () => {
  it('全文：原文与 ETag 里的修订号；没有修订号时 ResponseFormatError', async () => {
    const api = installFakeApi({ [`GET ${CONTENT}`]: () => content(5) })
    await expect(fetchContent(DOCUMENT_ID)).resolves.toEqual({ snapshot: SNAPSHOT, revision: 5 })
    expect(api.requests[0]?.headers['if-none-match']).toBeUndefined()
    api.on(`GET ${CONTENT}`, () => new Response(SNAPSHOT, { status: 200 }))
    await expect(fetchContent(DOCUMENT_ID)).rejects.toBeInstanceOf(ResponseFormatError)
  })

  it('条件读取：带 If-None-Match（本页手里的修订号）；服务端还是这一版（304）时给出 CONTENT_UNCHANGED，有更新时读全文', async () => {
    const api = installFakeApi({ [`GET ${CONTENT}`]: () => new Response(null, { status: 304, headers: { etag: '"3"' } }) })
    await expect(fetchContentIfChanged(DOCUMENT_ID, 3)).resolves.toBe(CONTENT_UNCHANGED)
    expect(api.requests[0]?.headers['if-none-match']).toBe('"3"')
    api.on(`GET ${CONTENT}`, () => content(4))
    await expect(fetchContentIfChanged(DOCUMENT_ID, 3)).resolves.toEqual({ snapshot: SNAPSHOT, revision: 4 })
  })

  it('条件读取照常判断权限：读不到时抛出 404（与不存在一致），不当作没有变化', async () => {
    installFakeApi({ [`GET ${CONTENT}`]: () => apiError(404, 'NOT_FOUND') })
    await expect(fetchContentIfChanged(DOCUMENT_ID, 3)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })
})

describe('编辑状态与另存为副本（M3-P2 设计 §3.2）', () => {
  const STATUS = { revision: 3, editor: { holder: { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000e1', username: 'amy', displayName: '艾米' }, lastActiveAt: '2026-10-04T03:00:00.000Z', sameUser: false, sameSession: false }, canEdit: true, canTakeOver: false, formulasPending: false, request: null, reservation: null, interruption: null }

  it('编辑状态：GET edit-lease，读出修订号、正在编辑的人与能不能编辑，连同服务端回答的时刻（响应头 Date）', async () => {
    const api = installFakeApi({ [`GET ${LEASE}`]: () => json(200, STATUS, { date: 'Sun, 04 Oct 2026 03:03:10 GMT' }) })
    await expect(fetchEditStatus(DOCUMENT_ID)).resolves.toEqual({ status: STATUS, serverTime: Date.UTC(2026, 9, 4, 3, 3, 10) })
    api.on(`GET ${LEASE}`, () => json(200, STATUS))
    await expect(fetchEditStatus(DOCUMENT_ID)).resolves.toEqual({ status: STATUS, serverTime: undefined })
  })

  it('编辑状态没有能不能编辑（canEdit）：与契约不一致，ResponseFormatError', async () => {
    installFakeApi({ [`GET ${LEASE}`]: () => json(200, { revision: 3, editor: null }) })
    await expect(fetchEditStatus(DOCUMENT_ID)).rejects.toBeInstanceOf(ResponseFormatError)
  })

  it('另存为副本：POST conflict-copies，requestId 与标题在查询参数里（按 URL 的规则编码，解得回原样），请求体是 gzip 的快照（带 CSRF 令牌）；读出新文档的详情', async () => {
    const created = {
      id: '0199a2c4-1f2e-7a3b-8c4d-0000000000c1',
      title: '周报 A+B&C=D#1（冲突副本 2026-10-04 15:30）',
      type: 'sheet',
      createdAt: '2026-10-04T07:31:00.000Z',
      updatedAt: '2026-10-04T07:31:00.000Z',
      spaceId: '0199a2c4-1f2e-7a3b-8c4d-0000000000aa',
      space: { id: '0199a2c4-1f2e-7a3b-8c4d-0000000000aa', type: 'personal' },
      folderId: null,
      accessVia: 'space',
      revision: 1,
      profile: 'sheet@1',
      formatVersion: 1,
      sdkVersion: '1.0.1',
      formulasPending: false,
      permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: true, canCopy: true, canDelete: true, canShare: true, canTakeOver: true },
      replayed: false,
    }
    const query = { requestId: '0199a2c4-1f2e-4a3b-8c4d-0000000000d1', title: created.title, formulasPending: true }
    const compressed = new Uint8Array([31, 139, 8])
    let url: URL | undefined
    let init: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string, received?: RequestInit) => {
      url = new URL(input, 'http://127.0.0.1')
      init = received
      return json(201, created)
    }))
    setCsrfToken('csrf-4')
    await expect(saveConflictCopy(DOCUMENT_ID, query, compressed)).resolves.toEqual(created)
    expect(url?.pathname).toBe(`/api/documents/${DOCUMENT_ID}/conflict-copies`)
    // "公式待更新"与本页的构建与数据格式（M3-P3）一起在查询参数里
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({ requestId: query.requestId, title: query.title, formulasPending: 'true', ...PAGE_CLIENT_FORMAT, formatVersion: String(PAGE_CLIENT_FORMAT.formatVersion) })
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(compressed)
    expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({ 'content-type': 'application/gzip', 'x-csrf-token': 'csrf-4' })
  })

  it('另存为副本被拒绝：照常抛出（404 读不到、409 同一个 requestId 换了内容），由页面决定能不能再试', async () => {
    const path = `POST /api/documents/${DOCUMENT_ID}/conflict-copies?requestId=0199a2c4-1f2e-4a3b-8c4d-0000000000d1&title=%E5%91%A8%E6%8A%A5&formulasPending=false&${FORMAT_QUERY}`
    const api = installFakeApi({ [path]: () => apiError(404, 'NOT_FOUND') })
    const query = { requestId: '0199a2c4-1f2e-4a3b-8c4d-0000000000d1', title: '周报' }
    await expect(saveConflictCopy(DOCUMENT_ID, query, new Uint8Array([1]))).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    api.on(path, () => apiError(409, 'REQUEST_ID_CONFLICT'))
    await expect(saveConflictCopy(DOCUMENT_ID, query, new Uint8Array([1]))).rejects.toMatchObject({ status: 409, code: 'REQUEST_ID_CONFLICT' })
  })
})

describe('快照的摘要（自动保存会话内去重的键，M3-P4 设计 §3.7）', () => {
  it('UTF-8 字节的 SHA-256，十六进制小写（与标准的测试向量一致）', async () => {
    await expect(snapshotDigest('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    await expect(snapshotDigest('')).resolves.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('按 UTF-8 字节算：汉字与码点相同的内容摘要相同，差一个字就不同', async () => {
    const digest = await snapshotDigest('{"content":"甲"}')
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    await expect(snapshotDigest('{"content":"甲"}')).resolves.toBe(digest)
    await expect(snapshotDigest('{"content":"乙"}')).resolves.not.toBe(digest)
    // "甲"的 UTF-8 是 E7 94 B2：与按这三个字节算的一致
    const bytes = await crypto.subtle.digest('SHA-256', new Uint8Array([0xE7, 0x94, 0xB2]))
    await expect(snapshotDigest('甲')).resolves.toBe(Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join(''))
  })
})

import { beforeAll, describe, expect, it } from 'vitest'
import { documentDraftFactSchema, documentDraftFactsQuerySchema, documentDraftFactsResponseSchema } from '../index.ts'

const FIRST = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const SECOND = '0199a2c4-2a3b-7c4d-9e5f-6a7b8c9d0e1f'
const ids = Array.from({ length: 101 }, (_, index) => `0199a2c4-1f2e-7a3b-8c4d-${index.toString(16).padStart(12, '0')}`)

beforeAll(() => {
  expect(documentDraftFactsQuerySchema, '通过公共入口提供批量事实请求契约').toBeDefined()
  expect(documentDraftFactSchema).toBeDefined()
  expect(documentDraftFactsResponseSchema).toBeDefined()
})

describe('本机草稿的批量文档查询', () => {
  it('按 UUID 身份去重并保留首次出现顺序，响应匹配不受大小写影响', () => {
    expect(documentDraftFactsQuerySchema.parse({ ids: `${SECOND.toUpperCase()},${FIRST},${SECOND},${FIRST.toUpperCase()}` }))
      .toEqual({ ids: [SECOND, FIRST] })
    expect(documentDraftFactsQuerySchema.parse({ ids: FIRST })).toEqual({ ids: [FIRST] })
  })

  it('接受 100 项；101 项以及重复 101 次同一项仍然拒绝', () => {
    expect(documentDraftFactsQuerySchema.parse({ ids: ids.slice(0, 100).join(',') }).ids).toEqual(ids.slice(0, 100))
    expect(documentDraftFactsQuerySchema.safeParse({ ids: ids.join(',') }).success).toBe(false)
    expect(documentDraftFactsQuerySchema.safeParse({ ids: Array.from({ length: 101 }).fill(FIRST).join(',') }).success).toBe(false)
  })

  it.each([{}, { ids: '' }, { ids: `,${FIRST}` }, { ids: `${FIRST},` }, { ids: `${FIRST},,${SECOND}` }, { ids: ` ${FIRST}` }, { ids: `${FIRST}, ${SECOND}` }, { ids: 'not-an-id' }, { ids: [FIRST, SECOND] }, { ids: { id: FIRST } }, { ids: FIRST, force: true }, { ids: 'a'.repeat(3700) }])('拒绝畸形请求 %j', (query) => {
    expect(documentDraftFactsQuerySchema.safeParse(query).success).toBe(false)
  })
})

const accessible = { status: 'accessible', id: FIRST, title: '预算', type: 'sheet', canEdit: true, revision: 3, revisionSource: null, occupied: false }

describe('本机草稿的批量文档事实响应', () => {
  it('可读项保留所需事实；不可读项只保留 id 和状态，不接纳可能泄露的额外事实', () => {
    expect(documentDraftFactsResponseSchema.parse({ items: [accessible, { status: 'unavailable', id: SECOND, title: '秘密', revision: 9 }], future: true }))
      .toEqual({ items: [accessible, { status: 'unavailable', id: SECOND }] })
    expect(documentDraftFactSchema.parse({ ...accessible, future: true })).toEqual(accessible)
  })

  it('接受合法来源和只读文档，拒绝畸形来源', () => {
    const fact = { ...accessible, canEdit: false, occupied: true, revisionSource: { clientInstanceId: SECOND, localSeq: 0 } }
    expect(documentDraftFactSchema.parse(fact)).toEqual(fact)
    expect(documentDraftFactSchema.safeParse({ ...fact, revisionSource: { clientInstanceId: 'x', localSeq: 0 } }).success).toBe(false)
    expect(documentDraftFactSchema.safeParse({ ...fact, revisionSource: { clientInstanceId: SECOND, localSeq: -1 } }).success).toBe(false)
  })

  it.each(['title', 'type', 'canEdit', 'revision', 'revisionSource', 'occupied'] as const)('可读项的 %s 缺失不能猜测为默认事实', (key) => {
    const { [key]: _omitted, ...rest } = accessible
    expect(documentDraftFactSchema.safeParse(rest).success).toBe(false)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3'])('拒绝无效修订 %j', (revision) => {
    expect(documentDraftFactSchema.safeParse({ ...accessible, revision }).success).toBe(false)
  })

  it('未知状态、非法布尔值/类型/id、空列表与超额列表均是格式错误', () => {
    for (const changes of [{ status: 'future' }, { canEdit: 'true' }, { occupied: 0 }, { type: 'slide' }, { id: 'unknown' }])
      expect(documentDraftFactSchema.safeParse({ ...accessible, ...changes }).success).toBe(false)
    expect(documentDraftFactsResponseSchema.safeParse({ items: [] }).success).toBe(false)
    const items = ids.map(id => ({ status: 'unavailable', id }))
    expect(documentDraftFactsResponseSchema.safeParse({ items: items.slice(0, 100) }).success).toBe(true)
    expect(documentDraftFactsResponseSchema.safeParse({ items }).success).toBe(false)
  })

  it('一个 id 不能得到两项相互矛盾的事实，包括大小写变体', () => {
    expect(documentDraftFactsResponseSchema.safeParse({ items: [accessible, { status: 'unavailable', id: FIRST }] }).success).toBe(false)
    expect(documentDraftFactsResponseSchema.safeParse({ items: [accessible, { status: 'unavailable', id: FIRST.toUpperCase() }] }).success).toBe(false)
  })
})

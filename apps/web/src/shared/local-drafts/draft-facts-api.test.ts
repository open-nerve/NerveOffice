import { describe, expect, it, vi } from 'vitest'
import { NetworkError, ResponseFormatError } from '../api/index.ts'
import { installFakeApi, json, networkFailure } from '../testing/fake-api.test-support.ts'
import { readDraftFacts } from './draft-facts-api.ts'

const ids = Array.from({ length: 101 }, (_, n) => `0199b0c4-7d3e-7a3b-9c4e-${String(n).padStart(12, '0')}`)
const route = (values: readonly string[]) => `GET /api/documents/draft-facts?${new URLSearchParams({ ids: values.join(',') })}`
const unavailable = (id: string) => ({ id, status: 'unavailable' })

describe('当前用户的批量草稿事实', () => {
  it('空目录不请求，重复 ID 去重；101 个不同 ID 串行分成 100 和 1', async () => {
    const first = ids.slice(0, 100)
    const last = ids.slice(100)
    let release!: (response: Response) => void
    const held = new Promise<Response>((resolve) => {
      release = resolve
    })
    const api = installFakeApi({
      [route(first)]: async () => held,
      [route(last)]: () => json(200, { items: last.map(unavailable) }),
    })
    expect(await readDraftFacts([])).toEqual(new Map())
    expect(api.requests).toHaveLength(0)
    const reading = readDraftFacts([...ids, ids[0]!])
    await vi.waitFor(() => expect(api.requests).toHaveLength(1))
    release(json(200, { items: first.map(unavailable).reverse() }))
    const facts = await reading
    expect(api.requests.map(request => request.key)).toEqual([route(first), route(last)])
    expect([...facts.keys()]).toEqual(ids)
    expect(facts.get(ids[100]!)).toEqual(unavailable(ids[100]!))
  })

  it.each(['缺失', '额外', '重复', '非法结构'])('拒绝%s的结果，不能把缺项当成不可读', async (kind) => {
    const requested = ids.slice(0, 2)
    const items = kind === '缺失'
      ? [unavailable(ids[0]!)]
      : kind === '额外'
        ? [...requested, ids[2]!].map(unavailable)
        : kind === '重复'
          ? [ids[0]!, ids[0]!].map(unavailable)
          : [{ id: ids[0], status: 'accessible' }, unavailable(ids[1]!)]
    installFakeApi({ [route(requested)]: () => json(200, { items }) })
    await expect(readDraftFacts(requested)).rejects.toBeInstanceOf(ResponseFormatError)
  })

  it('仅透传经契约校验的可读元数据，失败仍是未知网络结果', async () => {
    const id = ids[0]!
    const fact = { id, status: 'accessible', title: '本人的表格', type: 'sheet', canEdit: false, revision: 3, revisionSource: null, occupied: true }
    const api = installFakeApi({ [route([id])]: () => json(200, { items: [{ ...fact, secret: '不交给目录' }] }) })
    expect((await readDraftFacts([id])).get(id)).toEqual(fact)
    api.on(route([id]), networkFailure)
    await expect(readDraftFacts([id])).rejects.toBeInstanceOf(NetworkError)
  })
})

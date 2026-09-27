import { describe, expect, it } from 'vitest'
import { revisionConflictDetailsSchema, revisionEtag, revisionFromEtag, saveContentQuerySchema, saveContentResponseSchema } from './content.ts'

const valid = {
  baseRevision: '3',
  requestId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d',
  clientInstanceId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0e',
  localSeq: '0',
}

describe('保存的查询参数', () => {
  it('数字字符串转成整数', () => {
    expect(saveContentQuerySchema.parse(valid)).toEqual({ ...valid, baseRevision: 3, localSeq: 0 })
    expect(saveContentQuerySchema.parse({ ...valid, baseRevision: '2147483647', localSeq: '2147483647' })).toMatchObject({ baseRevision: 2_147_483_647, localSeq: 2_147_483_647 })
  })

  it.each(['', ' 1', '+1', '-1', '1.0', '1e3', '0x10', '01', '2147483648', '99999999999'])('整数的写法不合规时拒绝：%j', (value) => {
    expect(saveContentQuerySchema.safeParse({ ...valid, localSeq: value }).success).toBe(false)
    expect(saveContentQuerySchema.safeParse({ ...valid, baseRevision: value }).success).toBe(false)
  })

  it('基准修订号从 1 开始，本地序号从 0 开始', () => {
    expect(saveContentQuerySchema.safeParse({ ...valid, baseRevision: '0' }).success).toBe(false)
    expect(saveContentQuerySchema.safeParse({ ...valid, localSeq: '0' }).success).toBe(true)
  })

  it('四项都必填，不接受多余的参数', () => {
    for (const key of Object.keys(valid)) {
      const { [key as keyof typeof valid]: _omitted, ...rest } = valid
      expect(saveContentQuerySchema.safeParse(rest).success, key).toBe(false)
    }
    expect(saveContentQuerySchema.safeParse({ ...valid, force: '1' }).success).toBe(false)
    expect(saveContentQuerySchema.safeParse({ ...valid, requestId: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('保存的结果与冲突的详情', () => {
  it('保存成功：修订号与 UTC 时间', () => {
    expect(saveContentResponseSchema.safeParse({ revision: 4, savedAt: '2026-09-27T08:00:00.000Z' }).success).toBe(true)
    expect(saveContentResponseSchema.safeParse({ revision: 0, savedAt: '2026-09-27T08:00:00.000Z' }).success).toBe(false)
  })

  it('冲突的来源：保存产生的修订有来源，新建产生的修订为 null', () => {
    expect(revisionConflictDetailsSchema.parse({ currentRevision: 1, source: null })).toEqual({ currentRevision: 1, source: null })
    const source = { clientInstanceId: valid.clientInstanceId, localSeq: 12 }
    expect(revisionConflictDetailsSchema.parse({ currentRevision: 5, source })).toEqual({ currentRevision: 5, source })
    expect(revisionConflictDetailsSchema.safeParse({ currentRevision: 5 }).success).toBe(false)
  })
})

describe('内容的 ETag', () => {
  it('修订号加引号，能取回', () => {
    expect(revisionEtag(7)).toBe('"7"')
    expect(revisionFromEtag(revisionEtag(7))).toBe(7)
    expect(revisionFromEtag('"2147483647"')).toBe(2_147_483_647)
  })

  it('反向代理改成的弱校验器：修订号不变', () => {
    expect(revisionFromEtag('W/"7"')).toBe(7)
  })

  it.each([null, undefined, '', '7', 'w/"7"', 'W/7', 'W/ "7"', ' "7"', '"0"', '"07"', '"-1"', '"1.5"', '"2147483648"', 'W/"2147483648"', '"abc"'])('不是修订号的 ETag：%j', (etag) => {
    expect(revisionFromEtag(etag)).toBeUndefined()
  })
})

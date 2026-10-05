import { describe, expect, it } from 'vitest'
import { revisionConflictDetailsSchema, revisionEtag, revisionFromEtag, revisionSourceSchema, saveContentQuerySchema, saveContentResponseSchema, SNAPSHOT_MAX_RAW_BYTES, SNAPSHOT_WARN_RAW_BYTES } from './content.ts'

const valid = {
  baseRevision: '3',
  requestId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d',
  clientInstanceId: '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0e',
  localSeq: '0',
  writeEpoch: '4',
}

describe('保存的查询参数', () => {
  it('数字字符串转成整数', () => {
    expect(saveContentQuerySchema.parse(valid)).toEqual({ ...valid, baseRevision: 3, localSeq: 0, writeEpoch: 4 })
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

  it('五项都必填，不接受多余的参数', () => {
    for (const key of Object.keys(valid)) {
      const { [key as keyof typeof valid]: _omitted, ...rest } = valid
      expect(saveContentQuerySchema.safeParse(rest).success, key).toBe(false)
    }
    expect(saveContentQuerySchema.safeParse({ ...valid, force: '1' }).success).toBe(false)
    expect(saveContentQuerySchema.safeParse({ ...valid, requestId: 'not-a-uuid' }).success).toBe(false)
  })

  it('M3-P3："公式待更新"可选，只接受 true、false（没有这个参数等于 false）', () => {
    expect(saveContentQuerySchema.parse({ ...valid, formulasPending: 'true' })).toMatchObject({ formulasPending: true })
    expect(saveContentQuerySchema.parse({ ...valid, formulasPending: 'false' })).toMatchObject({ formulasPending: false })
    expect(saveContentQuerySchema.parse(valid).formulasPending).toBeUndefined()
    for (const value of ['', '1', '0', 'TRUE', 'yes'])
      expect(saveContentQuerySchema.safeParse({ ...valid, formulasPending: value }).success, value).toBe(false)
  })

  it('M3-P3：客户端的构建与数据格式都可选——P3 之前的页面不带它们，重试结果未知的保存时要能到得了重放（设计 §3.1 第 3 步）', () => {
    const reported = { clientBuild: '0.1.0+abc1234', univerVersion: '1.0.1', profile: 'sheet@1', formatVersion: '1' }
    expect(saveContentQuerySchema.parse({ ...valid, ...reported })).toEqual({ ...valid, ...reported, baseRevision: 3, localSeq: 0, writeEpoch: 4, formatVersion: 1 })
    expect(saveContentQuerySchema.parse(valid)).toEqual({ baseRevision: 3, requestId: valid.requestId, clientInstanceId: valid.clientInstanceId, localSeq: 0, writeEpoch: 4 })
    expect(saveContentQuerySchema.safeParse({ ...valid, formatVersion: '01' }).success).toBe(false)
    expect(saveContentQuerySchema.safeParse({ ...valid, clientBuild: 'abc' }).success).toBe(false)
  })

  it('申请编辑权得到的代次（M3-P1）：写法同本地序号，从 0 开始的整数', () => {
    expect(saveContentQuerySchema.parse({ ...valid, writeEpoch: '0' })).toMatchObject({ writeEpoch: 0 })
    expect(saveContentQuerySchema.parse({ ...valid, writeEpoch: '2147483647' })).toMatchObject({ writeEpoch: 2_147_483_647 })
    for (const value of ['', '-1', '1.0', '01', '0x10', '2147483648'])
      expect(saveContentQuerySchema.safeParse({ ...valid, writeEpoch: value }).success, value).toBe(false)
  })
})

describe('容量', () => {
  it('上限 5 MiB；达到 80%（4,194,304 字节）时页面提示（US-M3-14）', () => {
    expect(SNAPSHOT_MAX_RAW_BYTES).toBe(5_242_880)
    expect(SNAPSHOT_WARN_RAW_BYTES).toBe(4_194_304)
    expect(SNAPSHOT_WARN_RAW_BYTES / SNAPSHOT_MAX_RAW_BYTES).toBe(0.8)
  })
})

describe('保存的结果与冲突的详情', () => {
  it('保存成功：修订号与 UTC 时间', () => {
    expect(saveContentResponseSchema.safeParse({ revision: 4, savedAt: '2026-09-27T08:00:00.000Z', unchanged: false }).success).toBe(true)
    expect(saveContentResponseSchema.safeParse({ revision: 0, savedAt: '2026-09-27T08:00:00.000Z', unchanged: false }).success).toBe(false)
  })

  it('M3-P3：内容相同不递增时 unchanged 为真（修订号与时间是当前修订的）；必填的布尔值，多出的字段被丢弃', () => {
    const saved = { revision: 4, savedAt: '2026-09-27T08:00:00.000Z', unchanged: true }
    expect(saveContentResponseSchema.parse({ ...saved, digest: 'x' })).toEqual(saved)
    expect(saveContentResponseSchema.safeParse({ revision: 4, savedAt: saved.savedAt }).success).toBe(false)
    expect(saveContentResponseSchema.safeParse({ ...saved, unchanged: 'true' }).success).toBe(false)
  })

  it('冲突的来源：保存产生的修订有来源，新建产生的修订为 null', () => {
    expect(revisionConflictDetailsSchema.parse({ currentRevision: 1, source: null })).toEqual({ currentRevision: 1, source: null })
    const source = { clientInstanceId: valid.clientInstanceId, localSeq: 12 }
    expect(revisionConflictDetailsSchema.parse({ currentRevision: 5, source })).toEqual({ currentRevision: 5, source })
    expect(revisionConflictDetailsSchema.safeParse({ currentRevision: 5 }).success).toBe(false)
  })

  it('修订的来源（冲突的详情与申请编辑权的响应共用）：标签页是 UUID，本地序号是不小于 0 的整数', () => {
    const source = { clientInstanceId: valid.clientInstanceId, localSeq: 0 }
    expect(revisionSourceSchema.parse(source)).toEqual(source)
    for (const invalid of [{ ...source, clientInstanceId: 'tab-1' }, { ...source, localSeq: -1 }, { ...source, localSeq: 1.5 }, { clientInstanceId: source.clientInstanceId }])
      expect(revisionSourceSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    expect(revisionConflictDetailsSchema.safeParse({ currentRevision: 5, source: { ...source, localSeq: -1 } }).success).toBe(false)
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

import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, USER_ID } from './draft-record.test-support.ts'
import { readRecoveryNotice } from './recovery-notice.ts'

const NOTICE = { userId: USER_ID, documentId: DOCUMENT_ID, kind: 'restored', at: NOW } as const

describe('比对镜像留下的提示：库里读出的一条（M4-P1 设计 §3.8）', () => {
  it('两种提示都认得；只交回约定的字段', () => {
    expect(readRecoveryNotice(NOTICE)).toEqual(NOTICE)
    expect(readRecoveryNotice({ ...NOTICE, kind: 'lost', at: 0 })).toEqual({ ...NOTICE, kind: 'lost', at: 0 })
    expect(readRecoveryNotice({ ...NOTICE, extra: 1 })).toEqual(NOTICE)
  })

  it('形状不对的当作没有：不是对象、键是空的或不是字符串、种类认不出、时刻不是不小于 0 的安全整数', () => {
    for (const value of [
      null,
      'restored',
      [NOTICE],
      { ...NOTICE, userId: '' },
      { ...NOTICE, documentId: 7 },
      { ...NOTICE, kind: 'other' },
      { ...NOTICE, kind: undefined },
      { ...NOTICE, at: -1 },
      { ...NOTICE, at: 1.5 },
      { ...NOTICE, at: '1' },
    ])
      expect(readRecoveryNotice(value), JSON.stringify(value)).toBeUndefined()
  })
})

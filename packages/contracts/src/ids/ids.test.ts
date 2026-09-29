import { describe, expect, it } from 'vitest'
import { uuidSchema } from './ids.ts'

describe('请求里的 UUID', () => {
  const ID = '0192f0c8-0000-7000-8000-00000000abcd'

  it('大小写都接受，统一转成小写', () => {
    expect(uuidSchema.parse(ID)).toBe(ID)
    expect(uuidSchema.parse(ID.toUpperCase())).toBe(ID)
    expect(uuidSchema.parse('0192F0C8-0000-7000-8000-00000000aBcD')).toBe(ID)
  })

  it('不是 UUID 的拒绝', () => {
    for (const value of ['', 'abc', `${ID}0`, ID.replaceAll('-', ''), ` ${ID}`, `{${ID}}`])
      expect(uuidSchema.safeParse(value).success).toBe(false)
  })
})

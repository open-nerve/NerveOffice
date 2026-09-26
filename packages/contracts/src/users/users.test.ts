import { describe, expect, it } from 'vitest'
import { displayNameSchema, newPasswordSchema, normalizeUsername, usernameSchema } from './users.ts'

describe('用户名', () => {
  it('规范化：去掉首尾空白，转成小写', () => {
    expect(normalizeUsername('  Zhang.San ')).toBe('zhang.san')
    expect(usernameSchema.parse(' Admin ')).toBe('admin')
  })

  it.each(['abc', 'a.b', 'user_01', 'x-y-z', '9lives', 'a'.repeat(32)])('合规：%s', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(true)
  })

  it.each(['ab', 'a'.repeat(33), '.abc', '_abc', 'a b', '张三', 'user@x', 'İstanbul', ''])('不合规：%s', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false)
  })
})

describe('显示名', () => {
  it('去掉首尾空白；按码点计长度，表情符号算一个字符', () => {
    expect(displayNameSchema.parse('  张三 ')).toBe('张三')
    expect(displayNameSchema.safeParse('😀'.repeat(64)).success).toBe(true)
    expect(displayNameSchema.safeParse('😀'.repeat(65)).success).toBe(false)
  })

  it('不能为空，不能含控制字符', () => {
    expect(displayNameSchema.safeParse('   ').success).toBe(false)
    expect(displayNameSchema.safeParse('张\u0000三').success).toBe(false)
    expect(displayNameSchema.safeParse('张\n三').success).toBe(false)
  })
})

describe('设置密码的规则', () => {
  it('12–256 个字符，不要求字符种类', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(12)).success).toBe(true)
    expect(newPasswordSchema.safeParse('一二三四五六七八九十甲乙').success).toBe(true)
    expect(newPasswordSchema.safeParse('a'.repeat(11)).success).toBe(false)
    expect(newPasswordSchema.safeParse('a'.repeat(257)).success).toBe(false)
  })
})

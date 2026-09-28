import { describe, expect, it } from 'vitest'
import { containsPattern } from './like-pattern.ts'

describe('包含关键词的 LIKE 模式', () => {
  it('前后加通配符', () => {
    expect(containsPattern('张')).toBe('%张%')
  })

  it('关键词里的 %、_、\\ 按字面匹配', () => {
    expect(containsPattern('50%')).toBe('%50\\%%')
    expect(containsPattern('a_b')).toBe('%a\\_b%')
    expect(containsPattern('a\\b')).toBe('%a\\\\b%')
  })
})

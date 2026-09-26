import { describe, expect, it } from 'vitest'
import { checkJsonLimits, JSON_MAX_DEPTH, JSON_MAX_ENTRIES } from './json-limits.ts'

function nested(depth: number): unknown {
  let value: unknown = 1
  for (let level = 0; level < depth; level++)
    value = level % 2 === 0 ? [value] : { next: value }
  return value
}

describe('checkJsonLimits', () => {
  it('原始值与空容器没有问题', () => {
    for (const value of [undefined, null, 1, 'x', true, {}, []])
      expect(checkJsonLimits(value)).toBeUndefined()
  })

  it(`嵌套刚好 ${JSON_MAX_DEPTH} 层可以，多一层不行`, () => {
    expect(checkJsonLimits(nested(JSON_MAX_DEPTH))).toBeUndefined()
    expect(checkJsonLimits(nested(JSON_MAX_DEPTH + 1))).toBe('depth')
  })

  it(`元素（对象的键加数组的项）刚好 ${JSON_MAX_ENTRIES} 个可以，多一个不行`, () => {
    expect(checkJsonLimits(Array.from({ length: JSON_MAX_ENTRIES }).fill(0))).toBeUndefined()
    expect(checkJsonLimits(Array.from({ length: JSON_MAX_ENTRIES + 1 }).fill(0))).toBe('entries')
    const object = Object.fromEntries(Array.from({ length: JSON_MAX_ENTRIES / 2 }, (_, index) => [`k${index}`, [0]]))
    expect(checkJsonLimits(object)).toBeUndefined()
    expect(checkJsonLimits({ ...object, extra: [0] })).toBe('entries')
  })

  it('嵌套再深也不会爆栈', () => {
    expect(checkJsonLimits(nested(100_000))).toBe('depth')
  })

  it('可以传入别的上限', () => {
    expect(checkJsonLimits({ a: { b: 1 } }, { maxDepth: 1, maxEntries: 10 })).toBe('depth')
    expect(checkJsonLimits([1, 2, 3], { maxDepth: 5, maxEntries: 2 })).toBe('entries')
  })
})

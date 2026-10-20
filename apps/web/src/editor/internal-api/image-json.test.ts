import { JSON1 } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { pureImageOperation } from './image-json.ts'

describe('JSON1 预演前的数据预算与纯子类型边界', () => {
  it.each([10, 100_001])('长度 %i 的稀疏操作不能交给 SDK 遍历', (length) => {
    const op: unknown[] = []
    op.length = length
    op[0] = 'book'
    const sdk = vi.spyOn(JSON1.type, 'checkValidOp')
    try {
      expect(pureImageOperation(op)).toBe(false)
      expect(sdk).not.toHaveBeenCalled()
    }
    finally {
      sdk.mockRestore()
    }
  })

  it('未知与 TextX 子类型、访问器和循环在 SDK apply 之前拒绝', () => {
    const get = vi.fn(() => 1)
    const property = Object.defineProperty({}, 'i', { get, enumerable: true })
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    for (const op of [['body', { et: 'text-x', e: [] }], ['value', { et: 'unknown', e: [] }], ['value', property], cyclic])
      expect(pureImageOperation(op)).toBe(false)
    expect(get).not.toHaveBeenCalled()
  })
})

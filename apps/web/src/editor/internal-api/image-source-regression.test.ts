import { Image as DrawingImage } from '@univerjs/engine-render'
import { describe, expect, it } from 'vitest'

describe('SDK 图元换源不修改另一张图共用的缓存元素', () => {
  it('共享同一原件的两张图，改变一张只换掉它自己的元素', () => {
    const original = document.createElement('img')
    original.src = 'blob:https://app.test/original'
    const first = new DrawingImage('first', { image: original, width: 120, height: 80 })
    const second = new DrawingImage('second', { image: original, width: 120, height: 80 })
    try {
      first.changeSource('blob:https://app.test/replacement')
      expect(first.getNative()?.src).toBe('blob:https://app.test/replacement')
      expect(second.getNative()?.src).toBe('blob:https://app.test/original')
      expect(first.getNative()).not.toBe(original)
      const replacement = first.getNative()
      first.changeSource('blob:https://app.test/replacement')
      expect(first.getNative()).toBe(replacement)
    }
    finally {
      first.dispose()
      second.dispose()
    }
  })
})

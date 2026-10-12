import { describe, expect, it, vi } from 'vitest'
import { RELOAD_MARKER, RELOAD_STORAGE_KEY, reloadStorage } from './reload-marker.test-support.ts'
import { clearInheritedReloadMarkers } from './reload-marker.ts'

describe('旧版恢复记号的迁移清理', () => {
  it('同步清掉所有旧记号，包括合法、损坏和不同文档；保留其他命名空间', () => {
    const storage = reloadStorage(new Map([
      [RELOAD_STORAGE_KEY, JSON.stringify({ v: 1, ...RELOAD_MARKER })],
      ['nerve-office:reload:another-user:another-document', '{'],
      ['nerve-office:reload:unknown-version', 'v2'],
      ['nerve-office:pending-save:document', '待确认请求'],
      ['nerve-office:issued-request:document', '编辑请求'],
      ['nerve-office:reload-other', '无关值'],
    ]))
    const read = vi.spyOn(storage, 'getItem')
    clearInheritedReloadMarkers(() => storage)
    expect([...storage.items]).toEqual([
      ['nerve-office:pending-save:document', '待确认请求'],
      ['nerve-office:issued-request:document', '编辑请求'],
      ['nerve-office:reload-other', '无关值'],
    ])
    expect(read).not.toHaveBeenCalled()
  })

  it('只清本标签页，复制的会话存储互不影响', () => {
    const original = reloadStorage(new Map([[RELOAD_STORAGE_KEY, JSON.stringify({ v: 1, ...RELOAD_MARKER })]]))
    const copy = reloadStorage(original.items)
    clearInheritedReloadMarkers(() => copy)
    expect(copy.items.size).toBe(0)
    expect(original.items.size).toBe(1)
    clearInheritedReloadMarkers(() => copy)
    expect(copy.items.size).toBe(0)
  })

  it.each(['access', 'length', 'key', 'remove'] as const)('存储 %s 被拒绝时不阻断页面，也不读取旧身份', (failure) => {
    const fail = (): never => {
      throw new Error('storage denied')
    }
    const storage = reloadStorage(new Map([[RELOAD_STORAGE_KEY, '{}']]))
    const read = vi.spyOn(storage, 'getItem')
    if (failure === 'length')
      Object.defineProperty(storage, 'length', { get: fail })
    if (failure === 'key')
      storage.key = fail
    if (failure === 'remove')
      Object.defineProperty(storage, 'removeItem', { value: fail })
    expect(() => clearInheritedReloadMarkers(failure === 'access' ? fail : () => storage)).not.toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})

import type { ReloadStorage } from '../reload-marker.ts'
import { describe, expect, it } from 'vitest'
import { RELOAD_MARKER as marker, reloadStorage, RELOAD_STORAGE_KEY as storageKey } from '../reload-marker.test-support.ts'
import { clearInheritedReloadMarkers } from '../reload-marker.ts'
import { observeReloadStart } from './reload-diagnostics.ts'

const navigation = () => ({ timeOrigin: 100, type: 'navigate' as const, discarded: 'unsupported' as const, key: marker.clientInstanceId, id: marker.writerId, activation: null, fromKey: null, fromId: null })
const storage = () => reloadStorage(new Map([[storageKey, JSON.stringify({ v: 1, ...marker })]]))

describe('启动诊断只读观察导航与旧记号', () => {
  it('捕获同步清理前的合法旧记号；诊断本身不写、不清，也不选择身份', () => {
    const s = storage()
    const observed = observeReloadStart(() => s, navigation)
    expect(s.items.size).toBe(1)
    clearInheritedReloadMarkers(() => s)
    expect(observed.snapshot()).toMatchObject({ initial: { navigation: { key: marker.clientInstanceId }, storage: { status: 'available', markers: [marker] } }, current: { storage: { markers: [] } }, events: [], truncated: false })
    const copy = observed.snapshot()
    Object.defineProperty(copy.initial.storage, 'markers', { value: [] })
    expect(observed.snapshot().initial.storage.markers).toEqual([marker])
  })

  it('不收录原始坏值或额外字段，存储与导航异常也不影响启动', () => {
    const s = storage()
    s.items.set(storageKey, JSON.stringify({ v: 1, ...marker, secret: 'never-export' }))
    const observed = observeReloadStart(() => s, navigation)
    expect(observed.snapshot().initial.storage).toEqual({ status: 'available', markers: [], invalid: 1, truncated: false })
    expect(JSON.stringify(observed.snapshot())).not.toContain('never-export')
    expect(s.items.size).toBe(1)
    const blockedStorage = (): ReloadStorage => {
      throw new Error('storage denied')
    }
    const unavailable = observeReloadStart(blockedStorage, () => {
      throw new Error('navigation denied')
    })
    expect(unavailable.snapshot().initial).toEqual({ navigation: null, storage: { status: 'unavailable', markers: [], invalid: 0, truncated: false } })
  })

  it('单条存储读取被拒绝报告为不可读，不能误记成坏记号', () => {
    const observed = observeReloadStart(() => ({ ...storage(), getItem: () => {
      throw new Error('denied')
    } }), navigation)
    expect(observed.snapshot().initial.storage).toEqual({ status: 'unavailable', markers: [], invalid: 0, truncated: false })
  })

  it('限制枚举数量和导出的记号数量，截断要明确报告', () => {
    const s = storage()
    for (let n = 0; n < 70; n++) {
      const documentId = `0199a2c4-1f2e-7a3b-8c4d-${String(n).padStart(12, '0')}`
      s.items.set(`nerve-office:reload:${marker.userId}:${documentId}`, JSON.stringify({ v: 1, ...marker, documentId }))
    }
    const observed = observeReloadStart(() => s, navigation)
    expect(observed.snapshot().initial.storage).toMatchObject({ status: 'available', truncated: true, invalid: 0 })
    expect(observed.snapshot().initial.storage.markers).toHaveLength(4)
    expect(s.items.size).toBe(70)
  })
})

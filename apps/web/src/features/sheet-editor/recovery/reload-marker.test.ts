import type { MarkerStorage } from '../pending-save-marker.ts'
import { describe, expect, it } from 'vitest'
import { FRESH_INSTANCE, RELOAD_KEY, RELOAD_MARKER, reloadStorage } from './reload-marker.test-support.ts'
import { reloadMarker, reloadMarkerKey } from './reload-marker.ts'

describe('自动重载的非敏感身份记号', () => {
  it('URL 中合法的大写 UUID 与小写指向同一记号，写读往返归一化', () => {
    const storage = reloadStorage()
    const upper = { userId: RELOAD_KEY.userId.toUpperCase(), documentId: RELOAD_KEY.documentId.toUpperCase() }
    const marker = reloadMarker(upper, { storage: () => storage })
    marker.write({ ...RELOAD_MARKER, clientInstanceId: RELOAD_MARKER.clientInstanceId.toUpperCase(), writerId: RELOAD_MARKER.writerId.toUpperCase() })
    expect(marker.read()).toEqual(RELOAD_MARKER)
    expect(reloadMarker(RELOAD_KEY, { storage: () => storage }).read()).toEqual(RELOAD_MARKER)
    marker.clear()
    expect(storage.items.size).toBe(0)
  })

  it('只写版本、用户、文档、实例与写入者身份；每个用户/文档隔离，清除只影响当前键', () => {
    const storage = reloadStorage()
    const marker = reloadMarker(RELOAD_KEY, { storage: () => storage })
    const otherKey = { ...RELOAD_KEY, documentId: FRESH_INSTANCE }
    const other = reloadMarker(otherKey, { storage: () => storage })
    const otherUser = reloadMarker({ ...RELOAD_KEY, userId: FRESH_INSTANCE }, { storage: () => storage })
    expect(marker.read()).toBeUndefined()
    // 即使调用者对象附带内部值，写入也必须投影到非敏感字段。
    const internal = { ...RELOAD_MARKER, token: '不能入库', key: '不能入库', body: '不能入库' }
    marker.write(internal)
    expect(JSON.parse(storage.items.get(reloadMarkerKey(RELOAD_KEY)) ?? 'null')).toEqual({ v: 1, ...RELOAD_MARKER })
    expect(marker.read()).toEqual(RELOAD_MARKER)
    expect(other.read()).toBeUndefined()
    expect(otherUser.read()).toBeUndefined()
    other.write(RELOAD_MARKER)
    otherUser.write(RELOAD_MARKER)
    marker.clear()
    expect(marker.read()).toBeUndefined()
    expect(other.read()).toEqual({ ...RELOAD_MARKER, ...otherKey })
    expect(otherUser.read()).toEqual({ ...RELOAD_MARKER, userId: FRESH_INSTANCE })
    expect(storage.items.size).toBe(2)
  })

  it.each([
    ['损坏 JSON', '{'],
    ['null', 'null'],
    ['数组', '[]'],
    ['未知版本', JSON.stringify({ v: 2, ...RELOAD_MARKER })],
    ['缺少字段', JSON.stringify({ v: 1, ...RELOAD_MARKER, writerId: undefined })],
    ['额外字段', JSON.stringify({ v: 1, ...RELOAD_MARKER, token: '多余' })],
    ...['userId', 'documentId', 'clientInstanceId', 'writerId'].map(field => [`错误 UUID ${field}`, JSON.stringify({ v: 1, ...RELOAD_MARKER, [field]: 'broken' })]),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7'].map(epoch => [`错误代次 ${epoch}`, JSON.stringify({ v: 1, ...RELOAD_MARKER, writeEpoch: epoch })]),
    ['不属于当前用户', JSON.stringify({ v: 1, ...RELOAD_MARKER, userId: FRESH_INSTANCE })],
    ['不属于当前文档', JSON.stringify({ v: 1, ...RELOAD_MARKER, documentId: FRESH_INSTANCE })],
  ])('%s 不能授予资格', (_case, raw) => {
    const storage = reloadStorage()
    storage.setItem(reloadMarkerKey(RELOAD_KEY), raw ?? '')
    expect(reloadMarker(RELOAD_KEY, { storage: () => storage }).read()).toBeUndefined()
  })

  it('UUID 统一为小写，新的持久身份替换旧身份；拒绝写入不合法的代次', () => {
    const storage = reloadStorage()
    const marker = reloadMarker(RELOAD_KEY, { storage: () => storage })
    marker.write({ ...RELOAD_MARKER, clientInstanceId: FRESH_INSTANCE.toUpperCase(), writeEpoch: 8 })
    expect(marker.read()).toEqual({ ...RELOAD_MARKER, clientInstanceId: FRESH_INSTANCE, writeEpoch: 8 })
    marker.write({ ...RELOAD_MARKER, writeEpoch: Number.POSITIVE_INFINITY })
    expect(marker.read()).toEqual({ ...RELOAD_MARKER, clientInstanceId: FRESH_INSTANCE, writeEpoch: 8 })
  })

  it.each(['access', 'operations'] as const)('存储 %s 抛错时不抛到页面、不返回身份', (failure) => {
    const fail = (): never => {
      throw new Error('storage unavailable')
    }
    const broken: MarkerStorage = { getItem: fail, setItem: fail, removeItem: fail }
    const marker = reloadMarker(RELOAD_KEY, { storage: failure === 'access' ? fail : () => broken })
    expect(marker.read()).toBeUndefined()
    expect(() => marker.write(RELOAD_MARKER)).not.toThrow()
    expect(() => marker.clear()).not.toThrow()
  })
})

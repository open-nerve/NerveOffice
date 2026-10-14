import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLegacySessionMarkers, clearLegacyStorage } from './legacy-storage.ts'

/** 仅替代浏览器的存储事件；真实 IDB blocked/释放在三浏览器故事里验证。 */
function database() {
  const requests: (EventTarget & { readonly error: Error | null })[] = []
  const names: string[] = []
  const factory = {
    deleteDatabase: (name: string) => {
      names.push(name)
      const request = Object.assign(new EventTarget(), { error: new Error('delete failed') })
      requests.push(request)
      return request as unknown as IDBOpenDBRequest
    },
  }
  return { factory, requests, names }
}

function setup() {
  const db = database()
  const options = { localStorage: () => localStorage, sessionStorage: () => sessionStorage, indexedDB: () => db.factory, timeoutMs: 100 }
  return { db, options }
}

/** Storage 的删除允许重排剩余键；jsdom 恰好保持插入顺序，不能单靠它验证枚举。 */
function reorderedStorage(first: string) {
  const keys = [first, 'unrelated-1', 'nerve-office:reload:old', 'unrelated-2']
  return {
    get length() { return keys.length },
    key: (index: number) => keys[index] ?? null,
    removeItem: (key: string) => {
      const index = keys.indexOf(key)
      if (index !== -1) {
        keys.splice(index, 1)
        keys.reverse()
      }
    },
    remaining: () => keys.toSorted(),
  }
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.useRealTimers()
})

describe('旧数据只按清单清理', () => {
  it('删除会重排 Storage 索引时仍清全本人记号，保留无关项', async () => {
    const t = setup()
    const local = reorderedStorage('nerve-office:pending-save:u1:d1')
    const session = reorderedStorage('nerve-office:pending-save:u1:d1')
    const result = clearLegacyStorage('u1', { ...t.options, localStorage: () => local, sessionStorage: () => session })
    t.db.requests[0]?.dispatchEvent(new Event('success'))
    expect(await result).toEqual({ kind: 'cleared' })
    expect(local.remaining()).toEqual(['unrelated-1', 'unrelated-2'])
    expect(session.remaining()).toEqual(['unrelated-1', 'unrelated-2'])
  })

  it('启动清退役意图也不依赖删除后的 Storage 索引顺序', () => {
    const session = reorderedStorage('nerve-office:edit-request:old')
    clearLegacySessionMarkers(session)
    expect(session.remaining()).toEqual(['unrelated-1', 'unrelated-2'])
  })

  it('删除本人和无归属旧键，保留其他账户、近似键及其他数据库；不读取任何值', async () => {
    const t = setup()
    const removed = [
      'nerve-office:pending-save:u1:d1',
      'nerve-office:pending-save:u1:d2',
      'nerve-office:pending-save:old-document',
      'nerve-office:reload:old',
      'nerve-office:edit-request:old',
      'UniverLocalStorage/preferences',
      'UniverLocalStorage/recent',
      'univer-mobile-recent-formula-functions',
    ]
    const kept = ['nerve-office:pending-save:u2:d1', 'nerve-office:pending-save:u11:d1', 'nerve-office:pending-save:u3:', 'nerve-office:pending-save:', 'nerve-office:pending-save-other', 'UniverLocalStorage', 'UniverLocalStorage-other/key', 'univer-mobile-recent-formula-functions-other', 'unrelated']
    for (const key of [...removed, ...kept]) {
      localStorage.setItem(key, 'unchanged')
      sessionStorage.setItem(key, 'unchanged')
    }
    const read = vi.spyOn(Storage.prototype, 'getItem')
    const pending = clearLegacyStorage('u1', t.options)
    expect(t.db.names).toEqual(['UniverLocalStorage'])
    t.db.requests[0]?.dispatchEvent(new Event('success'))
    expect(await pending).toEqual({ kind: 'cleared' })
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
    expect(Object.keys(localStorage).sort()).toEqual(kept.sort())
    // SDK 历史数据只在 localStorage；sessionStorage 不扫这些相似名称。
    expect(Object.keys(sessionStorage).sort()).toEqual([...kept, 'UniverLocalStorage/preferences', 'UniverLocalStorage/recent', 'univer-mobile-recent-formula-functions'].sort())
    expect(localStorage.getItem('nerve-office:pending-save:u2:d1')).toBe('unchanged')
  })

  it('每个新 Document 只清自己的退役意图，不碰 pending-save 和其他命名空间', () => {
    sessionStorage.setItem('nerve-office:reload:old', 'identity')
    sessionStorage.setItem('nerve-office:edit-request:old', 'intent')
    sessionStorage.setItem('nerve-office:pending-save:u1:d1', 'pending')
    sessionStorage.setItem('other', 'keep')
    clearLegacySessionMarkers(sessionStorage)
    expect(Object.keys(sessionStorage).sort()).toEqual(['nerve-office:pending-save:u1:d1', 'other'])
  })

  it.each(['access', 'length', 'key', 'remove'] as const)('Storage %s 失败不能报告 cleared，仍尝试其余存储', async (failure) => {
    const t = setup()
    const fail = (): never => {
      throw new Error('storage denied')
    }
    const target = {
      get length() {
        return failure === 'length' ? fail() : 1
      },
      key: () => failure === 'key' ? fail() : 'nerve-office:pending-save:u1:d1',
      removeItem: fail,
    }
    sessionStorage.setItem('nerve-office:reload:old', '{}')
    const result = clearLegacyStorage('u1', { ...t.options, localStorage: failure === 'access' ? fail : () => target })
    t.db.requests[0]?.dispatchEvent(new Event('success'))
    expect(await result).toMatchObject({ kind: 'failed', error: new Error('storage denied') })
    expect(sessionStorage.length).toBe(0)
  })

  it('sessionStorage 访问失败仍清 localStorage，结果保持 failed', async () => {
    const t = setup()
    localStorage.setItem('nerve-office:pending-save:u1:d1', '{}')
    const result = clearLegacyStorage('u1', { ...t.options, sessionStorage: () => {
      throw new Error('session denied')
    } })
    t.db.requests[0]?.dispatchEvent(new Event('success'))
    expect(await result).toMatchObject({ kind: 'failed' })
    expect(localStorage.length).toBe(0)
  })
})

describe('旧 SDK 库删除的实际结果', () => {
  it('blocked 立即返回 pending；未完成请求不重复排队，迟到完成不删新用户键；下一次重新核对', async () => {
    const t = setup()
    const result = clearLegacyStorage('u1', t.options)
    t.db.requests[0]?.dispatchEvent(new Event('blocked'))
    expect(await result).toEqual({ kind: 'pending' })
    expect(await clearLegacyStorage('u1', t.options)).toEqual({ kind: 'pending' })
    expect(t.db.names).toEqual(['UniverLocalStorage'])
    localStorage.setItem('nerve-office:pending-save:u1:new-session', 'new')
    t.db.requests[0]?.dispatchEvent(new Event('success'))
    expect(localStorage.getItem('nerve-office:pending-save:u1:new-session')).toBe('new')
    // 调用者须在重试之前重新核对原许可；低层不获取或切换资格。
    const retry = clearLegacyStorage('u1', t.options)
    expect(t.db.names).toEqual(['UniverLocalStorage', 'UniverLocalStorage'])
    t.db.requests[1]?.dispatchEvent(new Event('success'))
    expect(await retry).toEqual({ kind: 'cleared' })
  })

  it('没有任何事件也有限时；超时之后错误不会制造未处理拒绝，重试可重新发起', async () => {
    vi.useFakeTimers()
    const t = setup()
    const result = clearLegacyStorage('u1', t.options)
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toEqual({ kind: 'pending' })
    t.db.requests[0]?.dispatchEvent(new Event('error'))
    const retry = clearLegacyStorage('u1', t.options)
    t.db.requests[1]?.dispatchEvent(new Event('success'))
    expect(await retry).toEqual({ kind: 'cleared' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('删除错误和同步访问错误都保留 failed，不冒充无旧数据', async () => {
    const t = setup()
    const result = clearLegacyStorage('u1', t.options)
    t.db.requests[0]?.dispatchEvent(new Event('error'))
    expect(await result).toMatchObject({ kind: 'failed', error: new Error('delete failed') })
    expect(await clearLegacyStorage('u1', { ...t.options, indexedDB: () => {
      throw new Error('denied')
    } })).toMatchObject({ kind: 'failed' })
    expect(await clearLegacyStorage('u1', { ...t.options, indexedDB: () => ({ deleteDatabase: () => {
      throw new Error('denied')
    } }) })).toMatchObject({ kind: 'failed' })
  })
})

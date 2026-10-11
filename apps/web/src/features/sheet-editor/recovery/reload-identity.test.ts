import type { LockApi } from '../same-browser.ts'
import type { ReloadIdentityOptions } from './reload-identity.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../../../shared/outbox/outbox-lock.test-support.ts'
import { settle } from '../fake-lease-clock.test-support.ts'
import { fakeBrowser } from '../same-browser.test-support.ts'
import { reloadIdentitySelector, reloadInstanceLock, selectReloadIdentity } from './reload-identity.ts'
import { FRESH_INSTANCE, OLD_INSTANCE, RELOAD_KEY, RELOAD_MARKER, RELOAD_WRITER, reloadStorage } from './reload-marker.test-support.ts'
import { reloadMarker } from './reload-marker.ts'

const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    cleanup()
  await settle()
})

function fixture() {
  const browser = fakeBrowser()
  const storage = reloadStorage()
  const marker = reloadMarker(RELOAD_KEY, { storage: () => storage })
  marker.write(RELOAD_MARKER)
  const matches = vi.fn(async () => true)
  let alive = true
  const options: ReloadIdentityOptions = { key: RELOAD_KEY, freshId: FRESH_INSTANCE, navigation: { type: 'reload', wasDiscarded: false }, marker, locks: browser.tab('new-page').locks, matches, still: () => alive }
  const select = async (overrides: Partial<ReloadIdentityOptions> = {}) => {
    const result = await selectReloadIdentity({ ...options, ...overrides })
    cleanups.push(result.dispose)
    return result
  }
  return { browser, storage, marker, matches, options, select, end: () => {
    alive = false
  } }
}

describe('重载身份与严格实例锁', () => {
  it.each(['navigate', 'back_forward', undefined])('入口导航 %s 在任何请求前清全部继承记号，只影响恢复命名空间', (type) => {
    const h = fixture()
    reloadMarker({ ...RELOAD_KEY, userId: FRESH_INSTANCE }, { storage: () => h.storage }).write(RELOAD_MARKER)
    h.storage.setItem('nerve-office:unrelated', '保留')
    reloadIdentitySelector({ navigation: { type, wasDiscarded: false }, storage: () => h.storage, locks: h.options.locks })
    expect([...h.storage.items]).toEqual([['nerve-office:unrelated', '保留']])
    expect(h.matches).not.toHaveBeenCalled()
  })

  it.each([{ type: 'reload', wasDiscarded: false }, { type: 'navigate', wasDiscarded: true }])('入口 $type / 回收 $wasDiscarded 保留候选给认证后的预检', (navigation) => {
    const h = fixture()
    reloadIdentitySelector({ navigation, storage: () => h.storage, locks: h.options.locks })
    expect(h.marker.read()).toEqual(RELOAD_MARKER)
    expect(h.matches).not.toHaveBeenCalled()
  })

  it('入口访问存储失败不阻断页面组装', () => {
    expect(() => reloadIdentitySelector({ navigation: { type: 'navigate', wasDiscarded: false }, locks: undefined, storage: () => {
      throw new Error('blocked storage')
    } })).not.toThrow()
  })

  it('大写文档 ID 使用同一把实例锁并能匹配规范身份', async () => {
    const h = fixture()
    const key = { userId: RELOAD_KEY.userId.toUpperCase(), documentId: RELOAD_KEY.documentId.toUpperCase() }
    const identity = await h.select({ key })
    expect(identity.clientInstanceId).toBe(OLD_INSTANCE)
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))).toBe('new-page')
    expect(reloadInstanceLock(key, OLD_INSTANCE.toUpperCase())).toBe(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))
  })

  it.each([true, false])('实例锁中断时原页仍有效：%s；只有活页撤销资格，已退出页保留重载记号', async (alive) => {
    const h = fixture()
    const old = await h.select()
    if (!alive)
      h.end()
    // 浏览器中断持锁请求同样以 AbortError 通知适配层；WebKit 刷新时也会走这个回调。
    await h.browser.tab('interrupt').locks!.request(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE), { mode: 'exclusive', steal: true }, async () => {})
    await settle()
    expect(h.marker.read()).toEqual(alive ? undefined : RELOAD_MARKER)
    old.remember({ ...RELOAD_WRITER, writeEpoch: 8 })
    expect(h.marker.read()).toEqual(alive ? undefined : RELOAD_MARKER)
    const next = await h.select({ still: () => true })
    expect(next.clientInstanceId).toBe(alive ? FRESH_INSTANCE : OLD_INSTANCE)
  })

  it('旧选择被取消后迟到结束，不能清掉新选择实际写入的记号或释放新实例锁', async () => {
    const h = fixture()
    const pending = deferred<boolean>()
    h.matches.mockImplementation(async () => pending.promise)
    const old = h.select()
    await settle()
    h.end()
    const next = await h.select({ still: () => true, matches: async () => true })
    next.remember({ ...RELOAD_WRITER, writeEpoch: 8 })
    const remembered = h.marker.read()
    expect(remembered?.clientInstanceId).toBe(FRESH_INSTANCE)
    pending.resolve(true)
    const cancelled = await old
    cancelled.clear()
    await settle()
    expect(h.marker.read()).toEqual(remembered)
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, FRESH_INSTANCE))).toBe('new-page')
  })

  it.each(['navigate', 'reload'])('旧持有者主动清理只影响自己的记号，不能删除同键后来 %s 产生的身份', async (type) => {
    const h = fixture()
    const old = await h.select()
    old.dispose()
    await settle()
    const next = await h.select({ navigation: { type, wasDiscarded: false } })
    next.remember({ ...RELOAD_WRITER, writeEpoch: 8 })
    const remembered = h.marker.read()
    old.clear()
    expect(h.marker.read()).toEqual(remembered)
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, next.clientInstanceId))).toBe('new-page')
  })

  it.each([{ type: 'reload', wasDiscarded: false }, { type: 'navigate', wasDiscarded: true }])('导航 $type / 回收 $wasDiscarded：先占原实例锁，再核对原件，成功保留原身份', async (navigation) => {
    const h = fixture()
    h.matches.mockImplementation(async () => {
      expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))).toBe('new-page')
      return true
    })
    const request = vi.spyOn(h.options.locks!, 'request')
    const identity = await h.select({ navigation })
    expect(identity.clientInstanceId).toBe(OLD_INSTANCE)
    expect(identity.candidate).toEqual(RELOAD_MARKER)
    expect(h.matches).toHaveBeenCalledExactlyOnceWith(RELOAD_MARKER)
    expect(request).toHaveBeenCalledWith(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE), { mode: 'exclusive', ifAvailable: true }, expect.any(Function))
    identity.remember({ ...RELOAD_WRITER, writeEpoch: 8 })
    expect(h.marker.read()).toEqual({ ...RELOAD_MARKER, writeEpoch: 8 })
  })

  it.each(['navigate', 'back_forward', 'prerender', undefined])('导航 %s 在读取候选前清旧记号；新实例持锁之后才允许记下实际写入', async (type) => {
    const h = fixture()
    const read = vi.spyOn(h.marker, 'read')
    const identity = await h.select({ navigation: { type, wasDiscarded: false } })
    expect(read).not.toHaveBeenCalled()
    expect(h.matches).not.toHaveBeenCalled()
    expect(identity.clientInstanceId).toBe(FRESH_INSTANCE)
    expect(identity.candidate).toBeUndefined()
    expect(h.marker.read()).toBeUndefined()
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, FRESH_INSTANCE))).toBe('new-page')
    identity.remember(RELOAD_WRITER)
    expect(h.marker.read()?.clientInstanceId).toBe(FRESH_INSTANCE)
  })

  it('复制页初次 navigate 已清继承记号：原页结束后再 reload 也不能冒充；原页的记号不受影响', async () => {
    const h = fixture()
    const cloned = reloadStorage(h.storage.items)
    const cloneMarker = reloadMarker(RELOAD_KEY, { storage: () => cloned })
    const first = await h.select({ marker: cloneMarker, navigation: { type: 'navigate', wasDiscarded: false } })
    first.dispose()
    await settle()
    const reloaded = await h.select({ marker: cloneMarker })
    expect(reloaded.clientInstanceId).toBe(FRESH_INSTANCE)
    expect(reloaded.candidate).toBeUndefined()
    expect(h.matches).not.toHaveBeenCalled()
    expect(h.marker.read()).toEqual(RELOAD_MARKER)
  })

  it('原页持有实例锁：候选不核对、不抢、不排队，旧页仍持有；新身份仍可记下以后实际写成的草稿', async () => {
    const h = fixture()
    const old = await h.select({ freshId: OLD_INSTANCE, navigation: { type: 'navigate', wasDiscarded: false }, locks: h.browser.tab('old-page').locks })
    old.remember(RELOAD_WRITER)
    const next = await h.select()
    expect(next.clientInstanceId).toBe(FRESH_INSTANCE)
    expect(next.candidate).toBeUndefined()
    expect(h.matches).not.toHaveBeenCalled()
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))).toBe('old-page')
    next.remember(RELOAD_WRITER)
    expect(h.marker.read()?.clientInstanceId).toBe(FRESH_INSTANCE)
  })

  it.each(['missing', 'reject', 'throw'] as const)('锁 API %s：没有未跟踪句柄退路，不能自动采用或产生新记号', async (failure) => {
    const h = fixture()
    const fail = (): never => {
      throw new Error('blocked')
    }
    const locks: LockApi | undefined = failure === 'missing'
      ? undefined
      : { query: async () => ({}), request: failure === 'throw' ? fail : async () => fail() }
    const identity = await h.select({ locks })
    expect(identity.clientInstanceId).toBe(FRESH_INSTANCE)
    expect(identity.candidate).toBeUndefined()
    expect(h.matches).not.toHaveBeenCalled()
    identity.remember(RELOAD_WRITER)
    expect(h.marker.read()).toBeUndefined()
  })

  it.each(['false', 'throw'] as const)('原件核对 %s：释放候选锁、清旧记号，重新占新身份锁', async (failure) => {
    const h = fixture()
    h.matches.mockImplementation(async () => {
      if (failure === 'throw')
        throw new Error('读失败')
      return false
    })
    const identity = await h.select()
    await settle()
    expect(identity.clientInstanceId).toBe(FRESH_INSTANCE)
    expect(identity.candidate).toBeUndefined()
    expect(h.marker.read()).toBeUndefined()
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))).toBeUndefined()
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, FRESH_INSTANCE))).toBe('new-page')
  })

  it('两个复制候选同时重载，只一个能取得原实例身份；另一个使用新身份', async () => {
    const h = fixture()
    const otherStorage = reloadStorage(h.storage.items)
    const [a, b] = await Promise.all([
      h.select(),
      h.select({ marker: reloadMarker(RELOAD_KEY, { storage: () => otherStorage }), locks: h.browser.tab('competitor').locks }),
    ])
    expect([a.clientInstanceId, b.clientInstanceId].sort()).toEqual([OLD_INSTANCE, FRESH_INSTANCE].sort())
    expect(h.matches).toHaveBeenCalledOnce()
  })

  it.each(['before', 'lock', 'match'] as const)('在 %s 时取消：迟到句柄必须释放，不能读取或记下新身份', async (when) => {
    const h = fixture()
    const grant = deferred<void>()
    const matched = deferred<boolean>()
    const actualLocks = h.options.locks!
    const locks: LockApi = { ...actualLocks, request: async (...args) => {
      await grant.promise
      return actualLocks.request(...args)
    } }
    h.matches.mockImplementation(async () => matched.promise)
    if (when === 'before')
      h.end()
    const selected = h.select({ locks })
    await settle()
    if (when === 'lock')
      h.end()
    grant.resolve()
    await settle()
    if (when === 'match')
      h.end()
    matched.resolve(true)
    const identity = await selected
    await settle()
    expect(identity.candidate).toBeUndefined()
    identity.remember(RELOAD_WRITER)
    // 一开始就已取消的选择没有观察/写入所有权，不能删任何已有记号。
    expect(h.marker.read()).toEqual(when === 'before' ? RELOAD_MARKER : undefined)
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))).toBeUndefined()
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, FRESH_INSTANCE))).toBeUndefined()
    if (when !== 'match')
      expect(h.matches).not.toHaveBeenCalled()
  })

  it('dispose 放锁但保留真实写入的记号；之后迟到记下无效，clear 仍可主动清除', async () => {
    const h = fixture()
    const identity = await h.select()
    identity.dispose()
    identity.dispose()
    await settle()
    expect(h.browser.holderOf(reloadInstanceLock(RELOAD_KEY, OLD_INSTANCE))).toBeUndefined()
    expect(h.marker.read()).toEqual(RELOAD_MARKER)
    identity.remember({ ...RELOAD_WRITER, writeEpoch: 8 })
    expect(h.marker.read()).toEqual(RELOAD_MARKER)
    identity.clear()
    expect(h.marker.read()).toBeUndefined()
  })

  it('clear 清资格而仍持有本页实例：后续一次明确编辑的真实写入能重新记下；会话失效后不能', async () => {
    const h = fixture()
    const identity = await h.select()
    identity.clear()
    expect(h.marker.read()).toBeUndefined()
    identity.remember({ ...RELOAD_WRITER, writeEpoch: 8 })
    expect(h.marker.read()?.writeEpoch).toBe(8)
    h.end()
    identity.remember({ ...RELOAD_WRITER, writeEpoch: 9 })
    expect(h.marker.read()?.writeEpoch).toBe(8)
  })
})

import type { LeaseLoss, LeaseVerdict } from './edit-lease.ts'
import type { HandoverTraceEvent } from './handover-trace.ts'
import type { LocalLockOptions } from './local-lock.ts'
import type { HeldLock } from './same-browser.ts'
import { describe, expect, it, vi } from 'vitest'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { holdLocalLock } from './local-lock.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { lockNameOf, sameBrowserFor } from './same-browser.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const LOCK = lockNameOf(DOCUMENT_ID)
const CURRENT: LeaseVerdict = { kind: 'current' }
const TAKEN_OVER: LeaseLoss = { kind: 'taken-over', where: 'elsewhere' }
const ENDED: LeaseVerdict = { kind: 'ended', loss: TAKEN_OVER }

/** 由测试决定何时完成的 Promise */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

/** 一个 Promise 此刻兑现了没有（让排着的回调先执行完） */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => {
    done = true
  })
  await settle()
  return done
}

/**
 * 本页（标签页 this）的本机锁：核对按 verdicts 依次回答（用完之后一直是最后一个）；另一个标签页（other）经同一个浏览器拿锁、抢锁
 */
function setup(verdicts: readonly (LeaseVerdict | Promise<LeaseVerdict>)[] = [CURRENT], options: Partial<LocalLockOptions> = {}) {
  const browser = fakeBrowser()
  const time = fakeLeaseClock()
  const events: HandoverTraceEvent[] = []
  let answered = 0
  const confirm = vi.fn(async (): Promise<LeaseVerdict> => {
    const verdict = verdicts[Math.min(answered, verdicts.length - 1)] ?? CURRENT
    answered += 1
    return verdict
  })
  const onSuperseded = vi.fn<(loss: LeaseLoss | undefined) => void>()
  const lock = holdLocalLock({
    browser: sameBrowserFor(DOCUMENT_ID, browser.tab('this')),
    confirm,
    onSuperseded,
    clock: time.clock,
    trace: event => events.push(event),
    ...options,
  })
  const other = sameBrowserFor(DOCUMENT_ID, browser.tab('other'))
  return { browser, lock, confirm, onSuperseded, events, other }
}

/** 另一个标签页抢走锁（本页的句柄被抢），让排着的回调跑完 */
async function stolenByOther(context: ReturnType<typeof setup>): Promise<HeldLock> {
  const taken = await context.other.steal()
  await settle()
  return taken
}

describe('拿锁（服务端批准之后，M3-P6 设计 §3.13）', () => {
  it('锁空着：直接拿，不核对', async () => {
    const context = setup()
    expect(await context.lock.claim()).toEqual({ kind: 'held' })
    expect(context.lock.held()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(context.confirm).not.toHaveBeenCalled()
    expect(context.events).toEqual([])
  })

  it('被本浏览器的别的标签页占着、核对得知这一代是当前的：抢——那边的句柄随即兑现 stolen；报裁决', async () => {
    const context = setup([CURRENT])
    const holder = await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'held' })
    expect(context.confirm).toHaveBeenCalledOnce()
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(holder?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(true)
    expect(context.events).toEqual([{ kind: 'lock-verdict', at: expect.any(Number) as number, when: 'claim', verdict: 'current' }])
  })

  it('被占着、核对得知这一代已经不是当前的：不抢，交回服务端说的原因', async () => {
    const context = setup([ENDED])
    const holder = await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'superseded', loss: TAKEN_OVER })
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(holder?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
    expect(context.onSuperseded).not.toHaveBeenCalled()
    // 之后心跳续租成功也不再拿（这一代已经不是本页的）
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('被占着、核对不了：不抢，交回那次的错误', async () => {
    const failure = new Error('断网')
    const context = setup([{ kind: 'unknown', error: failure }])
    await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'unverified', error: failure })
    expect(context.lock.held()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('核对期间放下了（页面关闭、离开编辑）：不论裁决都不抢，交回 released', async () => {
    for (const verdict of [CURRENT, ENDED]) {
      const answer = deferred<LeaseVerdict>()
      const context = setup([answer.promise])
      await context.other.tryHold()
      const claiming = context.lock.claim()
      await settle()
      context.lock.release()
      answer.resolve(verdict)
      expect(await claiming).toEqual({ kind: 'released' })
      expect(context.browser.holderOf(LOCK)).toBe('other')
      expect(context.events).toEqual([])
    }
  })

  it('拿锁的请求还在途时放下了：拿到的随即放掉，交回 released', async () => {
    const context = setup()
    const claiming = context.lock.claim()
    context.lock.release()
    expect(await claiming).toEqual({ kind: 'released' })
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('核对过是当前的、正要抢时放下了：抢到的随即放掉', async () => {
    const context = setup([CURRENT])
    await context.other.tryHold()
    let release: () => void = () => {}
    const steal = vi.fn(async (): Promise<HeldLock> => {
      release()
      return sameBrowserFor(DOCUMENT_ID, context.browser.tab('this')).steal()
    })
    const lock = holdLocalLock({ browser: { tryHold: async () => undefined, steal }, confirm: async () => CURRENT, onSuperseded: vi.fn(), clock: fakeLeaseClock().clock })
    release = lock.release
    expect(await lock.claim()).toEqual({ kind: 'released' })
    await settle()
    expect(steal).toHaveBeenCalledOnce()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })
})

describe('被抢（M3-P6 设计 §3.13）', () => {
  it('核对得知仍是当前的（抢的一方拿着旧的批准）：拿回来——抢的一方的句柄随即兑现 stolen；报被抢与裁决', async () => {
    const context = setup([CURRENT])
    await context.lock.claim()
    const stale = await stolenByOther(context)
    expect(context.confirm).toHaveBeenCalledOnce()
    expect(context.lock.held()).toBe(true)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(stale.stolen)).toBe(true)
    expect(context.events.map(event => event.kind)).toEqual(['lock-stolen', 'lock-verdict'])
    expect(context.events[1]).toMatchObject({ when: 'stolen', verdict: 'current' })
    expect(context.onSuperseded).not.toHaveBeenCalled()
  })

  it('核对得知已经不是当前的：交给页面（被取代，服务端说的原因），不拿回来；之后心跳续租成功也不拿', async () => {
    const context = setup([ENDED])
    await context.lock.claim()
    const taker = await stolenByOther(context)
    expect(context.onSuperseded).toHaveBeenCalledExactlyOnceWith(TAKEN_OVER)
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    context.lock.renewed()
    await settle()
    expect(await settledNow(taker.stolen)).toBe(false)
    expect(context.events.at(-1)).toMatchObject({ kind: 'lock-verdict', when: 'stolen', verdict: 'ended' })
  })

  it('核对之前、核对期间都算"被抢了、还没有结论"（页面据此说是本浏览器的另一个标签页接手的）；有了结论之后不算', async () => {
    const answer = deferred<LeaseVerdict>()
    // 锁空着时拿锁不核对：第一次核对就是被抢之后的那一次
    const context = setup([answer.promise])
    await context.lock.claim()
    expect(context.lock.stolen()).toBe(false)
    await stolenByOther(context)
    expect(context.lock.stolen()).toBe(true)
    expect(context.lock.held()).toBe(false)
    answer.resolve(CURRENT)
    await settle()
    expect(context.lock.stolen()).toBe(false)
    expect(context.lock.held()).toBe(true)
  })

  it('核对不了：不拿回来、不交给页面，这期间不持有（held 为假）、算"被抢了、还没有结论"；之后心跳续租成功（renewed）就拿回来', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    const taker = await stolenByOther(context)
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.onSuperseded).not.toHaveBeenCalled()
    context.lock.renewed()
    await settle()
    expect(context.lock.held()).toBe(true)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(taker.stolen)).toBe(true)
    // 拿回来之后不再核对（心跳刚说过是当前的）
    expect(context.confirm).toHaveBeenCalledOnce()
  })

  it('核对不了之后锁已经空了（抢的一方离开了）：心跳续租成功时直接拿', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    const taker = await stolenByOther(context)
    taker.release()
    await settle()
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it('心跳续租成功（renewed）在别的时候什么也不做：拿着锁时、拿锁之前、核对中、放下之后', async () => {
    const answer = deferred<LeaseVerdict>()
    const context = setup([answer.promise])
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    await context.lock.claim()
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('this')
    await stolenByOther(context)
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
    context.lock.release()
    answer.resolve(CURRENT)
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it.each([
    ['当前的', CURRENT],
    ['已经不是当前的', ENDED],
  ] as const)('核对期间放下了（离开编辑、页面关闭、卸载）、裁决是%s：结论回来时不拿回来、不交给页面', async (_case, verdict) => {
    const answer = deferred<LeaseVerdict>()
    const context = setup([answer.promise])
    await context.lock.claim()
    await stolenByOther(context)
    context.lock.release()
    answer.resolve(verdict)
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lock.stolen()).toBe(false)
  })

  it('等心跳期间放下了：之后心跳续租成功也不拿', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    await stolenByOther(context)
    context.lock.release()
    context.lock.renewed()
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('放下之后被抢不算（不核对）；放下重复调用无害', async () => {
    const context = setup()
    await context.lock.claim()
    context.lock.release()
    context.lock.release()
    await settle()
    await stolenByOther(context)
    expect(context.confirm).not.toHaveBeenCalled()
    expect(context.events).toEqual([])
  })

  it('拿回来的那一把再被抢：同样先核对', async () => {
    const context = setup([CURRENT, ENDED])
    await context.lock.claim()
    await stolenByOther(context)
    expect(context.lock.held()).toBe(true)
    await stolenByOther(context)
    expect(context.confirm).toHaveBeenCalledTimes(2)
    expect(context.onSuperseded).toHaveBeenCalledExactlyOnceWith(TAKEN_OVER)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('浏览器没有锁（退化）：拿到的句柄从不被抢，照常编辑', async () => {
    const confirm = vi.fn(async (): Promise<LeaseVerdict> => CURRENT)
    const lock = holdLocalLock({ browser: sameBrowserFor(DOCUMENT_ID, { locks: undefined, openChannel: undefined }), confirm, onSuperseded: vi.fn(), clock: fakeLeaseClock().clock })
    expect(await lock.claim()).toEqual({ kind: 'held' })
    expect(lock.held()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})

import type { LeaseLoss, LeaseOutcome, LeaseVerdict } from './edit-lease.ts'
import type { HandoverTraceEvent } from './handover-trace.ts'
import type { LocalLock, LocalLockOptions } from './local-lock.ts'
import type { HeldLock } from './same-browser.ts'
import { describe, expect, it, vi } from 'vitest'
import { fakeLeaseClock, settle } from './fake-lease-clock.test-support.ts'
import { holdLocalLock } from './local-lock.ts'
import { fakeBrowser } from './same-browser.test-support.ts'
import { lockNameOf, sameBrowserFor } from './same-browser.ts'

const DOCUMENT_ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'
const LOCK = lockNameOf(DOCUMENT_ID)
const CURRENT: LeaseVerdict = { kind: 'current' }
/** 被本人接管（令牌对不上这一行）：被别的一代取代了 */
const TAKEN_OVER: LeaseLoss = { kind: 'taken-over', where: 'elsewhere' }
const SUPERSEDED: LeaseVerdict = { kind: 'superseded', loss: TAKEN_OVER }
/** 按时间到期（令牌仍是这一行的）：这一代自己失效了 */
const EXPIRED: LeaseLoss = { kind: 'lease', reason: 'expired' }
const ENDED: LeaseVerdict = { kind: 'ended', loss: EXPIRED }
const OUTCOME_HELD: LeaseOutcome = { kind: 'held' }
const OUTCOME_LOST: LeaseOutcome = { kind: 'lost' }

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
 * 本页（标签页 this）的本机锁：核对按 verdicts 依次回答（用完之后一直是最后一个）；交给租约的失效（lose）默认续上了（held）；另一个标签页
 * （other）经同一个浏览器拿锁、抢锁。时钟是假的：被抢之后要有"之后发出的续租"时先 elapse
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
  const lose = vi.fn(async (_loss: LeaseLoss): Promise<LeaseOutcome> => OUTCOME_HELD)
  const onSuperseded = vi.fn<(loss: LeaseLoss) => void>()
  const lock = holdLocalLock({
    browser: sameBrowserFor(DOCUMENT_ID, browser.tab('this')),
    confirm,
    lose,
    onSuperseded,
    clock: time.clock,
    trace: event => events.push(event),
    ...options,
  })
  const other = sameBrowserFor(DOCUMENT_ID, browser.tab('other'))
  return { browser, time, lock, confirm, lose, onSuperseded, events, other }
}

/** 另一个标签页抢走锁（本页的句柄被抢），让排着的回调跑完 */
async function stolenByOther(context: ReturnType<typeof setup>): Promise<HeldLock> {
  const taken = await context.other.steal()
  await settle()
  return taken
}

/** 一次在这一刻发出的心跳续租成功了（先让时间走一点：它晚于之前发生的一切发出） */
async function renewedLater(context: { readonly time: ReturnType<typeof fakeLeaseClock>, readonly lock: LocalLock }): Promise<void> {
  context.time.elapse(1)
  context.lock.renewed(context.time.now())
  await settle()
}

describe('工作草稿观察本机锁资格', () => {
  it('被抢后先同步通知停写再核对；未知期间不恢复，更新的心跳才可拿回', async () => {
    const events: string[] = []
    const answer = deferred<LeaseVerdict>()
    const context = setup([], { onHeldChange: held => events.push(`held:${held}`) })
    context.confirm.mockImplementationOnce(async () => {
      events.push('confirm')
      return answer.promise
    })
    await context.lock.claim()
    expect(events).toEqual(['held:true'])
    await stolenByOther(context)
    expect(events).toEqual(['held:true', 'held:false', 'confirm'])
    answer.resolve({ kind: 'unknown', error: undefined })
    await settle()
    expect(context.lock.held()).toBe(false)
    context.lock.renewed(context.time.now())
    await settle()
    expect(events).toHaveLength(3)
    await renewedLater(context)
    expect(events).toEqual(['held:true', 'held:false', 'confirm', 'held:true'])
    context.lock.release()
    context.lock.release()
    expect(events).toEqual(['held:true', 'held:false', 'confirm', 'held:true', 'held:false'])
  })

  it('失效后等接管位置时已不具备写入资格，即使底层锁仍留着', async () => {
    const changes = vi.fn()
    const context = setup([], { onHeldChange: changes })
    await context.lock.claim()
    const locating = context.lock.takenHere(context.time.now() + 100)
    expect(changes.mock.calls).toEqual([[true], [false]])
    expect(context.lock.held()).toBe(false)
    await context.time.advance(100)
    expect(await locating).toBe(false)
    expect(changes.mock.calls).toEqual([[true], [false]])
  })

  it('持有通知同步释放时，claim 不返回已经失效的 held', async () => {
    const context = setup([], { onHeldChange: (held) => {
      if (held)
        context.lock.release()
    } })
    expect(await context.lock.claim()).toEqual({ kind: 'released' })
    expect(context.lock.held()).toBe(false)
  })

  it('停写通知同步销毁后不再开始核对', async () => {
    const context = setup([], { onHeldChange: (held) => {
      if (!held)
        context.lock.release()
    } })
    await context.lock.claim()
    await stolenByOther(context)
    expect(context.confirm).not.toHaveBeenCalled()
    expect(context.lock.held()).toBe(false)
  })
})

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

  it('被占着、核对得知这一代已被别的一代取代：不抢，交回服务端说的原因；不交给租约', async () => {
    const context = setup([SUPERSEDED])
    const holder = await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'superseded', loss: TAKEN_OVER })
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(holder?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lose).not.toHaveBeenCalled()
    expect(context.events.at(-1)).toMatchObject({ kind: 'lock-verdict', when: 'claim', verdict: 'superseded' })
    // 之后心跳续租成功也不再拿（这一代已经不是本页的）
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('被占着、核对得知这一代自己失效了：交给租约（带服务端的原因），续不上的交回 lost（租约已经通知了页面）；不抢', async () => {
    const context = setup([ENDED])
    context.lose.mockResolvedValue(OUTCOME_LOST)
    await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'lost' })
    expect(context.lose).toHaveBeenCalledExactlyOnceWith(EXPIRED)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.lock.held()).toBe(false)
    expect(context.events.at(-1)).toMatchObject({ kind: 'lock-verdict', when: 'claim', verdict: 'ended' })
  })

  it.each([
    ['续上了', OUTCOME_HELD, undefined],
    ['说不准（续上的申请断网）', { kind: 'unknown', error: new Error('断网') } as const, 'error'],
  ] as const)('被占着、这一代自己失效、交给租约之后%s：交回 unverified（续上的申请同样说明不了现在，不在这里抢）；之后心跳续租成功也不拿', async (_case, outcome, withError) => {
    const context = setup([ENDED])
    context.lose.mockResolvedValue(outcome)
    await context.other.tryHold()
    const claim = await context.lock.claim()
    expect(claim).toMatchObject({ kind: 'unverified' })
    expect(claim.kind === 'unverified' ? claim.error : 'none').toEqual(withError === undefined ? undefined : new Error('断网'))
    expect(context.browser.holderOf(LOCK)).toBe('other')
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('被占着、这一代在本页已经结束（核对交回已经结束、没有原因）：不交给租约，交回 lost', async () => {
    const context = setup([{ kind: 'ended', loss: undefined }])
    await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'lost' })
    expect(context.lose).not.toHaveBeenCalled()
  })

  it('被占着、交给租约期间放下了（租约通知了页面，页面随即放下锁）：交回 released，不抢', async () => {
    const context = setup([ENDED])
    context.lose.mockImplementation(async () => {
      context.lock.release()
      return OUTCOME_LOST
    })
    await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'released' })
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('被占着、核对不了：不抢，交回那次的错误', async () => {
    const failure = new Error('断网')
    const context = setup([{ kind: 'unknown', error: failure }])
    await context.other.tryHold()
    expect(await context.lock.claim()).toEqual({ kind: 'unverified', error: failure })
    expect(context.lock.held()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.lose).not.toHaveBeenCalled()
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('核对期间放下了（页面关闭、离开编辑）：不论裁决都不抢、不交给租约，交回 released', async () => {
    for (const verdict of [CURRENT, SUPERSEDED, ENDED]) {
      const answer = deferred<LeaseVerdict>()
      const context = setup([answer.promise])
      await context.other.tryHold()
      const claiming = context.lock.claim()
      await settle()
      context.lock.release()
      answer.resolve(verdict)
      expect(await claiming).toEqual({ kind: 'released' })
      expect(context.browser.holderOf(LOCK)).toBe('other')
      expect(context.lose).not.toHaveBeenCalled()
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

  it('核对过是当前的，看锁空不空的这一下里放下了（页面关闭）：不抢——不再抢走别人的锁再随即放掉（复验 E3）', async () => {
    const context = setup([CURRENT])
    const holder = await context.other.tryHold()
    let release: () => void = () => {}
    let checks = 0
    const steal = vi.fn(async (): Promise<HeldLock> => sameBrowserFor(DOCUMENT_ID, context.browser.tab('this')).steal())
    const browser = {
      // 第一次是拿锁时看锁空不空（被占着），第二次是核对过之后再看——这一下里页面关闭
      tryHold: async (): Promise<HeldLock | undefined> => {
        checks += 1
        if (checks === 2)
          release()
        return undefined
      },
      steal,
    }
    const lock = holdLocalLock({ browser, confirm: async () => CURRENT, lose: vi.fn(), onSuperseded: vi.fn(), clock: fakeLeaseClock().clock })
    release = lock.release
    expect(await lock.claim()).toEqual({ kind: 'released' })
    await settle()
    expect(checks).toBe(2)
    expect(steal).not.toHaveBeenCalled()
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(holder?.stolen ?? Promise.reject(new Error('没拿到')))).toBe(false)
  })

  it('抢的请求已经发出、还在途时放下了：抢到的随即放掉', async () => {
    const context = setup([CURRENT])
    await context.other.tryHold()
    let release: () => void = () => {}
    const steal = vi.fn(async (): Promise<HeldLock> => {
      const taken = sameBrowserFor(DOCUMENT_ID, context.browser.tab('this')).steal()
      release()
      return taken
    })
    const lock = holdLocalLock({ browser: { tryHold: async () => undefined, steal }, confirm: async () => CURRENT, lose: vi.fn(), onSuperseded: vi.fn(), clock: fakeLeaseClock().clock })
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

  it('核对得知已被别的一代取代：交给页面（服务端说的原因），不交给租约、不拿回来；之后心跳续租成功也不拿', async () => {
    const context = setup([SUPERSEDED])
    await context.lock.claim()
    const taker = await stolenByOther(context)
    expect(context.onSuperseded).toHaveBeenCalledExactlyOnceWith(TAKEN_OVER)
    expect(context.lose).not.toHaveBeenCalled()
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    await renewedLater(context)
    expect(await settledNow(taker.stolen)).toBe(false)
    expect(context.events.at(-1)).toMatchObject({ kind: 'lock-verdict', when: 'stolen', verdict: 'superseded' })
  })

  it('核对得知这一代自己失效了（令牌仍是这一行的：抢锁的一方拿着更旧的批准）：交给租约（带服务端的原因），不交给页面、不判为被取代；这期间不持有锁、算"被抢了、还没有结论"；被抢之后发出的心跳续租成功就拿回来（复验 E2）', async () => {
    const context = setup([ENDED])
    await context.lock.claim()
    const stale = await stolenByOther(context)
    expect(context.lose).toHaveBeenCalledExactlyOnceWith(EXPIRED)
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.events.at(-1)).toMatchObject({ kind: 'lock-verdict', when: 'stolen', verdict: 'ended' })
    // 续上之后的新一代第一次心跳续租成功：拿回来
    await renewedLater(context)
    expect(context.lock.held()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(stale.stolen)).toBe(true)
    expect(context.confirm).toHaveBeenCalledOnce()
  })

  it('这一代自己失效、交给租约之后续不上（租约通知页面，页面随即放下锁）：之后什么也不做', async () => {
    const context = setup([ENDED])
    context.lose.mockImplementation(async () => {
      context.lock.release()
      return OUTCOME_LOST
    })
    await context.lock.claim()
    await stolenByOther(context)
    expect(context.lose).toHaveBeenCalledOnce()
    expect(context.lock.stolen()).toBe(false)
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.onSuperseded).not.toHaveBeenCalled()
  })

  it('这一代在本页已经结束（核对交回已经结束、没有原因：退出时的释放等）：不交给租约，也不交给页面（结束它的那一处已经处理），不再算被抢、之后也不拿', async () => {
    const context = setup([{ kind: 'ended', loss: undefined }])
    await context.lock.claim()
    await stolenByOther(context)
    expect(context.lose).not.toHaveBeenCalled()
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(false)
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
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

  it('核对不了：不拿回来、不交给页面与租约，这期间不持有（held 为假）、算"被抢了、还没有结论"；被抢之后发出的心跳续租成功就拿回来', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    const taker = await stolenByOther(context)
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lose).not.toHaveBeenCalled()
    await renewedLater(context)
    expect(context.lock.held()).toBe(true)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(taker.stolen)).toBe(true)
    // 拿回来之后不再核对（心跳刚说过是当前的）
    expect(context.confirm).toHaveBeenCalledOnce()
  })

  it('等心跳期间，被抢之前（或同一刻）发出的心跳迟到的成功不算——它可能跨过了一次换代；之后发出的才拿回来（复验 E1）', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    const sentBefore = context.time.now()
    context.time.elapse(1_000)
    await stolenByOther(context)
    const stolenAt = context.time.now()
    context.lock.renewed(sentBefore)
    await settle()
    context.lock.renewed(stolenAt)
    await settle()
    expect(context.lock.held()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    context.lock.renewed(stolenAt + 1)
    await settle()
    expect(context.lock.held()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it('核对还没回来：被抢之后发出的心跳续租成功同样拿回来（核对挂住时不至于一直不持有锁）；之后才回来的核对不再算（即使说已被取代：不交给页面）（复验 E1）', async () => {
    const answer = deferred<LeaseVerdict>()
    const context = setup([answer.promise])
    await context.lock.claim()
    const stale = await stolenByOther(context)
    expect(context.lock.stolen()).toBe(true)
    // 被抢之前发出的不算
    context.lock.renewed(context.time.now())
    await settle()
    expect(context.lock.held()).toBe(false)
    await renewedLater(context)
    expect(context.lock.held()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(stale.stolen)).toBe(true)
    answer.resolve(SUPERSEDED)
    await settle()
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lock.held()).toBe(true)
    expect(context.events.filter(event => event.kind === 'lock-verdict')).toEqual([])
  })

  it('核对不了之后锁已经空了（抢的一方离开了）：之后发出的心跳续租成功时直接拿', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    const taker = await stolenByOther(context)
    taker.release()
    await settle()
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it('心跳续租成功（renewed）在别的时候什么也不做：拿锁之前、拿着锁时、放下之后', async () => {
    const answer = deferred<LeaseVerdict>()
    const context = setup([answer.promise])
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    await context.lock.claim()
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(context.lock.held()).toBe(true)
    await stolenByOther(context)
    context.lock.release()
    answer.resolve(CURRENT)
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it.each([
    ['当前的', CURRENT],
    ['已被取代', SUPERSEDED],
    ['这一代自己失效了', ENDED],
  ] as const)('核对期间放下了（离开编辑、页面关闭、卸载）、裁决是%s：结论回来时不拿回来、不交给页面与租约', async (_case, verdict) => {
    const answer = deferred<LeaseVerdict>()
    const context = setup([answer.promise])
    await context.lock.claim()
    await stolenByOther(context)
    context.lock.release()
    answer.resolve(verdict)
    await settle()
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.lose).not.toHaveBeenCalled()
    expect(context.lock.stolen()).toBe(false)
  })

  it('等心跳期间放下了：之后发出的心跳续租成功也不拿', async () => {
    const context = setup([{ kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    await stolenByOther(context)
    context.lock.release()
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('被抢之后发出的心跳续上了、去拿锁时看锁空不空的这一下里放下了：不抢（复验 E3）', async () => {
    const browser = fakeBrowser()
    const time = fakeLeaseClock()
    const real = sameBrowserFor(DOCUMENT_ID, browser.tab('this'))
    const other = sameBrowserFor(DOCUMENT_ID, browser.tab('other'))
    // 看过锁空不空之后执行：模拟页面恰在这一下里关闭
    let afterCheck: (() => void) | undefined
    const steal = vi.fn(real.steal)
    const lock = holdLocalLock({
      browser: {
        tryHold: async () => {
          const free = await real.tryHold()
          afterCheck?.()
          return free
        },
        steal,
      },
      confirm: async () => ({ kind: 'unknown', error: new Error('断网') }),
      lose: vi.fn(),
      onSuperseded: vi.fn(),
      clock: time.clock,
    })
    expect(await lock.claim()).toEqual({ kind: 'held' })
    const taker = await other.steal()
    await settle()
    expect(lock.stolen()).toBe(true)
    afterCheck = lock.release
    await renewedLater({ time, lock })
    expect(steal).not.toHaveBeenCalled()
    expect(browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(taker.stolen)).toBe(false)
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
    const context = setup([CURRENT, SUPERSEDED])
    await context.lock.claim()
    await stolenByOther(context)
    expect(context.lock.held()).toBe(true)
    await stolenByOther(context)
    expect(context.confirm).toHaveBeenCalledTimes(2)
    expect(context.onSuperseded).toHaveBeenCalledExactlyOnceWith(TAKEN_OVER)
    expect(context.browser.holderOf(LOCK)).toBe('other')
  })

  it('拿回来之后再被抢：被抢的时刻随之更新——两次被抢之间发出、第二次被抢之后才迟到成功的续租不拿锁，第二次被抢之后发出的才拿（复验 E9）', async () => {
    const context = setup([CURRENT, { kind: 'unknown', error: new Error('断网') }])
    await context.lock.claim()
    context.time.elapse(1_000)
    // 第一次被抢：核对是当前的，拿回来
    await stolenByOther(context)
    expect(context.lock.held()).toBe(true)
    context.time.elapse(1_000)
    const sentBetween = context.time.now()
    context.time.elapse(1_000)
    // 第二次被抢：核对不了，等心跳
    await stolenByOther(context)
    expect(context.lock.stolen()).toBe(true)
    context.lock.renewed(sentBetween)
    await settle()
    expect(context.lock.held()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    await renewedLater(context)
    expect(context.lock.held()).toBe(true)
    expect(context.browser.holderOf(LOCK)).toBe('this')
  })

  it('浏览器没有锁（退化）：拿到的句柄从不被抢，照常编辑', async () => {
    const confirm = vi.fn(async (): Promise<LeaseVerdict> => CURRENT)
    const lock = holdLocalLock({ browser: sameBrowserFor(DOCUMENT_ID, { locks: undefined, openChannel: undefined }), confirm, lose: vi.fn(), onSuperseded: vi.fn(), clock: fakeLeaseClock().clock })
    expect(await lock.claim()).toEqual({ kind: 'held' })
    expect(lock.held()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('被本人接管之后"在哪"的本机证据（takenHere）', () => {
  /** 等的时限（从现在算） */
  const WAIT_MS = 5_000

  it('还拿着：留着等被抢——这期间不是编辑权的锁（held、stolen 为假）、心跳续租成功不做事；被抢交回 true，报被抢（不核对：这一代已经失效），锁归抢的一方', async () => {
    const context = setup()
    await context.lock.claim()
    const located = context.lock.takenHere(context.time.now() + WAIT_MS)
    expect(context.lock.held()).toBe(false)
    expect(context.lock.stolen()).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    expect(await settledNow(located)).toBe(false)
    const taker = await stolenByOther(context)
    expect(await located).toBe(true)
    expect(context.confirm).not.toHaveBeenCalled()
    expect(context.lose).not.toHaveBeenCalled()
    expect(context.onSuperseded).not.toHaveBeenCalled()
    expect(context.events.map(event => event.kind)).toEqual(['lock-stolen'])
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(taker.stolen)).toBe(false)
    // 之后什么也不再做：心跳续租成功不拿回来，放下无害
    await renewedLater(context)
    context.lock.release()
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.time.pending()).toBe(0)
  })

  it('还拿着、到时没人来抢：恰好到时才交回 false（之前还在等），随即放开——本浏览器的别的标签页拿得到（不必抢）；之后被抢不算', async () => {
    const context = setup()
    await context.lock.claim()
    const located = context.lock.takenHere(context.time.now() + WAIT_MS)
    await context.time.advance(WAIT_MS - 1)
    expect(await settledNow(located)).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBe('this')
    await context.time.advance(1)
    expect(await located).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    expect(await context.other.tryHold()).toBeDefined()
    expect(context.events).toEqual([])
  })

  it('还拿着、等的期间放下（页面关闭、卸载）：交回 false，随即放开；时限的计时撤销', async () => {
    const context = setup()
    await context.lock.claim()
    const located = context.lock.takenHere(context.time.now() + WAIT_MS)
    expect(context.time.pending()).toBe(1)
    context.lock.release()
    expect(await located).toBe(false)
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
    expect(context.time.pending()).toBe(0)
  })

  it.each([
    ['核对中', [new Promise<LeaseVerdict>(() => {})]],
    ['核对不了、等心跳', [{ kind: 'unknown', error: new Error('断网') } as const]],
    ['这一代自己失效、交给了租约（续上了、等心跳）', [ENDED]],
    ['得知已被取代', [SUPERSEDED]],
    ['这一代在本页已经结束（核对交回已经结束、没有原因）', [{ kind: 'ended', loss: undefined } as const]],
  ] as const)('被抢了、之后没有得知本页仍是当前的（%s）：立即交回 true，不等；之后回来的核对、心跳续租成功都不再算', async (_case, verdicts) => {
    const context = setup(verdicts)
    await context.lock.claim()
    await stolenByOther(context)
    const superseded = context.onSuperseded.mock.calls.length
    const lost = context.lose.mock.calls.length
    expect(await context.lock.takenHere(context.time.now() + WAIT_MS)).toBe(true)
    expect(context.time.pending()).toBe(0)
    await renewedLater(context)
    expect(context.browser.holderOf(LOCK)).toBe('other')
    expect(context.lock.stolen()).toBe(false)
    expect(context.onSuperseded).toHaveBeenCalledTimes(superseded)
    expect(context.lose).toHaveBeenCalledTimes(lost)
  })

  it('被抢之后核对得知仍是当前的、拿回来了：抢的一方拿着的是旧的批准，不算——照拿着的留着等', async () => {
    const context = setup([CURRENT])
    await context.lock.claim()
    await stolenByOther(context)
    expect(context.lock.held()).toBe(true)
    const located = context.lock.takenHere(context.time.now() + WAIT_MS)
    expect(await settledNow(located)).toBe(false)
    await context.time.advance(WAIT_MS)
    expect(await located).toBe(false)
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('被抢之后核对得知仍是当前的、正去拿回来（看锁空不空）：不算被抢（抢的一方拿着的是旧的批准），交回 false、不等；不再抢', async () => {
    const browser = fakeBrowser()
    const time = fakeLeaseClock()
    const real = sameBrowserFor(DOCUMENT_ID, browser.tab('this'))
    const gate = deferred<void>()
    let gated = false
    const steal = vi.fn(real.steal)
    const lock = holdLocalLock({
      browser: {
        tryHold: async () => {
          if (gated)
            await gate.promise
          return real.tryHold()
        },
        steal,
      },
      confirm: async () => CURRENT,
      lose: vi.fn(),
      onSuperseded: vi.fn(),
      clock: time.clock,
    })
    expect(await lock.claim()).toEqual({ kind: 'held' })
    gated = true
    const stale = await sameBrowserFor(DOCUMENT_ID, browser.tab('other')).steal()
    await settle()
    expect(lock.held()).toBe(false)
    expect(lock.stolen()).toBe(false)
    expect(await lock.takenHere(time.now() + WAIT_MS)).toBe(false)
    expect(time.pending()).toBe(0)
    gate.resolve()
    await settle()
    expect(steal).not.toHaveBeenCalled()
    expect(browser.holderOf(LOCK)).toBe('other')
    expect(await settledNow(stale.stolen)).toBe(false)
  })

  it.each([
    ['还没拿', async (_context: ReturnType<typeof setup>) => {}],
    ['拿锁时没拿成（被取代）', async (context: ReturnType<typeof setup>) => {
      await context.other.tryHold()
      context.confirm.mockResolvedValue(SUPERSEDED)
      await context.lock.claim()
    }],
    ['拿锁时没拿成（核对不了）', async (context: ReturnType<typeof setup>) => {
      await context.other.tryHold()
      context.confirm.mockResolvedValue({ kind: 'unknown', error: new Error('断网') })
      await context.lock.claim()
    }],
    ['放下之后', async (context: ReturnType<typeof setup>) => {
      await context.lock.claim()
      context.lock.release()
    }],
  ] as const)('没拿着（%s）：交回 false，不等', async (_case, arrange) => {
    const context = setup()
    await arrange(context)
    expect(await context.lock.takenHere(context.time.now() + WAIT_MS)).toBe(false)
    expect(context.time.pending()).toBe(0)
  })

  it('拿锁还在途时：交回 false，拿到的随即放掉（与放下相同）', async () => {
    const context = setup()
    const claiming = context.lock.claim()
    expect(await context.lock.takenHere(context.time.now() + WAIT_MS)).toBe(false)
    expect(await claiming).toEqual({ kind: 'released' })
    await settle()
    expect(context.browser.holderOf(LOCK)).toBeUndefined()
  })

  it('重复调用交回同一个结果（不再等一轮）', async () => {
    const context = setup()
    await context.lock.claim()
    const first = context.lock.takenHere(context.time.now() + WAIT_MS)
    const second = context.lock.takenHere(context.time.now() + WAIT_MS * 2)
    expect(context.time.pending()).toBe(1)
    await stolenByOther(context)
    expect([await first, await second]).toEqual([true, true])
  })

  it('浏览器没有锁（退化）：句柄从不被抢——等到时交回 false', async () => {
    const time = fakeLeaseClock()
    const lock = holdLocalLock({ browser: sameBrowserFor(DOCUMENT_ID, { locks: undefined, openChannel: undefined }), confirm: vi.fn(), lose: vi.fn(), onSuperseded: vi.fn(), clock: time.clock })
    await lock.claim()
    const located = lock.takenHere(time.now() + WAIT_MS)
    await time.advance(WAIT_MS)
    expect(await located).toBe(false)
  })
})

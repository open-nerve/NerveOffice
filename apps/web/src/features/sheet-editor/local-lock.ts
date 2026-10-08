// 本机锁的持有（M3-P5 设计 §3.1；争用以服务端的事实裁决，M3-P6 设计 §3.13，Codex 评审 CX2）。不依赖 Univer 与界面；锁（same-browser.ts）
// 与核对（edit-lease.ts 的 confirm）都注入，用假的做单元测试（local-lock.test.ts）。编辑模式（edit-mode.ts）每取得一代编辑权建一个，
// 离开编辑（退出、交出、失去编辑权、没能进入）、页面关闭与卸载时放下。
// 本机锁只用来让同一个浏览器里的另一页及时得知，不是事实的来源：申请成功的回包说明不了"这一代此刻仍是当前的"（服务端批准之后、回包到达之前
// 可能已经再换代），锁被抢也说明不了"这一代已经失效"（抢的一方可能拿着更旧的批准）。争用一律问服务端（续租一次，confirm）：
// - 拿锁（claim，服务端批准之后）：锁空着就拿；被本浏览器的别的标签页占着时先核对——这一代是当前的才抢（那一页拿着的那一代必然已被取代，
//   抢它只是让它及时得知）；不是当前的就不抢（服务端认的是别的页面，页面放弃这一代）；核对不了（断网、出错、会话的问题）也不抢；
// - 被抢（stolen）：先核对——仍是当前的，抢的一方拿着的是旧的批准，把锁拿回来、照常编辑；不再是当前的才算被取代（onSuperseded，页面失去编辑权）；
//   核对不了时不把自己判为失效、也不抢，这期间不持有锁（不回应交接请求，别的标签页看到的是抢走它的那一页），等之后的心跳给出结论：续租成功
//   （renewed）就拿回来，失效照心跳已有的处理（页面经租约得知）；
// - 不会来回抢个不停：每次抢之前都核对过（看到争用之后才发出的续租），服务端任一时刻只认一代；核对得知不是当前的，页面随即放弃那一代
//   （租约 abandon），不再为它抢锁。核对的回包同样可能迟到（服务端处理时还是当前的、到达之前又换了代）：至多多抢一次，被抢的一方核对之后
//   拿回来，迟到的一方下一次核对就得知已被取代。
import type { LeaseClock, LeaseLoss, LeaseVerdict } from './edit-lease.ts'
import type { HandoverTrace } from './handover-trace.ts'
import type { HeldLock, SameBrowser } from './same-browser.ts'

/**
 * 拿锁的结果：held 拿到了；superseded 锁被占着、核对得知这一代已经不是当前的（loss 是服务端说的原因，没有时 undefined；调用方放弃那一代，
 * 不释放）；unverified 锁被占着、核对不了（error 是那次的错误，暂停着没发时 undefined）；released 期间放下了（页面关闭）：不论裁决，不再拿
 */
export type LockClaim
  = | { readonly kind: 'held' }
    | { readonly kind: 'superseded', readonly loss: LeaseLoss | undefined }
    | { readonly kind: 'unverified', readonly error: unknown }
    | { readonly kind: 'released' }

export interface LocalLockOptions {
  /** 这份文档的本机锁（same-browser.ts） */
  readonly browser: Pick<SameBrowser, 'tryHold' | 'steal'>
  /** 核对这一代此刻是不是服务端当前的（edit-lease.ts 的 confirm：只问、不改这一代） */
  readonly confirm: () => Promise<LeaseVerdict>
  /** 锁被抢之后核对得知这一代已经不是当前的：页面放弃这一代、失去编辑权（loss 是服务端说的原因，没有时 undefined） */
  readonly onSuperseded: (loss: LeaseLoss | undefined) => void
  /** 观察钩子的时刻（编辑模式的单调时钟） */
  readonly clock: LeaseClock
  /** 测试构建的观察钩子（handover-trace.ts）：锁被抢、核对的裁决；生产不给 */
  readonly trace?: HandoverTrace | undefined
}

export interface LocalLock {
  /** 拿锁（服务端批准之后，每个只调用一次）：见文件头 */
  readonly claim: () => Promise<LockClaim>
  /** 这一代的心跳续租成功了（此刻是服务端当前的）：被抢之后没能核对、不持有锁时，这时拿回来；别的时候什么也不做 */
  readonly renewed: () => void
  /** 现在持有锁（交接请求只在持有时回应） */
  readonly held: () => boolean
  /**
   * 锁被抢了、还没有结论（核对中，或者核对不了、在等心跳）：这期间得知的失效，抢走锁的是本浏览器的另一个标签页（页面据此说那边接手了，
   * edit-mode.ts 的 supersededLoss）
   */
  readonly stolen: () => boolean
  /** 放下（离开编辑、页面关闭、卸载）：拿着的随即放开，之后不再拿，被抢、核对的结果都不再算。重复调用无害 */
  readonly release: () => void
}

/**
 * 进展：idle 还没拿；claiming 在拿（锁空着就拿，被占着先核对，核对过是当前的就抢）；held 拿着；verifying 被抢了、在核对；awaiting 被抢之后
 * 核对不了、等心跳；done 拿锁时得知不是当前的、核对不了（不再拿），或者被抢之后得知已被取代；released 放下了
 */
type Phase = 'idle' | 'claiming' | 'held' | 'verifying' | 'awaiting' | 'done' | 'released'

const HELD: LockClaim = { kind: 'held' }
const RELEASED: LockClaim = { kind: 'released' }

/** 这一代编辑权的本机锁（见文件头） */
export function holdLocalLock(options: LocalLockOptions): LocalLock {
  const { browser, clock } = options
  let phase: Phase = 'idle'
  let handle: HeldLock | undefined

  /**
   * 现在的进展。经函数读：拿锁、核对之间隔着请求，期间页面随时可能放下（release）、锁随时可能被抢，每次都要读现在的值
   */
  function now(): Phase {
    return phase
  }

  /** 拿到了：还要它就留着、盯着被抢；期间放下了就随即放掉。交回留下了没有 */
  function adopt(taken: HeldLock): boolean {
    if (now() === 'released') {
      taken.release()
      return false
    }
    phase = 'held'
    handle = taken
    void taken.stolen.then(async () => stolen(taken))
    return true
  }

  /** 核对过这一代是当前的（或者心跳刚续上）：拿锁——空着就拿，被占着就抢 */
  async function take(): Promise<boolean> {
    phase = 'claiming'
    return adopt((await browser.tryHold()) ?? (await browser.steal()))
  }

  /** 被抢（见文件头）：已经放下的、换过的那一把被抢不算 */
  async function stolen(taken: HeldLock): Promise<void> {
    if (handle !== taken || now() !== 'held')
      return
    handle = undefined
    phase = 'verifying'
    options.trace?.({ kind: 'lock-stolen', at: clock.now() })
    const verdict = await options.confirm()
    if (now() !== 'verifying')
      return
    options.trace?.({ kind: 'lock-verdict', at: clock.now(), when: 'stolen', verdict: verdict.kind })
    switch (verdict.kind) {
      case 'current':
        await take()
        return
      case 'ended':
        phase = 'done'
        options.onSuperseded(verdict.loss)
        return
      case 'unknown':
        phase = 'awaiting'
    }
  }

  return {
    claim: async () => {
      phase = 'claiming'
      const free = await browser.tryHold()
      if (free !== undefined)
        return adopt(free) ? HELD : RELEASED
      const verdict = await options.confirm()
      if (now() === 'released')
        return RELEASED
      options.trace?.({ kind: 'lock-verdict', at: clock.now(), when: 'claim', verdict: verdict.kind })
      switch (verdict.kind) {
        case 'current':
          return (await take()) ? HELD : RELEASED
        case 'ended':
          phase = 'done'
          return { kind: 'superseded', loss: verdict.loss }
        case 'unknown':
          phase = 'done'
          return { kind: 'unverified', error: verdict.error }
      }
    },
    renewed: () => {
      if (now() === 'awaiting')
        void take()
    },
    held: () => now() === 'held',
    stolen: () => now() === 'verifying' || now() === 'awaiting',
    release: () => {
      phase = 'released'
      const taken = handle
      handle = undefined
      taken?.release()
    },
  }
}

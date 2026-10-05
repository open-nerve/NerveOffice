// 打开自检的上报：进程内的去重与按账户限量（M3-P4 设计 §3.13）。上报只作诊断，日志不能被刷：
// - 去重：同一份文档、同一个修订号、同一组失败（签名）、同一个页面构建，10 分钟之内只记第一次（谁报的都一样：打开一份坏文档的人越多，
//   重复的越多）；
// - 限量：每个账户每 10 分钟至多采纳 20 条（去重挡下的不算），超出的照样回 204、不记，每个窗口只记一条"上报过多"。
// 状态只在这个进程的内存里（单实例首发，ADR-012）：每个进程各自计数，重启清零。时间用进程自己的单调时钟（performance.now()）：
// 这是进程内的计时，不是业务里的时间判断（规范 §5"与时间有关的判断用数据库时间"管的是落库、跨进程的判断），墙上时钟被调整时也不受影响。
// 键的数量有上限：先清掉过期的，仍超出时丢最旧的（最坏只是多记一条日志）
import type { OpenCheckFailure } from '@nerve-office/contracts'
import { performance } from 'node:perf_hooks'
import { compareOpenCheckFailures } from '@nerve-office/contracts'

/** 去重与限量的窗口：10 分钟 */
export const OPEN_CHECK_REPORT_WINDOW_MS = 10 * 60 * 1000

/** 每个账户每个窗口至多采纳几条 */
export const OPEN_CHECK_REPORTS_PER_ACCOUNT = 20

/** 去重键与账户各自至多记多少个 */
export const OPEN_CHECK_REPORT_MAX_KEYS = 10_000

/**
 * 一次上报的结果：accept 采纳（记一条日志）；duplicate 窗口之内已经记过同样的；throttled-first 这个账户这个窗口里第一次超出
 * （记一条"上报过多"）；throttled 之后的超出（什么也不记）
 */
export type OpenCheckReportDecision = 'accept' | 'duplicate' | 'throttled-first' | 'throttled'

export interface OpenCheckReportGateOptions {
  /** 单调时钟（毫秒），测试注入假的 */
  readonly now?: () => number
  readonly windowMs?: number
  readonly perAccount?: number
  readonly maxKeys?: number
}

/** 一个账户在当前窗口里的计数 */
interface AccountWindow {
  readonly startedAt: number
  accepted: number
  throttled: boolean
}

/** 失败清单的规范形式：去掉完全相同的、排好序（日志里记它，去重的签名也按它算） */
export function normalizedFailures(failures: readonly OpenCheckFailure[]): OpenCheckFailure[] {
  const unique = new Map(failures.map(failure => [JSON.stringify([failure.kind, failure.resource, failure.error ?? null]), failure]))
  return [...unique.values()].sort(compareOpenCheckFailures)
}

/** 去重键：文档、修订号、页面构建与失败的签名（规范形式），写成 JSON 数组（各段里有什么字符都不会串到别的段） */
export function openCheckReportKey(documentId: string, revision: number, clientBuild: string, failures: readonly OpenCheckFailure[]): string {
  return JSON.stringify([documentId, revision, clientBuild, normalizedFailures(failures).map(failure => [failure.kind, failure.resource, failure.error ?? null])])
}

export class OpenCheckReportGate {
  readonly #now: () => number
  readonly #windowMs: number
  readonly #perAccount: number
  readonly #maxKeys: number
  /** 去重键 → 记下的时刻。时钟单调，插入的先后就是时刻的先后：过期的都在前头 */
  readonly #seen = new Map<string, number>()
  /** 账户 → 当前窗口。窗口重开时删掉再放进去，插入的先后就是窗口起点的先后 */
  readonly #accounts = new Map<string, AccountWindow>()

  constructor(options: OpenCheckReportGateOptions = {}) {
    this.#now = options.now ?? (() => performance.now())
    this.#windowMs = options.windowMs ?? OPEN_CHECK_REPORT_WINDOW_MS
    this.#perAccount = options.perAccount ?? OPEN_CHECK_REPORTS_PER_ACCOUNT
    this.#maxKeys = options.maxKeys ?? OPEN_CHECK_REPORT_MAX_KEYS
  }

  /** 这一次上报（账户、去重键）该怎么处理；采纳的同时记下去重键、计入这个账户的窗口 */
  decide(accountId: string, key: string): OpenCheckReportDecision {
    const now = this.#now()
    this.#expire(now)
    if (this.#seen.has(key))
      return 'duplicate'
    const window = this.#windowOf(accountId, now)
    if (window.accepted >= this.#perAccount) {
      if (window.throttled)
        return 'throttled'
      window.throttled = true
      return 'throttled-first'
    }
    window.accepted += 1
    this.#seen.set(key, now)
    this.#cap(this.#seen)
    return 'accept'
  }

  /** 现在记着的去重键与账户的个数（测试看内存有没有界） */
  sizes(): { readonly keys: number, readonly accounts: number } {
    return { keys: this.#seen.size, accounts: this.#accounts.size }
  }

  /** 这个账户的当前窗口：没有或者到期了就重开一个（放到最后） */
  #windowOf(accountId: string, now: number): AccountWindow {
    const current = this.#accounts.get(accountId)
    if (current !== undefined && now - current.startedAt < this.#windowMs)
      return current
    this.#accounts.delete(accountId)
    const opened: AccountWindow = { startedAt: now, accepted: 0, throttled: false }
    this.#accounts.set(accountId, opened)
    this.#cap(this.#accounts)
    return opened
  }

  /** 从头上清掉过期的去重键与账户窗口 */
  #expire(now: number): void {
    for (const [key, at] of this.#seen) {
      if (now - at < this.#windowMs)
        break
      this.#seen.delete(key)
    }
    for (const [account, window] of this.#accounts) {
      if (now - window.startedAt < this.#windowMs)
        break
      this.#accounts.delete(account)
    }
  }

  /** 超出上限时丢最旧的 */
  #cap(entries: Map<string, unknown>): void {
    for (const key of entries.keys()) {
      if (entries.size <= this.#maxKeys)
        break
      entries.delete(key)
    }
  }
}

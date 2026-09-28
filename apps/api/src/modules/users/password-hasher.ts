import type { SemaphoreLimits } from '../../shared/semaphore.ts'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { hash, parseOptions, verify } from '@node-rs/argon2'
import { Semaphore, SemaphoreBusyError } from '../../shared/semaphore.ts'

/** 等待哈希的排队满了或等待超时（登录洪水，DEF-015）：这次没有计算，调用方按"服务繁忙"处理 */
export class PasswordHashingBusyError extends Error {
  /** @param retryAfterSeconds 建议多久之后再试：排队等待的时限（向上取整到秒） */
  constructor(readonly retryAfterSeconds: number, options?: ErrorOptions) {
    super('等待密码哈希的请求太多', options)
    this.name = 'PasswordHashingBusyError'
  }
}

/** 密码哈希（P3 设计 §3.4）：业务代码依赖这个抽象，单元测试用假实现。 */
export abstract class PasswordHasher {
  abstract hash(password: string): Promise<string>
  /**
   * 验证密码。验证失败时，耗时补到"失败的时限"（当前参数与见过的各组参数里最慢的那组）：调整参数之后，
   * 没再登录过的账户还是旧参数的哈希，失败的耗时也要与"用户名不存在"相同，不暴露账户是否存在（Codex 评审 CX4）
   */
  abstract verify(passwordHash: string, password: string): Promise<boolean>
  /** 哈希用的参数与当前配置不同（例如调高了内存）：下次登录成功时应该重新哈希 */
  abstract needsRehash(passwordHash: string): boolean
  /** 库里现存哈希的参数（PHC 字符串的参数段，例如 m=19456,t=2,p=1）：没见过的各算几次，失败的时限至少补到其中最慢的；认不出的忽略 */
  abstract observe(parameterSegments: readonly string[]): Promise<void>
}

export interface Argon2Parameters {
  readonly memoryKib: number
  readonly iterations: number
  readonly parallelism: number
}

/** @node-rs/argon2 的 Algorithm.Argon2id。它是 ambient const enum，isolatedModules 下不能直接引用；库的默认算法就是它 */
const ARGON2ID = 2

/** 计算用到的 @node-rs/argon2 的函数与时钟：单元测试注入假的，核对补齐的时长 */
export interface Argon2Runtime {
  readonly hash: typeof hash
  readonly verify: typeof verify
  /** 单调的毫秒时钟 */
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const DEFAULT_RUNTIME: Argon2Runtime = { hash, verify, now: () => performance.now(), sleep: async ms => delay(ms) }

/** 每组参数记下最近几次计算的耗时，按中位数估计：一次偶然的慢（垃圾回收、别的负载）不会抬高时限 */
const DURATION_SAMPLES = 7
/** 库里现存、还没见过的参数组，各算几次作为校准 */
const CALIBRATION_RUNS = 3
/**
 * 失败的时限是最慢那组参数的耗时中位数的这么多倍：留出余量，绝大多数失败的耗时由补齐决定，
 * 而不是各自计算的快慢，耗时的分布与账户的哈希参数无关
 */
const FAILURE_TIME_MARGIN = 1.2

/** 一组参数的键 */
function parametersKey(memoryKib: number, iterations: number, parallelism: number): string {
  return `m=${memoryKib},t=${iterations},p=${parallelism}`
}

/** PHC 参数段（m=19456,t=2,p=1）→ 参数；认不出时是 undefined */
function segmentParameters(segment: string): Argon2Parameters | undefined {
  const fields = new Map(segment.split(',').map((field) => {
    const [key = '', value = ''] = field.split('=', 2)
    return [key, value] as const
  }))
  const [memoryKib, iterations, parallelism] = ['m', 't', 'p'].map(key => Number(fields.get(key)))
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value > 0
  return valid(memoryKib) && valid(iterations) && valid(parallelism) ? { memoryKib, iterations, parallelism } : undefined
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * Argon2id（00 号计划书 §11.1），@node-rs/argon2 在 libuv 的线程池里计算，不阻塞事件循环。
 * 同时进行的计算有上限（配置，默认 2，是线程池默认 4 个线程的一半）：线程池也负责读文件（托管前端产物）
 * 与解析域名（连接数据库），登录洪水占满线程池时它们都会停住（P3 审查 A5）。超出的计算排队；
 * 排队的长度与等待的时长也有上限（DEF-015），超出时抛出 PasswordHashingBusyError。
 */
export class Argon2PasswordHasher extends PasswordHasher {
  readonly #slots: Semaphore
  readonly #retryAfterSeconds: number
  readonly #runtime: Argon2Runtime
  /**
   * 各组参数最近几次计算的耗时（毫秒）：验证、哈希与校准都记（Codex 评审 CX4）。
   * 按实测的耗时补齐，不按"内存 × 迭代次数"换算：内存大小不同时每块内存的耗时也不同（缓存、内存带宽、分配），
   * 换算的残差足以分辨账户是否存在（独立复验 N2：内存 256 MiB 调到 19 MiB 时耗时之比 1.54）
   */
  readonly #durations = new Map<string, number[]>()

  constructor(private readonly parameters: Argon2Parameters, concurrency: number, queue: SemaphoreLimits = {}, runtime: Partial<Argon2Runtime> = {}) {
    super()
    this.#slots = new Semaphore(concurrency, queue)
    this.#retryAfterSeconds = Math.max(1, Math.ceil((queue.maxWaitMs ?? 0) / 1000))
    this.#runtime = { ...DEFAULT_RUNTIME, ...runtime }
  }

  async hash(password: string): Promise<string> {
    const { memoryKib, iterations, parallelism } = this.parameters
    return this.#limited(async () => this.#timed(parametersKey(memoryKib, iterations, parallelism), async () => this.#runtime.hash(password, {
      memoryCost: memoryKib,
      timeCost: iterations,
      parallelism,
    })))
  }

  /**
   * 存的哈希格式不对说明数据损坏，直接抛出，不当作"密码错误"。
   * 失败时在同一个名额里等到失败的时限：补的那部分不再排一次队，排队的时间与名额的占用都不因账户的哈希参数而不同
   */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    return this.#limited(async () => {
      const options = parseOptions(passwordHash)
      const key = parametersKey(options.memoryCost, options.timeCost, options.parallelism)
      const started = this.#runtime.now()
      const matches = await this.#timed(key, async () => this.#runtime.verify(passwordHash, password))
      if (!matches) {
        const remaining = this.#failureTimeMs() - (this.#runtime.now() - started)
        if (remaining > 0)
          await this.#runtime.sleep(remaining)
      }
      return matches
    })
  }

  /** 参数调低之后，旧参数的哈希更慢：没见过的参数组各算几次，之后的失败（包括用户名不存在）都补到它 */
  async observe(parameterSegments: readonly string[]): Promise<void> {
    for (const parameters of new Map(parameterSegments.map(segmentParameters).filter(item => item !== undefined).map(item => [parametersKey(item.memoryKib, item.iterations, item.parallelism), item])).values()) {
      const key = parametersKey(parameters.memoryKib, parameters.iterations, parameters.parallelism)
      if (this.#durations.has(key))
        continue
      for (let run = 0; run < CALIBRATION_RUNS; run++) {
        await this.#limited(async () => this.#timed(key, async () => this.#runtime.hash(randomBytes(32), {
          memoryCost: parameters.memoryKib,
          timeCost: parameters.iterations,
          parallelism: parameters.parallelism,
        })))
      }
    }
  }

  /** 执行一次计算，记下它的耗时 */
  async #timed<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const started = this.#runtime.now()
    const result = await compute()
    const samples = [...(this.#durations.get(key) ?? []), this.#runtime.now() - started].slice(-DURATION_SAMPLES)
    this.#durations.set(key, samples)
    return result
  }

  /** 失败的时限：各组参数耗时中位数里最慢的，乘以余量 */
  #failureTimeMs(): number {
    return Math.max(0, ...[...this.#durations.values()].map(median)) * FAILURE_TIME_MARGIN
  }

  async #limited<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await this.#slots.run(task)
    }
    catch (error) {
      if (error instanceof SemaphoreBusyError)
        throw new PasswordHashingBusyError(this.#retryAfterSeconds, { cause: error })
      throw error
    }
  }

  needsRehash(passwordHash: string): boolean {
    const options = parseOptions(passwordHash)
    return options.algorithm !== ARGON2ID
      || options.memoryCost !== this.parameters.memoryKib
      || options.timeCost !== this.parameters.iterations
      || options.parallelism !== this.parameters.parallelism
  }
}

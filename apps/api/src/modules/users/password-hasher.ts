import type { SemaphoreLimits } from '../../shared/semaphore.ts'
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
   * 验证密码。验证失败时的计算与 reject 相同：当前参数与见过的各组参数按同一个顺序各算一次，账户自己那组就是这次比对。
   * 调整参数之后，没再登录过的账户还是旧参数的哈希，失败的耗时也与"用户名不存在"相同，不暴露账户是否存在（Codex 评审 CX4）
   */
  abstract verify(passwordHash: string, password: string): Promise<boolean>
  /** 没有可以比对的哈希（用户名不存在、账户已停用）：与验证失败做同样的计算，结果总是不通过 */
  abstract reject(password: string): Promise<false>
  /** 哈希用的参数与当前配置不同（例如调高了内存）：下次登录成功时应该重新哈希 */
  abstract needsRehash(passwordHash: string): boolean
  /** 库里现存哈希的参数（PHC 字符串的参数段，例如 m=19456,t=2,p=1）：记下没见过的各组，之后的失败与 reject 都把它们各算一次；认不出的忽略 */
  abstract observe(parameterSegments: readonly string[]): void
}

export interface Argon2Parameters {
  readonly memoryKib: number
  readonly iterations: number
  readonly parallelism: number
}

/** @node-rs/argon2 的 Algorithm.Argon2id。它是 ambient const enum，isolatedModules 下不能直接引用；库的默认算法就是它 */
const ARGON2ID = 2

/** 计算用到的 @node-rs/argon2 的函数：单元测试注入假的，核对每条路径按什么顺序算了哪几组参数 */
export interface Argon2Runtime {
  readonly hash: typeof hash
  readonly verify: typeof verify
}

const DEFAULT_RUNTIME: Argon2Runtime = { hash, verify }

/** 一组参数的键 */
function parametersKey(parameters: Argon2Parameters): string {
  return `m=${parameters.memoryKib},t=${parameters.iterations},p=${parameters.parallelism}`
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
   * 当前参数之外见过的各组参数（键 → 参数）：库里现存的（observe）与验证时遇到的。失败的验证与 reject 按 #groups 的顺序把每组各算一次，
   * 两条路径做的计算相同，耗时的分布就相同，与机器快慢、负载的起落都无关（ADR-007）。
   * 原来按各组实测耗时的中位数补齐（等到最慢那组的 1.2 倍）：等待不随负载变慢、计算会，负载爬升时中位数跟不上，两条路径的耗时就分开了
   * ——M2-P6 第 6 片合并之后 CI 上耗时之比 0.67，本机构造负载爬升复现到 0.64 与 2.5
   */
  readonly #seen = new Map<string, Argon2Parameters>()

  constructor(private readonly parameters: Argon2Parameters, concurrency: number, queue: SemaphoreLimits = {}, runtime: Partial<Argon2Runtime> = {}) {
    super()
    this.#slots = new Semaphore(concurrency, queue)
    this.#retryAfterSeconds = Math.max(1, Math.ceil((queue.maxWaitMs ?? 0) / 1000))
    this.#runtime = { ...DEFAULT_RUNTIME, ...runtime }
  }

  async hash(password: string): Promise<string> {
    return this.#limited(async () => this.#hashWith(this.parameters, password))
  }

  /**
   * 存的哈希格式不对说明数据损坏，直接抛出，不当作"密码错误"。
   * 按 #groups 的顺序走：账户自己那组做真正的比对，通过就返回；其余各组用这次的密码与随机的盐各算一次、结果丢弃。
   * 失败时每组恰好算了一次，与 reject 相同。都在同一个名额里：排队的时间与名额的占用也与账户的哈希参数无关
   */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    return this.#limited(async () => {
      const options = parseOptions(passwordHash)
      const own: Argon2Parameters = { memoryKib: options.memoryCost, iterations: options.timeCost, parallelism: options.parallelism }
      this.#remember(own)
      for (const group of this.#groups()) {
        if (parametersKey(group) !== parametersKey(own))
          await this.#hashWith(group, password)
        else if (await this.#runtime.verify(passwordHash, password))
          return true
      }
      return false
    })
  }

  async reject(password: string): Promise<false> {
    return this.#limited(async () => {
      for (const group of this.#groups())
        await this.#hashWith(group, password)
      return false as const
    })
  }

  observe(parameterSegments: readonly string[]): void {
    for (const parameters of parameterSegments.map(segmentParameters)) {
      if (parameters !== undefined)
        this.#remember(parameters)
    }
  }

  needsRehash(passwordHash: string): boolean {
    const options = parseOptions(passwordHash)
    return options.algorithm !== ARGON2ID
      || options.memoryCost !== this.parameters.memoryKib
      || options.timeCost !== this.parameters.iterations
      || options.parallelism !== this.parameters.parallelism
  }

  #remember(parameters: Argon2Parameters): void {
    const key = parametersKey(parameters)
    if (key !== parametersKey(this.parameters))
      this.#seen.set(key, parameters)
  }

  /**
   * 失败的验证与 reject 都按这个顺序把每组算一次：当前参数在前（绝大多数账户的哈希用它，验证通过时不多算），其余按键排序。
   * 顺序相同，负载在计算之间起落时两条路径受的影响也相同
   */
  #groups(): Argon2Parameters[] {
    return [this.parameters, ...[...this.#seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, parameters]) => parameters)]
  }

  /** 用这组参数算一次哈希（盐由库随机生成） */
  async #hashWith(parameters: Argon2Parameters, password: string): Promise<string> {
    return this.#runtime.hash(password, { memoryCost: parameters.memoryKib, timeCost: parameters.iterations, parallelism: parameters.parallelism })
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
}

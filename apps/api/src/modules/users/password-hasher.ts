import type { SemaphoreLimits } from '../../shared/semaphore.ts'
import { randomBytes } from 'node:crypto'
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
   * 验证密码。验证失败时，这次的计算量补到"失败的计算量"（当前参数与见过的哈希里最大的那个）：调整参数之后，
   * 没再登录过的账户还是旧参数的哈希，失败的耗时也要与"用户名不存在"相同，不暴露账户是否存在（Codex 评审 CX4）
   */
  abstract verify(passwordHash: string, password: string): Promise<boolean>
  /** 哈希用的参数与当前配置不同（例如调高了内存）：下次登录成功时应该重新哈希 */
  abstract needsRehash(passwordHash: string): boolean
  /** 库里现存哈希的参数（PHC 字符串的参数段，例如 m=19456,t=2,p=1）：失败的计算量至少补到其中最大的；认不出的忽略 */
  abstract observe(parameterSegments: readonly string[]): void
}

export interface Argon2Parameters {
  readonly memoryKib: number
  readonly iterations: number
  readonly parallelism: number
}

/** @node-rs/argon2 的 Algorithm.Argon2id。它是 ambient const enum，isolatedModules 下不能直接引用；库的默认算法就是它 */
const ARGON2ID = 2

/** Argon2 的内存下限（KiB，并行度为 1 时） */
const MIN_MEMORY_KIB = 8

/** 计算用到的 @node-rs/argon2 的函数：单元测试注入假的，核对补的计算量 */
export interface Argon2Functions {
  readonly hash: typeof hash
  readonly verify: typeof verify
}

/**
 * Argon2 的计算量：内存（KiB）× 迭代次数，即处理的内存块数（Codex 评审 CX4）。
 * 并行度按 1 估算（默认就是 1）；每次计算的固定开销（初始化、分配内存）不计，补齐之后有小的残差。
 */
function work(memoryKib: number, iterations: number): number {
  return memoryKib * iterations
}

/** PHC 参数段（m=19456,t=2,p=1）的计算量；认不出时是 undefined */
function segmentWork(segment: string): number | undefined {
  const fields = new Map(segment.split(',').map((field) => {
    const [key = '', value = ''] = field.split('=', 2)
    return [key, value] as const
  }))
  const memoryKib = Number(fields.get('m'))
  const iterations = Number(fields.get('t'))
  return Number.isSafeInteger(memoryKib) && Number.isSafeInteger(iterations) && memoryKib > 0 && iterations > 0 ? work(memoryKib, iterations) : undefined
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
  readonly #argon2: Argon2Functions
  /** 失败的验证至少要做的计算量：当前参数与见过的哈希（验证过的、库里现存的）里最大的（Codex 评审 CX4） */
  #failureWork: number

  constructor(private readonly parameters: Argon2Parameters, concurrency: number, queue: SemaphoreLimits = {}, argon2: Argon2Functions = { hash, verify }) {
    super()
    this.#slots = new Semaphore(concurrency, queue)
    this.#retryAfterSeconds = Math.max(1, Math.ceil((queue.maxWaitMs ?? 0) / 1000))
    this.#argon2 = argon2
    this.#failureWork = work(parameters.memoryKib, parameters.iterations)
  }

  async hash(password: string): Promise<string> {
    return this.#limited(async () => this.#argon2.hash(password, {
      memoryCost: this.parameters.memoryKib,
      timeCost: this.parameters.iterations,
      parallelism: this.parameters.parallelism,
    }))
  }

  /**
   * 存的哈希格式不对说明数据损坏，直接抛出，不当作"密码错误"。
   * 验证与失败时补的计算在同一个名额里：补的那部分不再排一次队，排队的时间不因账户的哈希参数而不同
   */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    return this.#limited(async () => {
      const options = parseOptions(passwordHash)
      const hashWork = work(options.memoryCost, options.timeCost)
      // 参数调低之后，旧参数的哈希计算量更大：之后的失败（包括用户名不存在）都补到它
      this.#failureWork = Math.max(this.#failureWork, hashWork)
      const matches = await this.#argon2.verify(passwordHash, password)
      if (!matches)
        await this.#pad(this.#failureWork - hashWork)
      return matches
    })
  }

  observe(parameterSegments: readonly string[]): void {
    for (const segment of parameterSegments)
      this.#failureWork = Math.max(this.#failureWork, segmentWork(segment) ?? 0)
  }

  /**
   * 补上 amount 的计算量：对随机输入做 Argon2 哈希，结果丢掉。内存不超过当前参数的内存（参数调高很多时，
   * 按"内存 × 迭代次数"一次补齐要分配几倍的内存）：先按当前的内存做 floor(amount / 内存) 次迭代，余数不少于内存下限时
   * 再做一次余数大小的内存、一次迭代
   */
  async #pad(amount: number): Promise<void> {
    const memoryKib = this.parameters.memoryKib
    const iterations = Math.floor(amount / memoryKib)
    if (iterations >= 1)
      await this.#argon2.hash(randomBytes(32), { memoryCost: memoryKib, timeCost: iterations, parallelism: 1 })
    const rest = amount - iterations * memoryKib
    if (rest >= MIN_MEMORY_KIB)
      await this.#argon2.hash(randomBytes(32), { memoryCost: rest, timeCost: 1, parallelism: 1 })
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

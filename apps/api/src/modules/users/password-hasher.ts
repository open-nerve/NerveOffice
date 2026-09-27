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
  abstract verify(passwordHash: string, password: string): Promise<boolean>
  /** 哈希用的参数与当前配置不同（例如调高了内存）：下次登录成功时应该重新哈希 */
  abstract needsRehash(passwordHash: string): boolean
}

export interface Argon2Parameters {
  readonly memoryKib: number
  readonly iterations: number
  readonly parallelism: number
}

/** @node-rs/argon2 的 Algorithm.Argon2id。它是 ambient const enum，isolatedModules 下不能直接引用；库的默认算法就是它 */
const ARGON2ID = 2

/**
 * Argon2id（00 号计划书 §11.1），@node-rs/argon2 在 libuv 的线程池里计算，不阻塞事件循环。
 * 同时进行的计算有上限（配置，默认 2，是线程池默认 4 个线程的一半）：线程池也负责读文件（托管前端产物）
 * 与解析域名（连接数据库），登录洪水占满线程池时它们都会停住（P3 审查 A5）。超出的计算排队；
 * 排队的长度与等待的时长也有上限（DEF-015），超出时抛出 PasswordHashingBusyError。
 */
export class Argon2PasswordHasher extends PasswordHasher {
  readonly #slots: Semaphore
  readonly #retryAfterSeconds: number

  constructor(private readonly parameters: Argon2Parameters, concurrency: number, queue: SemaphoreLimits = {}) {
    super()
    this.#slots = new Semaphore(concurrency, queue)
    this.#retryAfterSeconds = Math.max(1, Math.ceil((queue.maxWaitMs ?? 0) / 1000))
  }

  async hash(password: string): Promise<string> {
    return this.#limited(async () => hash(password, {
      memoryCost: this.parameters.memoryKib,
      timeCost: this.parameters.iterations,
      parallelism: this.parameters.parallelism,
    }))
  }

  /** 存的哈希格式不对说明数据损坏，直接抛出，不当作"密码错误" */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    return this.#limited(async () => verify(passwordHash, password))
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

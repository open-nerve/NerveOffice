import { hash, parseOptions, verify } from '@node-rs/argon2'

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

/** Argon2id（00 号计划书 §11.1），@node-rs/argon2 在 libuv 的线程池里计算，不阻塞事件循环。 */
export class Argon2PasswordHasher extends PasswordHasher {
  constructor(private readonly parameters: Argon2Parameters) {
    super()
  }

  async hash(password: string): Promise<string> {
    return hash(password, {
      memoryCost: this.parameters.memoryKib,
      timeCost: this.parameters.iterations,
      parallelism: this.parameters.parallelism,
    })
  }

  /** 存的哈希格式不对说明数据损坏，直接抛出，不当作"密码错误" */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password)
  }

  needsRehash(passwordHash: string): boolean {
    const options = parseOptions(passwordHash)
    return options.algorithm !== ARGON2ID
      || options.memoryCost !== this.parameters.memoryKib
      || options.timeCost !== this.parameters.iterations
      || options.parallelism !== this.parameters.parallelism
  }
}

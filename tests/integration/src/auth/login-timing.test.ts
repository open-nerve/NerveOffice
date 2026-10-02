// 失败登录的耗时不暴露账户是否存在（ADR-007，Codex 评审 CX4）：调整 Argon2 的参数之后，没再登录过的账户还是旧参数的哈希。
// 验证失败与"用户名不存在"都把当前参数与库里现存的各组参数按同样的顺序各算一次（哈希器的 verify 与 reject），两条路径的计算相同，
// "已有账户、密码错误"与"用户名不存在"的耗时相近；单元测试（password-hasher.test.ts）逐次核对算的是哪几组，这里在真实的应用上量耗时。
// 迭代次数与内存都要测（内存不同时耗时不按"内存 × 迭代次数"换算，独立复验 N2）。少算一组时两者差几倍到十几倍。
// 原来按实测耗时的中位数补齐（等待）：等待不随负载变慢、计算会，M2-P6 第 6 片合并之后 CI 上覆盖率那一轮的负载起落让比值掉到 0.67，
// 本机构造负载爬升复现到 0.64 与 2.5。取样也要经得起负载的起落：每轮按"已有、不存在、不存在、已有"的顺序（ABBA）各发两次，
// 一轮之内负载线性起落时两边受的影响相同；各轮的比值取中位数，偶尔的尖峰被滤掉。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { postLogin } from '../support/session-client.ts'

/** 默认参数（OWASP 的最低推荐） */
const DEFAULT = { memoryKib: 19_456, iterations: 2 }
/** 每种情形取样的轮数（每轮四次请求）；之前预热 2 轮（连接池、JIT） */
const ROUNDS = 9
const WARMUP = 2
/** 取样不能触发限流：按用户名、按地址的上限都调高 */
const THROTTLE = { NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '1000', NERVE_LOGIN_IP_MAX_FAILURES: '1000' }

async function failedLoginMs(baseUrl: string, username: string): Promise<number> {
  const started = performance.now()
  const response = await postLogin(baseUrl, { username, password: 'not the password' })
  await response.arrayBuffer()
  const elapsed = performance.now() - started
  expect(response.status).toBe(401)
  return elapsed
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

/** 按 ABBA 的轮次取样"已有账户、密码错误"与"用户名不存在"：每轮两边耗时之和的比值，返回各轮的中位数 */
async function existingToMissingRatio(baseUrl: string, existing: string): Promise<number> {
  const ratios: number[] = []
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const existingFirst = await failedLoginMs(baseUrl, existing)
    const missingFirst = await failedLoginMs(baseUrl, 'nobody')
    const missingSecond = await failedLoginMs(baseUrl, 'nobody')
    const existingSecond = await failedLoginMs(baseUrl, existing)
    if (round >= WARMUP)
      ratios.push((existingFirst + existingSecond) / (missingFirst + missingSecond))
  }
  return median(ratios)
}

describe.each([
  ['迭代次数调高：没再登录过的账户的哈希更快', DEFAULT, { memoryKib: DEFAULT.memoryKib, iterations: 12 }],
  ['迭代次数调低：没再登录过的账户的哈希更慢', { memoryKib: DEFAULT.memoryKib, iterations: 12 }, DEFAULT],
  ['内存调高：没再登录过的账户的哈希更快', DEFAULT, { memoryKib: 65_536, iterations: DEFAULT.iterations }],
  ['内存调低（256 MiB 到 19 MiB）：没再登录过的账户的哈希更慢', { memoryKib: 262_144, iterations: DEFAULT.iterations }, DEFAULT],
])('Argon2 的参数%s', (_case, stored, current) => {
  let database: TestDatabase
  let app: TestApp

  beforeAll(async () => {
    database = await createTestDatabase()
    await createAccount(database, { username: 'veteran', argon2: { memoryCost: stored.memoryKib, timeCost: stored.iterations, parallelism: 1 } })
    app = await startTestApp({
      databaseUrl: database.url,
      env: { NERVE_PASSWORD_ARGON2_MEMORY_KIB: String(current.memoryKib), NERVE_PASSWORD_ARGON2_ITERATIONS: String(current.iterations), ...THROTTLE },
    })
  }, 60_000)

  afterAll(async () => {
    await app.close()
    await database.drop()
  })

  it('已有账户、密码错误与用户名不存在：耗时的中位数相近', async () => {
    const ratio = await existingToMissingRatio(app.baseUrl, 'veteran')
    expect(ratio, `耗时之比 ${ratio.toFixed(2)}`).toBeGreaterThan(0.8)
    expect(ratio, `耗时之比 ${ratio.toFixed(2)}`).toBeLessThan(1.25)
  }, 120_000)
})

/**
 * 一次失败登录用掉的 CPU 时间（毫秒）：应用在测试进程里运行（support/api-app.ts），哈希在这个进程的 libuv 线程池里算，计在内；
 * 数据库的工作在另一个进程，不计。同样的计算，负载起落时墙上的耗时会变、CPU 时间基本不变
 */
async function failedLoginCpuMs(baseUrl: string, username: string): Promise<number> {
  const started = process.cpuUsage()
  const response = await postLogin(baseUrl, { username, password: 'not the password' })
  await response.arrayBuffer()
  const used = process.cpuUsage(started)
  expect(response.status).toBe(401)
  return (used.user + used.system) / 1000
}

/**
 * 重启之后、旧参数的账户登录之前：哈希器已经从库里读出现存的参数组（observe），不存在的用户名这时就把它算一次。
 * 没读出来时，不存在的用户名只算当前参数（19 MiB），计算量只有旧参数（256 MiB）账户的十几分之一，要等第一次验证到旧参数的账户才补上——
 * 刚重启时最先被试探的那个旧账户就暴露了。上面那组先发已有账户（预热），覆盖不到这一段，这里单独起一个刚启动的应用。
 * 要在旧账户的第一次登录之前取样，没法与它交错，所以比较计算量（CPU 时间）而不是墙上的耗时：一前一后的两批碰上负载的不同起落，
 * 墙上的耗时会差好几倍（本机构造的负载下五次里两次低于 0.5）
 */
describe('Argon2 的参数调低之后重启：旧参数的账户登录之前，不存在的用户名就已经算上库里现存的参数组', () => {
  const STORED = { memoryKib: 262_144, iterations: DEFAULT.iterations }
  /** 每边的请求数：计算量差十几倍，几次的中位数足够，阈值离预期（约 1）与读不出时都很远 */
  const REQUESTS = 5
  let database: TestDatabase
  let app: TestApp

  beforeAll(async () => {
    database = await createTestDatabase()
    await createAccount(database, { username: 'veteran', argon2: { memoryCost: STORED.memoryKib, timeCost: STORED.iterations, parallelism: 1 } })
    app = await startTestApp({
      databaseUrl: database.url,
      env: { NERVE_PASSWORD_ARGON2_MEMORY_KIB: String(DEFAULT.memoryKib), NERVE_PASSWORD_ARGON2_ITERATIONS: String(DEFAULT.iterations), ...THROTTLE },
    })
  }, 60_000)

  afterAll(async () => {
    await app.close()
    await database.drop()
  })

  it('先发不存在的用户名、再发旧参数的账户：前者用掉的 CPU 时间（中位数）不低于后者的一半', async () => {
    const missing: number[] = []
    for (let request = 0; request < REQUESTS; request++)
      missing.push(await failedLoginCpuMs(app.baseUrl, 'nobody'))
    const existing: number[] = []
    for (let request = 0; request < REQUESTS; request++)
      existing.push(await failedLoginCpuMs(app.baseUrl, 'veteran'))
    const ratio = median(missing) / median(existing)
    expect(ratio, `CPU 时间之比 ${ratio.toFixed(2)}`).toBeGreaterThan(0.5)
  }, 120_000)
})

// 失败登录的耗时不暴露账户是否存在（ADR-007，Codex 评审 CX4）：调整 Argon2 的参数之后，没再登录过的账户还是旧参数的哈希。
// 验证失败与"用户名不存在"都把当前参数与库里现存的各组参数按同样的顺序各算一次（哈希器的 verify 与 reject），两条路径的计算相同；
// 单元测试（password-hasher.test.ts）逐次核对算的是哪几组，这里在真实的应用上核对。迭代次数与内存都要测（内存不同时耗时不按
// "内存 × 迭代次数"换算，独立复验 N2）；旧参数与当前参数的账户都要测（只测旧参数的账户，"比对完自己那组就返回""陪算一律用当前参数"
// 这类错只有单元测试检得出）。少算一组时两者差几倍到十几倍。
// 原来按实测耗时的中位数补齐（等待）：等待不随负载变慢、计算会，M2-P6 第 6 片合并之后 CI 上覆盖率那一轮的负载起落让比值掉到 0.67。
// 测法也要经得起负载的起落（复验：只看墙上的耗时，整套集成测试并行跑再加负载时，同样的计算八次里五次越界）：
// - 主判定是计算量：CPU 时间按轮次取样，每轮"旧、不存在、当前、当前、不存在、旧"（回文，三者的平均位置相同），各轮比值取中位数。
//   负载一阵一阵地把一两个请求拉长几倍，墙上的耗时跟着变，CPU 时间不变；
// - 辅判定是墙上耗时的下四分位之比：守只在墙上出现的差别（多出的等待、数据库的往返），负载只会把耗时拉长，下四分位受的影响最小；
// - 前提：量得到哈希的 CPU 时间——应用在测试进程里（support/api-app.ts），哈希在这个进程的 libuv 线程池里算，测试文件各在一个进程里
//   （vitest.config.ts 的 forks）。量不到时（只量主线程、应用挪到子进程）两边都只剩几毫秒、比值约等于 1，判定会悄悄失效，所以核对一次
//   失败的 CPU 时间远多于主线程那一点（复验 R9）。
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
/** 每种情形取样的轮数（每轮六次请求）；之前预热 2 轮（连接池、JIT） */
const ROUNDS = 9
const WARMUP = 2
/** 一次失败的 CPU 时间至少这么多，才说明量到了哈希：下面每种情形一次失败都至少算一次 19 MiB 的 Argon2 加一次更贵的 */
const MIN_HASH_CPU_MS = 20
/** 取样不能触发限流：按用户名、按地址的上限都调高 */
const THROTTLE = { NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_ACCOUNT_MAX_FAILURES: '1000', NERVE_LOGIN_IP_MAX_FAILURES: '1000' }

/** 一次失败登录：墙上的耗时，与这个进程用掉的 CPU 时间（毫秒；含 libuv 线程池里的哈希，不含数据库那边的工作） */
interface Sample {
  readonly wall: number
  readonly cpu: number
}

async function failedLogin(baseUrl: string, username: string): Promise<Sample> {
  const cpuStarted = process.cpuUsage()
  const started = performance.now()
  const response = await postLogin(baseUrl, { username, password: 'not the password' })
  await response.arrayBuffer()
  const wall = performance.now() - started
  const used = process.cpuUsage(cpuStarted)
  expect(response.status).toBe(401)
  return { wall, cpu: (used.user + used.system) / 1000 }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

function lowerQuartile(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 4)] ?? Number.NaN
}

function cpuOf(samples: readonly Sample[]): number {
  return samples.reduce((total, sample) => total + sample.cpu, 0)
}

/** 某一类账户的失败与"用户名不存在"的比较 */
interface Comparison {
  /** CPU 时间：各轮（这类账户两次之和 ÷ 不存在两次之和）的中位数 */
  readonly cpu: number
  /** 墙上耗时：这类账户与不存在各自的下四分位之比 */
  readonly wall: number
  /** 这类账户一次失败的 CPU 时间的中位数（前提核对） */
  readonly accountCpu: number
}

/** 按回文的轮次取样旧参数的账户（veteran）、当前参数的账户（regular）与不存在的用户名，返回两类账户各自与"不存在"的比较 */
async function compareFailures(baseUrl: string): Promise<{ readonly stale: Comparison, readonly current: Comparison }> {
  const rounds: { readonly stale: Sample[], readonly current: Sample[], readonly missing: Sample[] }[] = []
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const staleFirst = await failedLogin(baseUrl, 'veteran')
    const missingFirst = await failedLogin(baseUrl, 'nobody')
    const currentFirst = await failedLogin(baseUrl, 'regular')
    const currentSecond = await failedLogin(baseUrl, 'regular')
    const missingSecond = await failedLogin(baseUrl, 'nobody')
    const staleSecond = await failedLogin(baseUrl, 'veteran')
    if (round >= WARMUP)
      rounds.push({ stale: [staleFirst, staleSecond], current: [currentFirst, currentSecond], missing: [missingFirst, missingSecond] })
  }
  const missingWalls = rounds.flatMap(round => round.missing.map(sample => sample.wall))
  const compare = (side: 'stale' | 'current'): Comparison => ({
    cpu: median(rounds.map(round => cpuOf(round[side]) / cpuOf(round.missing))),
    wall: lowerQuartile(rounds.flatMap(round => round[side].map(sample => sample.wall))) / lowerQuartile(missingWalls),
    accountCpu: median(rounds.flatMap(round => round[side].map(sample => sample.cpu))),
  })
  return { stale: compare('stale'), current: compare('current') }
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
    await createAccount(database, { username: 'regular', argon2: { memoryCost: current.memoryKib, timeCost: current.iterations, parallelism: 1 } })
    app = await startTestApp({
      databaseUrl: database.url,
      env: { NERVE_PASSWORD_ARGON2_MEMORY_KIB: String(current.memoryKib), NERVE_PASSWORD_ARGON2_ITERATIONS: String(current.iterations), ...THROTTLE },
    })
  }, 60_000)

  afterAll(async () => {
    await app.close()
    await database.drop()
  })

  it('旧参数与当前参数的账户密码错误，与用户名不存在：计算量（CPU 时间）与墙上耗时都相近', async () => {
    const comparisons = await compareFailures(app.baseUrl)
    for (const [label, comparison] of [['旧参数的账户', comparisons.stale], ['当前参数的账户', comparisons.current]] as const) {
      expect(comparison.accountCpu, `${label}一次失败的 CPU 时间 ${comparison.accountCpu.toFixed(1)} 毫秒（量到了哈希）`).toBeGreaterThan(MIN_HASH_CPU_MS)
      expect(comparison.cpu, `${label}：CPU 时间之比 ${comparison.cpu.toFixed(2)}`).toBeGreaterThan(0.8)
      expect(comparison.cpu, `${label}：CPU 时间之比 ${comparison.cpu.toFixed(2)}`).toBeLessThan(1.25)
      expect(comparison.wall, `${label}：墙上耗时的下四分位之比 ${comparison.wall.toFixed(2)}`).toBeGreaterThan(0.8)
      expect(comparison.wall, `${label}：墙上耗时的下四分位之比 ${comparison.wall.toFixed(2)}`).toBeLessThan(1.25)
    }
  // 时限：本机最慢的一种（256 MiB 调到 19 MiB，66 次请求）约 12 秒；CI 上测试一步约慢 3.2 倍（M2-P6 第 6 片的实测），
  // 覆盖率那一轮的争用再算 1.5 倍，约 60 秒，留 2 倍
  }, 120_000)
})

/**
 * 重启之后、旧参数的账户登录之前：哈希器已经从库里读出现存的参数组（observe），不存在的用户名这时就把它算一次。
 * 没读出来时，不存在的用户名只算当前参数（19 MiB），计算量只有旧参数（256 MiB）账户的十几分之一，要等第一次验证到旧参数的账户才补上——
 * 刚重启时最先被试探的那个旧账户就暴露了。上面那组先发已有账户（预热），覆盖不到这一段，这里单独起一个刚启动的应用。
 * 要在旧账户的第一次登录之前取样，没法与它交错，所以只比较计算量（CPU 时间）：一前一后的两批碰上负载的不同起落，
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
      missing.push((await failedLogin(app.baseUrl, 'nobody')).cpu)
    const existing: number[] = []
    for (let request = 0; request < REQUESTS; request++)
      existing.push((await failedLogin(app.baseUrl, 'veteran')).cpu)
    expect(median(existing), `旧参数的账户一次失败的 CPU 时间 ${median(existing).toFixed(1)} 毫秒（量到了哈希）`).toBeGreaterThan(MIN_HASH_CPU_MS)
    const ratio = median(missing) / median(existing)
    expect(ratio, `CPU 时间之比 ${ratio.toFixed(2)}`).toBeGreaterThan(0.5)
  }, 120_000)
})

// 失败登录的耗时不暴露账户是否存在（ADR-007，Codex 评审 CX4）：调整 Argon2 的参数之后，没再登录过的账户还是旧参数的哈希，
// 验证失败时由哈希器按实测的耗时补到最慢那组参数（留 1.2 倍的余量），"已有账户、密码错误"与"用户名不存在"的耗时相近。
// 迭代次数与内存都要测：内存不同时耗时不按"内存 × 迭代次数"换算（独立复验 N2：256 MiB 调到 19 MiB 时按计算量补齐，比值 1.54）。
// 不补时两者差几倍到十几倍；补齐之后两者都由补齐决定，中位数之比在 0.8–1.25 之间。比值与机器快慢无关，CI 慢几倍也不影响。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { postLogin } from '../support/session-client.ts'

/** 默认参数（OWASP 的最低推荐） */
const DEFAULT = { memoryKib: 19_456, iterations: 2 }
/** 每种情形的取样次数；之前各预热 2 次（连接池、JIT） */
const SAMPLES = 9
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

/** 交替取样"已有账户、密码错误"与"用户名不存在"，返回两者耗时中位数之比 */
async function existingToMissingRatio(baseUrl: string, existing: string): Promise<number> {
  const samples = { existing: [] as number[], missing: [] as number[] }
  for (let round = 0; round < WARMUP + SAMPLES; round++) {
    const existingMs = await failedLoginMs(baseUrl, existing)
    const missingMs = await failedLoginMs(baseUrl, 'nobody')
    if (round >= WARMUP) {
      samples.existing.push(existingMs)
      samples.missing.push(missingMs)
    }
  }
  return median(samples.existing) / median(samples.missing)
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

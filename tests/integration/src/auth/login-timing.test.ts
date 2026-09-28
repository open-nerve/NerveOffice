// 失败登录的耗时不暴露账户是否存在（ADR-007，Codex 评审 CX4）：调整 Argon2 的参数之后，没再登录过的账户还是旧参数的哈希，
// 验证失败时由哈希器把计算量补到最大的那个，"已有账户、密码错误"与"用户名不存在"的耗时相近。
// 计时的断言留足余量：不补时两者差 6 倍（迭代 2 次对 12 次），补齐之后中位数之比在 0.67–1.5 之间；比值与机器快慢无关，CI 慢几倍也不影响。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { postLogin } from '../support/session-client.ts'

const MEMORY_KIB = 19_456
const FEW_ITERATIONS = 2
const MANY_ITERATIONS = 12
/** 每种情形的取样次数；之前各预热 2 次（连接池、JIT） */
const SAMPLES = 9
const WARMUP = 2
/** 取样不能触发限流：按用户名、按地址的上限都调高 */
const THROTTLE = { NERVE_LOGIN_MAX_FAILURES: '100', NERVE_LOGIN_IP_MAX_FAILURES: '1000' }

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
  ['调高之后：没再登录过的账户的哈希计算量更小', FEW_ITERATIONS, MANY_ITERATIONS],
  ['调低之后：没再登录过的账户的哈希计算量更大', MANY_ITERATIONS, FEW_ITERATIONS],
])('Argon2 的参数%s', (_case, storedIterations, currentIterations) => {
  let database: TestDatabase
  let app: TestApp

  beforeAll(async () => {
    database = await createTestDatabase()
    await createAccount(database, { username: 'veteran', argon2: { memoryCost: MEMORY_KIB, timeCost: storedIterations, parallelism: 1 } })
    app = await startTestApp({ databaseUrl: database.url, env: { NERVE_PASSWORD_ARGON2_ITERATIONS: String(currentIterations), ...THROTTLE } })
  })

  afterAll(async () => {
    await app.close()
    await database.drop()
  })

  it('已有账户、密码错误与用户名不存在：耗时的中位数相近', async () => {
    const ratio = await existingToMissingRatio(app.baseUrl, 'veteran')
    expect(ratio, `耗时之比 ${ratio.toFixed(2)}`).toBeGreaterThan(0.67)
    expect(ratio, `耗时之比 ${ratio.toFixed(2)}`).toBeLessThan(1.5)
  }, 120_000)
})

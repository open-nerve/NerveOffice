// 摆世界共用的那个连接出错（M2-P5 审查 B 的 G2，复现用例改成回归用例）：摆好世界、不调 closeWorld 就删库——删库的 FORCE 断开这个连接，
// pg.Client 发出 'error'。原来没有人接，测试进程里有两个未处理的错误（57P01、Connection terminated unexpectedly），vitest 报出 Errors、
// 整次运行失败。现在：不再有未处理的错误（这个文件跑完 vitest 不报 Errors），错误也看得到——之后用世界摆东西直接失败，带着原来的错误。
// 正常的流程（各矩阵文件在 afterAll 里先 closeWorld 再删库）不经过这里。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { MatrixWorld } from './matrix-world.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { buildMatrixWorld, closeWorld, SEEDING_CONNECTION_BROKEN } from './matrix-world.ts'

let database: TestDatabase
let app: TestApp
let world: MatrixWorld

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  world = await buildMatrixWorld(database, app)
})

afterAll(async () => {
  // 连接已经断开：关掉照样立即结束，不挂住
  await closeWorld(world)
  await app.close()
  // 库在用例里已经删过：删库是幂等的（DROP … IF EXISTS，库不在时跳过不变量的扫描）
  await database.drop()
})

describe('摆世界的连接：删库之前忘了 closeWorld', () => {
  it('删库断开了它：错误被接住、记下，不成为进程里未处理的错误；之后用世界摆东西直接失败，带着原来的错误', async () => {
    // 前提：世界摆好了，连接能用
    expect((await world.freshDocument('team')).id).toMatch(/^[\da-f-]{36}$/)
    await database.drop()
    // 等连接收到断开（服务端先发 57P01、再关掉连接）。之后的调用不再把语句发给断开的连接：直接失败，原因（cause）是记下的那个错误。
    // 在它收到之前发出的一次照常由 pg 报错（不是这里的说明），重试到记下为止
    await vi.waitFor(async () => {
      const failure: unknown = await world.freshDocument('team').then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe(SEEDING_CONNECTION_BROKEN)
      expect((failure as Error).cause).toBeInstanceOf(Error)
    }, { timeout: 5_000, interval: 50 })
  })
})

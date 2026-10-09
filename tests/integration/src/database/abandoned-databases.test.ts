// 中断的测试运行留下的库与角色的清理只认本主机建的（M4-P1 S7 的事故之后，tests/shared/test-databases.ts）：建测试库时，本主机上进程已经不在的
// 删掉；别的主机（Docker 容器、别的机器）建的不动——它们的进程号在本主机上看不到，原来只按进程号判断时会删掉别人正在用的库。
// 在真实的 PostgreSQL 上造两份"遗留"：本主机上不存在的进程建的、别的主机标识的，各有一个库与一个角色；改名之前的旧写法由单元测试覆盖
// （正在跑旧代码的别的 worktree 会删它，这里断言不稳）
import { randomBytes } from 'node:crypto'
import process from 'node:process'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { hostScopedName, hostTag } from '../../../shared/test-databases.ts'
import { createTestDatabase, testDatabaseName, withClient } from '../support/database.ts'

/** 本主机上一定不存在的进程号（Linux 的上限是 4194304，macOS 是 99999） */
const GONE_PID = 99_999_999
/** 与本主机不同的标识：本主机标识的第一个字符换一个 */
const OTHER_TAG = `${hostTag().startsWith('0') ? '1' : '0'}${hostTag().slice(1)}`
const suffix = randomBytes(4).toString('hex')
const ownGone = `${hostScopedName('nerve_it_', GONE_PID)}_${suffix}`
const otherHost = `${hostScopedName('nerve_it_', GONE_PID, OTHER_TAG)}_${suffix}`
const databases = [ownGone, otherHost]
const roles = [`${ownGone}_owner`, `${otherHost}_app`]

async function existing(): Promise<{ databases: string[], roles: string[] }> {
  return withClient(async (client) => {
    const foundDatabases = await client.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1) ORDER BY datname', [databases])
    const foundRoles = await client.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname', [roles])
    return { databases: foundDatabases.rows.map(row => row.datname), roles: foundRoles.rows.map(row => row.rolname) }
  })
}

afterAll(async () => {
  await withClient(async (client) => {
    for (const name of databases)
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`)
    for (const name of roles)
      await client.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(name)}`)
  })
})

describe('清理中断的测试运行留下的库与角色', () => {
  it('测试库的名字带本主机的标识与进程号：中断之后，本主机下一次运行认得出、清理得掉', () => {
    expect(testDatabaseName()).toMatch(new RegExp(`^nerve_it_${hostTag()}_${process.pid}_[0-9a-f]{8}$`))
  })

  it('本主机上进程已经不在的删掉；别的主机标识的不动', async () => {
    await withClient(async (client) => {
      for (const name of databases)
        await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`)
      for (const name of roles)
        await client.query(`CREATE ROLE ${pg.escapeIdentifier(name)}`)
    })
    expect(await existing()).toEqual({ databases: [ownGone, otherHost].sort(), roles: [...roles].sort() })

    const database = await createTestDatabase({ migrated: false })
    await database.drop()
    expect(await existing()).toEqual({ databases: [otherHost], roles: [`${otherHost}_app`] })
  })
})

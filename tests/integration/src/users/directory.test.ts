// 同事目录（M2-P1 设计 §3.6）：登录的成员按名字搜索有效账户；停用的不出现；关键词按字面匹配；最多 20 条。
// 空白的种类与个数不算区别（M2-P6 复验 G1）：名字保留单个的全角空格与不换行空格，用半角空格也搜得到。
// 看不见的字符一律写成 \u 转义：源码里直接出现它们，审阅时看不出来。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { errorResponseSchema, USER_SEARCH_QUERY_MAX_LENGTH, userDirectoryResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { parseExact } from '../support/contracts.ts'
import { createTestDatabase } from '../support/database.ts'
import { asUser, login } from '../support/session-client.ts'

let database: TestDatabase
let app: TestApp
let viewer: LoggedIn

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  const me = await createAccount(database, { username: 'myself', displayName: '我自己' })
  await createAccount(database, { username: 'zhang.san', displayName: '张三' })
  await createAccount(database, { username: 'li.si', displayName: '李四' })
  await createAccount(database, { username: 'percent', displayName: '满分 100%' })
  await createAccount(database, { username: 'yamada', displayName: '山田\u3000太郎' })
  await createAccount(database, { username: 'jean', displayName: 'Jean\u00A0Dupont' })
  await createAccount(database, { username: 'ana', displayName: 'Ana Silva' })
  const gone = await createAccount(database, { username: 'zhang.gone', displayName: '张离职' })
  await database.query(async client => client.query('UPDATE users SET status = \'disabled\' WHERE id = $1', [gone.id]))
  viewer = await login(app.baseUrl, 'myself', me.password)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

async function search(query?: string) {
  const path = query === undefined ? '/api/users' : `/api/users?query=${encodeURIComponent(query)}`
  const response = await asUser(app.baseUrl, viewer, path)
  expect(response.status).toBe(200)
  return parseExact(userDirectoryResponseSchema, await response.json()).items
}

describe('同事目录', () => {
  it('显示名或登录名包含关键词，不区分大小写；只返回 id、登录名与显示名', async () => {
    const found = await search('张')
    expect(found.map(user => [user.username, user.displayName])).toEqual([['zhang.san', '张三']])
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(['displayName', 'id', 'username'])
    expect((await search('ZHANG')).map(user => user.username)).toEqual(['zhang.san'])
    expect((await search('li.')).map(user => user.username)).toEqual(['li.si'])
  })

  it('停用的账户不出现', async () => {
    expect((await search('zhang')).map(user => user.username)).not.toContain('zhang.gone')
  })

  it('关键词按字面匹配：% 与 _ 不是通配符', async () => {
    expect((await search('%')).map(user => user.username)).toEqual(['percent'])
    expect(await search('_')).toEqual([])
  })

  it('空白的种类与个数不算区别：半角空格搜得到全角空格与不换行空格，全角空格搜得到半角空格；有没有空白仍然算区别（M2-P6 复验 G1）', async () => {
    expect((await search('山田 太郎')).map(user => user.username)).toEqual(['yamada'])
    expect((await search('Jean Dupont')).map(user => user.username)).toEqual(['jean'])
    expect((await search('Ana\u3000Silva')).map(user => user.username)).toEqual(['ana'])
    expect((await search('ana \u00A0\u2009SILVA')).map(user => user.username)).toEqual(['ana'])
    expect(await search('山田太郎')).toEqual([])
  })

  it('空白归一之后 % 与 _ 仍然按字面匹配', async () => {
    expect((await search('满分\u3000100%')).map(user => user.username)).toEqual(['percent'])
    expect(await search('满分 100_')).toEqual([])
    expect(await search('_ 1')).toEqual([])
  })

  it('不带关键词时按显示名给出前 20 条；多于 20 个有效账户时只给 20 条', async () => {
    for (let index = 0; index < 20; index += 1)
      await createAccount(database, { username: `bulk-${String(index).padStart(2, '0')}` })
    expect(await search()).toHaveLength(20)
  })

  it('关键词超长、多余的参数：400 REQUEST_INVALID', async () => {
    for (const path of [`/api/users?query=${'张'.repeat(USER_SEARCH_QUERY_MAX_LENGTH + 1)}`, '/api/users?query=a&limit=100']) {
      const response = await asUser(app.baseUrl, viewer, encodeURI(path))
      expect(response.status, path).toBe(400)
      expect(parseExact(errorResponseSchema, await response.json()).error.code).toBe('REQUEST_INVALID')
    }
  })

  it('没有登录：401', async () => {
    expect((await fetch(`${app.baseUrl}/api/users?query=a`)).status).toBe(401)
  })
})

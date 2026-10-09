// 集成测试的数据库辅助（database.ts）里不碰数据库的判断：建模板时哪些是别的迁移（别的检出、别的分支）的模板，删不掉时是不是因为有人在用，
// 删别的迁移的模板时发出哪些语句（假的连接）。别的迁移的模板只删没人在用的、不用 FORCE（有连接在用、正以它为模板复制的跳过，留给下一次）：
// 两个迁移不同的检出同时跑集成测试时各用各的模板
import type { Queryable } from './database.ts'
import { describe, expect, it } from 'vitest'
import { dropUnusedTemplate, isInUse, otherTemplates } from './database.ts'

describe('别的迁移的模板（otherTemplates）', () => {
  it('当前的模板与它没建完的半成品除外；别的哈希的模板与它们的半成品都算', () => {
    const current = 'nerve_it_tpl_0123456789ab'
    expect(otherTemplates([current, `${current}_building`, 'nerve_it_tpl_ba9876543210', 'nerve_it_tpl_ba9876543210_building'], current)).toEqual(['nerve_it_tpl_ba9876543210', 'nerve_it_tpl_ba9876543210_building'])
    expect(otherTemplates([current], current)).toEqual([])
  })
})

describe('删不掉是不是因为有人在用（isInUse）', () => {
  it('库正被别的连接使用（55006）、等锁超时（55P03，正以它为模板复制）算；别的错误不算，照常抛出', () => {
    expect(isInUse(Object.assign(new Error('database is being accessed by other users'), { code: '55006' }))).toBe(true)
    expect(isInUse(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }))).toBe(true)
    expect(isInUse(Object.assign(new Error('permission denied'), { code: '42501' }))).toBe(false)
    expect(isInUse(new Error('没有错误码'))).toBe(false)
    expect(isInUse(undefined)).toBe(false)
  })
})

/** 假的连接：记下发出的语句；pg_stat_activity 的查询按 connected 交回行数，DROP 按 dropError 失败 */
function fakeClient(options: { readonly connected: boolean, readonly dropError?: unknown }): Queryable & { readonly statements: string[] } {
  const statements: string[] = []
  return {
    statements,
    query: async (text: string) => {
      statements.push(text)
      if (text.startsWith('DROP') && options.dropError !== undefined)
        throw options.dropError
      return { rowCount: text.includes('pg_stat_activity') && options.connected ? 1 : 0 }
    },
  }
}

describe('删别的迁移的模板（dropUnusedTemplate）', () => {
  it('有连到它的会话就跳过：不发 DROP（不用 FORCE 的 DROP 遇到连接时要在 advisory lock 下等 5 秒才报错）', async () => {
    const client = fakeClient({ connected: true })
    await dropUnusedTemplate(client, 'nerve_it_tpl_ba9876543210')
    expect(client.statements).toEqual(['SELECT 1 FROM pg_stat_activity WHERE datname = $1 LIMIT 1'])
  })

  it('没有连接时不用 FORCE 地删，等锁有时限，删完恢复时限', async () => {
    const client = fakeClient({ connected: false })
    await dropUnusedTemplate(client, 'nerve_it_tpl_ba9876543210')
    expect(client.statements).toEqual([
      'SELECT 1 FROM pg_stat_activity WHERE datname = $1 LIMIT 1',
      'SET lock_timeout = \'1s\'',
      'DROP DATABASE IF EXISTS "nerve_it_tpl_ba9876543210"',
      'RESET lock_timeout',
    ])
  })

  it('删的那一刻有人在用（55006、55P03）就跳过；别的错误照常抛出；时限都恢复', async () => {
    const inUse = fakeClient({ connected: false, dropError: Object.assign(new Error('in use'), { code: '55006' }) })
    await dropUnusedTemplate(inUse, 'nerve_it_tpl_ba9876543210')
    expect(inUse.statements.at(-1)).toBe('RESET lock_timeout')
    const denied = fakeClient({ connected: false, dropError: Object.assign(new Error('permission denied'), { code: '42501' }) })
    await expect(dropUnusedTemplate(denied, 'nerve_it_tpl_ba9876543210')).rejects.toThrow('permission denied')
    expect(denied.statements.at(-1)).toBe('RESET lock_timeout')
  })
})

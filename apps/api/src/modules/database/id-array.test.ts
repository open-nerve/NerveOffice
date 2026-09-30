// 一串 id 作为一个数组参数（M2-P6 复核 A 的 S-2、B 的 G1）：不论多少个 id，语句里只有一个参数，语句的文本也不变。
// 仓储里每一处按一串 id 读写的语句都经它，那一层的核对见 documents/id-array-statements.test.ts。
import { sql } from 'drizzle-orm'
import { PgDialect, pgTable, uuid } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { inIdArray } from './id-array.ts'

const table = pgTable('things', { id: uuid('id').primaryKey() })
const dialect = new PgDialect()

/** PostgreSQL 一条语句最多 65535 个参数：比它多，逐个传参的写法就会失败 */
const BEYOND_PARAMETER_LIMIT = 70_000

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `0199a2c4-0000-7000-8000-${String(index).padStart(12, '0')}`)
}

describe('inIdArray', () => {
  it(`${BEYOND_PARAMETER_LIMIT} 个 id：语句里只有一个参数，就是整个数组`, () => {
    const many = ids(BEYOND_PARAMETER_LIMIT)
    const query = dialect.sqlToQuery(inIdArray(table.id, many))
    expect(query.sql).toBe('"things"."id" = ANY($1::uuid[])')
    expect(query.params).toEqual([many])
  })

  it('语句的文本与 id 的个数无关：一个与很多个一样', () => {
    expect(dialect.sqlToQuery(inIdArray(table.id, ids(1))).sql).toBe(dialect.sqlToQuery(inIdArray(table.id, ids(500))).sql)
  })

  it('空的一串：照样是一个参数（空数组，条件恒为假）', () => {
    expect(dialect.sqlToQuery(inIdArray(table.id, []))).toMatchObject({ sql: '"things"."id" = ANY($1::uuid[])', params: [[]] })
  })

  it('写好的 SQL 也行（给别名过的表写条件）；前后的参数照常编号', () => {
    const query = dialect.sqlToQuery(sql`${'first'} AND ${inIdArray(sql`parent.space_id`, ids(3))} AND ${'last'}`)
    expect(query.sql).toBe('$1 AND parent.space_id = ANY($2::uuid[]) AND $3')
    expect(query.params).toEqual(['first', ids(3), 'last'])
  })

  it('不共用调用方的数组：之后改动那个数组不影响已经生成的语句', () => {
    const source = ids(2)
    const condition = inIdArray(table.id, source)
    source.push(ids(3)[2] ?? '')
    expect(dialect.sqlToQuery(condition).params).toEqual([ids(2)])
  })
})

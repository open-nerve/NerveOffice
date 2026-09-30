// 表定义共用的写法：名称判重键的表达式（M2-P6 复核 B 的 M-1）。表达式在数据库里的效果由集成测试对着真实数据库核对
// （tests/integration 的 spaces/space-names.test.ts 与迁移的用例），这里核对拼出来的 SQL；空白的清单由 contracts 的单元测试核对。
import { NAME_BLANK_CHARACTERS, NAME_KEY_IGNORED_CHARACTERS } from '@nerve-office/contracts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { spaceNameForSearch, spaces } from '../spaces/index.ts'
import { displayNameForSearch } from '../users/index.ts'
import { bracketExpressionOf, nameKeyOf } from './index.ts'

const dialect = new PgDialect()

describe('名称的判重键', () => {
  it('方括号表达式：码点写成 \\u 与 \\U 转义，看不见的字符不直接出现在 SQL 里', () => {
    expect(bracketExpressionOf([[0x0009, 0x000D], [0x0020, 0x0020], [0x200C, 0x200D], [0xE0020, 0xE007F]]))
      .toBe('[\\u0009-\\u000D\\u0020\\u200C-\\u200D\\U000E0020-\\U000E007F]')
    expect(/^[\x20-\x7E]*$/.test(bracketExpressionOf(NAME_KEY_IGNORED_CHARACTERS))).toBe(true)
  })

  it('表达式：NFKC → 去掉放行的格式字符 → 空白与显示成空白的字符合成一个空格并去掉首尾 → lower 与 casefold → 再 NFKC；没有绑定参数（生成列里只能是常量）', () => {
    const query = dialect.sqlToQuery(nameKeyOf(spaces.name, { ignored: NAME_KEY_IGNORED_CHARACTERS, blanks: NAME_BLANK_CHARACTERS }))
    expect(query.params).toEqual([])
    expect(query.sql).toBe(
      'normalize(casefold(lower(btrim(regexp_replace(regexp_replace(normalize("spaces"."name", NFKC), '
      + `'${bracketExpressionOf(NAME_KEY_IGNORED_CHARACTERS)}', '', 'g'), '${bracketExpressionOf(NAME_BLANK_CHARACTERS)}+', ' ', 'g'), ' '))), NFKC)`,
    )
  })

  it('显示成空白的非格式字符并进空白的方括号（M2-P6 复验 R-M1）：盲文空白、契丹小字填充符、乐谱的空符头，写成转义；它们不在去掉的那一组里', () => {
    const query = dialect.sqlToQuery(nameKeyOf(spaces.name, { ignored: NAME_KEY_IGNORED_CHARACTERS, blanks: NAME_BLANK_CHARACTERS }))
    expect(query.sql).toContain('\\u205F\\u3000\\u2800\\U00016FE4\\U0001D159]+')
    // 去掉的只有放行的格式字符：显示成空白的字符要变成空格，两边的字才不会连在一起
    for (const hex of ['2800', '16FE4', '1D159'])
      expect(bracketExpressionOf(NAME_KEY_IGNORED_CHARACTERS)).not.toContain(hex)
  })

  it('按名称搜索时比较的名称（团队空间名称、显示名）：每一段空白合成一个普通空格，空白的方括号与判重键逐字相同；没有绑定参数（M2-P6 复验 G1）', () => {
    const blanks = `'${bracketExpressionOf(NAME_BLANK_CHARACTERS)}+'`
    expect(dialect.sqlToQuery(nameKeyOf(spaces.name, { ignored: NAME_KEY_IGNORED_CHARACTERS, blanks: NAME_BLANK_CHARACTERS })).sql).toContain(blanks)
    expect(dialect.sqlToQuery(spaceNameForSearch)).toEqual({ sql: `regexp_replace("spaces"."name", ${blanks}, ' ', 'g')`, params: [] })
    expect(dialect.sqlToQuery(displayNameForSearch)).toEqual({ sql: `regexp_replace("users"."display_name", ${blanks}, ' ', 'g')`, params: [] })
  })
})

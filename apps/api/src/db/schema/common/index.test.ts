// 表定义共用的写法：名称判重键的表达式（M2-P6 复核 B 的 M-1）。表达式在数据库里的效果由集成测试对着真实数据库核对
// （tests/integration 的 spaces/space-names.test.ts 与迁移的用例），这里核对拼出来的 SQL 与空白的清单。
import { NAME_KEY_IGNORED_CHARACTERS } from '@nerve-office/contracts'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { spaces } from '../spaces/index.ts'
import { bracketExpressionOf, nameKeyOf, WHITE_SPACE } from './index.ts'

function within(ranges: readonly (readonly [number, number])[], codePoint: number): boolean {
  return ranges.some(([first, last]) => codePoint >= first && codePoint <= last)
}

describe('名称的判重键', () => {
  it('WHITE_SPACE 恰好是 Unicode 的 White_Space（与 JavaScript 的 \\p{White_Space} 逐个码点一致）', () => {
    const mismatches: string[] = []
    for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint += 1) {
      if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
        continue
      if (/^\p{White_Space}$/u.test(String.fromCodePoint(codePoint)) !== within(WHITE_SPACE, codePoint))
        mismatches.push(codePoint.toString(16))
    }
    expect(mismatches).toEqual([])
  })

  it('方括号表达式：码点写成 \\u 与 \\U 转义，看不见的字符不直接出现在 SQL 里', () => {
    expect(bracketExpressionOf([[0x0009, 0x000D], [0x0020, 0x0020], [0x200C, 0x200D], [0xE0020, 0xE007F]]))
      .toBe('[\\u0009-\\u000D\\u0020\\u200C-\\u200D\\U000E0020-\\U000E007F]')
    expect(/^[\x20-\x7E]*$/.test(bracketExpressionOf(NAME_KEY_IGNORED_CHARACTERS))).toBe(true)
  })

  it('表达式：NFKC → 去掉放行的格式字符 → 空白合成一个空格并去掉首尾 → lower 与 casefold → 再 NFKC；没有绑定参数（生成列里只能是常量）', () => {
    const query = new PgDialect().sqlToQuery(nameKeyOf(spaces.name, NAME_KEY_IGNORED_CHARACTERS))
    expect(query.params).toEqual([])
    expect(query.sql).toBe(
      'normalize(casefold(lower(btrim(regexp_replace(regexp_replace(normalize("spaces"."name", NFKC), '
      + `'${bracketExpressionOf(NAME_KEY_IGNORED_CHARACTERS)}', '', 'g'), '${bracketExpressionOf(WHITE_SPACE)}+', ' ', 'g'), ' '))), NFKC)`,
    )
  })
})

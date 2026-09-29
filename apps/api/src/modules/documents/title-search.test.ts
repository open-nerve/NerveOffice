import { describe, expect, it } from 'vitest'
import { TITLE_SEARCH_ESCAPE, titleSearchPattern } from './title-search.ts'

describe('搜索关键词的转义', () => {
  it('普通的关键词：前后各加一个通配符，中间原样', () => {
    expect(titleSearchPattern('预算')).toBe('%预算%')
    expect(titleSearchPattern('Q3 Budget')).toBe('%Q3 Budget%')
  })

  it('通配符当字面量：% 与 _ 都加上转义符', () => {
    expect(titleSearchPattern('100%')).toBe('%100\\%%')
    expect(titleSearchPattern('a_b')).toBe('%a\\_b%')
    expect(titleSearchPattern('%_')).toBe('%\\%\\_%')
  })

  it('转义符自己也要转义，而且不会被再转义一次', () => {
    expect(titleSearchPattern('C:\\临时')).toBe('%C:\\\\临时%')
    // 关键词里的 `\%` 是两个字面量字符，转义之后是 `\\` 加 `\%`，不是「转义符 + 通配符」
    expect(titleSearchPattern('\\%')).toBe('%\\\\\\%%')
  })

  it('转义符是反斜杠：语句里的 ESCAPE 子句与这里用的是同一个', () => {
    expect(TITLE_SEARCH_ESCAPE).toBe('\\')
    expect(TITLE_SEARCH_ESCAPE).toHaveLength(1)
  })
})

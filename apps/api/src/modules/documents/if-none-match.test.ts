// 读取内容的条件请求（M3-P2 设计 §3.2，DEF-017）：If-None-Match 的解析与比较。经真实的 HTTP 管线的 304 见集成测试（documents/content.test.ts）。
import type { Request } from 'express'
import { revisionEtag } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { matchesNoneMatch, noneMatchOf } from './if-none-match.ts'

/** 只带这些请求头的请求（Node 收到的请求头名都是小写；同名的几个已经由 Node 用逗号合成一串） */
function request(headers: Record<string, string>): Request {
  return { headers } as unknown as Request
}

describe('noneMatchOf', () => {
  it('没带：undefined（不是条件请求）', () => {
    expect(noneMatchOf(request({}))).toBeUndefined()
    expect(noneMatchOf(request({ etag: '"3"' }))).toBeUndefined()
  })

  it('一个强校验器：读取内容时给出的 ETag 原样带回来，得到它的修订号', () => {
    expect(noneMatchOf(request({ 'if-none-match': revisionEtag(3) }))).toEqual([3])
  })

  it('弱校验器 W/"n" 同样认（反向代理改了编码会标成弱的，修订号不变）', () => {
    expect(noneMatchOf(request({ 'if-none-match': 'W/"12"' }))).toEqual([12])
  })

  it('列表：逗号与空白分隔，各自认；同名的几个请求头合成的一串也一样', () => {
    expect(noneMatchOf(request({ 'if-none-match': '"1", W/"2" ,"3"' }))).toEqual([1, 2, 3])
  })

  it('*：任何现有的版本都算匹配（前后的空白不算）', () => {
    expect(noneMatchOf(request({ 'if-none-match': '*' }))).toBe('*')
    expect(noneMatchOf(request({ 'if-none-match': ' * ' }))).toBe('*')
  })

  it.each([
    ['空值', ''],
    ['不带引号', '3'],
    ['不是修订号', '"abc"'],
    ['前导零', '"03"'],
    ['零与负数', '"0", "-1"'],
    ['超过修订号的上限', '"2147483648"'],
    ['只有前半个引号', '"3'],
  ])('认不出的标签（%s）不算匹配，也不是错误：照常给内容', (_case, value) => {
    expect(noneMatchOf(request({ 'if-none-match': value }))).toEqual([])
  })

  it('认不出的与认得出的混在一起：认得出的照样算；引号里的逗号不拆开（"1,2" 是一个标签，认不出）', () => {
    expect(noneMatchOf(request({ 'if-none-match': '"abc", "7"' }))).toEqual([7])
    expect(noneMatchOf(request({ 'if-none-match': '"1,2"' }))).toEqual([])
  })
})

describe('matchesNoneMatch', () => {
  it('当前修订在列表里才算；* 总算；空的列表总不算', () => {
    expect(matchesNoneMatch([3], 3)).toBe(true)
    expect(matchesNoneMatch([2, 3], 3)).toBe(true)
    expect(matchesNoneMatch([2], 3)).toBe(false)
    expect(matchesNoneMatch([4], 3)).toBe(false)
    expect(matchesNoneMatch([], 3)).toBe(false)
    expect(matchesNoneMatch('*', 3)).toBe(true)
  })
})

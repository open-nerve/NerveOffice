import { DOCUMENT_TYPES, UNKNOWN_DOCUMENT_TYPE } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { messages } from './messages.ts'

describe('文档类型的名称（列表、管理端的转移页）', () => {
  it('表格与文字文档各有名称；响应里没见过的类型显示“未知类型”（M6 总设计 §2.2 第 5 条）', () => {
    expect(messages.documents.typeName('sheet')).toBe('表格')
    expect(messages.documents.typeName('doc')).toBe('文字文档')
    expect(messages.documents.typeName(UNKNOWN_DOCUMENT_TYPE)).toBe('未知类型')
    const names = DOCUMENT_TYPES.map(type => messages.documents.typeName(type))
    expect(new Set([...names, messages.documents.typeName(UNKNOWN_DOCUMENT_TYPE)]).size).toBe(DOCUMENT_TYPES.length + 1)
  })
})

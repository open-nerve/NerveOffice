import { Buffer } from 'node:buffer'
import { SHEET_TEMPLATE, sheetSnapshotFor, SNAPSHOT_MAX_DEPTH } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { validateSnapshot } from './snapshot-validation.ts'

const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'

function rejection(raw: Buffer): AppError {
  try {
    validateSnapshot(raw)
  }
  catch (error) {
    if (error instanceof AppError)
      return error
    throw error
  }
  throw new Error('期望校验失败')
}

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

/** 最深处的对象在第 depth 层：顶层算第 1 层，sheets 第 2 层 */
function nested(depth: number): Buffer {
  let inner: unknown = {}
  for (let level = 2; level < depth; level += 1)
    inner = { x: inner }
  return json({ id: UNIT_ID, sheetOrder: [], sheets: inner })
}

describe('快照的基本校验', () => {
  it('模板实例化的快照通过，取出 unitId', () => {
    expect(validateSnapshot(Buffer.from(sheetSnapshotFor(UNIT_ID), 'utf8'))).toEqual({ unitId: UNIT_ID })
  })

  it.each([
    ['不是 UTF-8', Buffer.from([0x7B, 0xC3, 0x28, 0x7D]), '表格内容不是 UTF-8 编码的文本'],
    ['带 BOM', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), json(SHEET_TEMPLATE)]), '表格内容不是合法的 JSON'],
    ['不是 JSON', Buffer.from('{"id":', 'utf8'), '表格内容不是合法的 JSON'],
    ['空内容', Buffer.alloc(0), '表格内容不是合法的 JSON'],
    ['顶层是数组', json([SHEET_TEMPLATE]), '表格内容的顶层必须是对象'],
    ['顶层是 null', json(null), '表格内容的顶层必须是对象'],
    ['顶层是字符串', json('x'), '表格内容的顶层必须是对象'],
    ['没有 id', json({ sheetOrder: [], sheets: {} }), '表格内容缺少工作簿的 id'],
    ['id 不是字符串', json({ id: 1, sheetOrder: [], sheets: {} }), '表格内容缺少工作簿的 id'],
    ['id 为空', json({ id: '', sheetOrder: [], sheets: {} }), '表格内容缺少工作簿的 id'],
    ['sheetOrder 不是数组', json({ id: UNIT_ID, sheetOrder: {}, sheets: {} }), '表格内容的 sheetOrder 必须是数组'],
    ['sheets 不是对象', json({ id: UNIT_ID, sheetOrder: [], sheets: [] }), '表格内容的 sheets 必须是对象'],
    ['没有 sheets', json({ id: UNIT_ID, sheetOrder: [] }), '表格内容的 sheets 必须是对象'],
  ])('%s：SNAPSHOT_INVALID', (_case, raw, message) => {
    const error = rejection(raw)
    expect(error.code).toBe('SNAPSHOT_INVALID')
    expect(error.status).toBe(422)
    expect(error.message).toBe(message)
  })

  it(`嵌套最多 ${SNAPSHOT_MAX_DEPTH} 层`, () => {
    expect(validateSnapshot(nested(SNAPSHOT_MAX_DEPTH))).toEqual({ unitId: UNIT_ID })
    expect(rejection(nested(SNAPSHOT_MAX_DEPTH + 1)).message).toBe(`表格内容的嵌套超过 ${SNAPSHOT_MAX_DEPTH} 层`)
  })

  it('嵌套极深（几十万层）也不会爆栈', () => {
    const depth = 300_000
    const raw = Buffer.from(`{"id":"${UNIT_ID}","sheetOrder":[],"sheets":{"a":${'['.repeat(depth)}${']'.repeat(depth)}}}`, 'utf8')
    expect(rejection(raw).message).toBe(`表格内容的嵌套超过 ${SNAPSHOT_MAX_DEPTH} 层`)
  })

  it('说明不回显快照的内容', () => {
    const error = rejection(json({ id: UNIT_ID, sheetOrder: 'secret-value', sheets: {} }))
    expect(error.message).not.toContain('secret-value')
  })
})

import type { Buffer } from 'node:buffer'
import { SNAPSHOT_MAX_DEPTH } from '@nerve-office/contracts'
import { AppError } from '../../shared/errors/app-error.ts'
import { checkJsonLimits } from '../security/index.ts'

/** 基本校验通过的快照：顶层的 id（Univer 的 unitId），由调用方与文档的 unit_id 核对。 */
export interface ValidSnapshot {
  readonly unitId: string
}

function invalid(message: string): AppError {
  return new AppError('SNAPSHOT_INVALID', message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 不自动去掉 BOM：JSON 不允许它，客户端的 JSON.stringify 与 TextEncoder 也不会写出它
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * 快照的基本校验（M1 总设计 §6.5，P4 设计 §3.5.1）：UTF-8 的 JSON；顶层是对象，sheetOrder 是数组、sheets 是对象；
 * 顶层 id 是字符串；嵌套不超过 SNAPSHOT_MAX_DEPTH 层。说明不回显快照的内容。
 * 与文档无关，在判断权限之前做：别人的与不存在的文档得到相同的结果。完整的快照校验（资源白名单等）在 M3。
 */
export function validateSnapshot(raw: Buffer): ValidSnapshot {
  let text: string
  try {
    text = UTF8.decode(raw)
  }
  catch {
    throw invalid('表格内容不是 UTF-8 编码的文本')
  }
  let snapshot: unknown
  try {
    snapshot = JSON.parse(text)
  }
  catch {
    throw invalid('表格内容不是合法的 JSON')
  }
  if (!isPlainObject(snapshot))
    throw invalid('表格内容的顶层必须是对象')
  if (typeof snapshot.id !== 'string' || snapshot.id === '')
    throw invalid('表格内容缺少工作簿的 id')
  if (!Array.isArray(snapshot.sheetOrder))
    throw invalid('表格内容的 sheetOrder 必须是数组')
  if (!isPlainObject(snapshot.sheets))
    throw invalid('表格内容的 sheets 必须是对象')
  if (checkJsonLimits(snapshot, { maxDepth: SNAPSHOT_MAX_DEPTH, maxEntries: Number.POSITIVE_INFINITY }) !== undefined)
    throw invalid(`表格内容的嵌套超过 ${SNAPSHOT_MAX_DEPTH} 层`)
  return { unitId: snapshot.id }
}

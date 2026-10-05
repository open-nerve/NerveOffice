// 存量内容的非空资源名（M3-P3 设计 §3.3 的"不缩水"）：P3 起每次写入都把这一版非空的资源名存进 document_contents.resource_names，
// 下一次保存按它核对；P3 之前写的内容这一列为空，这里解析上一版得到。
// 在主线程、文档行的锁下解析，不经快照检查的工作线程（SnapshotInspector），理由：
// - 检查器只在全部规则都通过时才给出资源名，而存量内容恰恰可能过不了今天的规则（例如 E2E 只读样本里的 data: 图片、P3 之前存下的
//   不规范的链接），这里要的只是"上一版有哪些非空的资源"，与它合不合今天的规则无关；
// - 只有 P3 之前写的内容走这里，每份文档至多一次（这一次保存就写上了资源名）。v0.1 上线之前没有真实数据（M3-P3 设计 §3.6），
//   存量只在开发库与测试的样本里；内容的大小有数据库的约束兜着（解压后不超过 5 MiB），也都经过了当时的基本校验（JSON、嵌套不超过 64 层）。
// 不规范的存量（解压或解析失败、资源不是 { name, data }）按"没有可核对的上一版"处理，返回 undefined，由调用方记一条警告：
// 那样的内容本来就打不开，这一次保存正好换上合格的内容
import type { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { isDeepEmpty, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 资源的 data 是不是深层为空：空串是空；解析不了的按非空算（存量里有它，就当它有内容，宁可多核对一项） */
function isEmptyData(data: string): boolean {
  if (data === '')
    return true
  try {
    return isDeepEmpty(JSON.parse(data) as unknown)
  }
  catch {
    return false
  }
}

/**
 * gzip 压缩的存量快照里非空的资源名（去重，按名称排序的结果由调用方的 shrunkResources 处理）；解压、解析不了，或者 resources 不是数组时为 undefined
 */
export function legacyNonEmptyResources(stored: Buffer): string[] | undefined {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(zlib.gunzipSync(stored, { maxOutputLength: SNAPSHOT_MAX_RAW_BYTES }).toString('utf8')) as unknown
  }
  catch {
    return undefined
  }
  if (!isRecord(snapshot))
    return undefined
  const resources = snapshot.resources ?? []
  if (!Array.isArray(resources))
    return undefined
  const names = new Set<string>()
  for (const entry of resources as readonly unknown[]) {
    if (isRecord(entry) && typeof entry.name === 'string' && typeof entry.data === 'string' && !isEmptyData(entry.data))
      names.add(entry.name)
  }
  return [...names]
}

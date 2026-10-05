// 快照的检查（M3-P3 设计 §3.3，00 号计划书 §11.2）：解压之后的字节 → 解码、按文字数嵌套与元素、解析、与文档无关的规则、
// 规范化的内容哈希。纯函数、同步、不抛出；在子进程里执行（snapshot-inspection.child.ts，主进程经 SnapshotInspector 交来），
// 结果很小，经 IPC 回给主进程。
// 规则按 contracts 的 SNAPSHOT_RULES 的先后检查，第一条不满足的就是结果：encoding → depth、entries（外层的文字）→ json →
// depth、entries（资源 data 的文字，与外层累加）→ structure → 资源（resources、resource-duplicate、resource-unknown、resource-data、
// resource-not-empty）→ image-source → 链接（link-structure、link-address、link-range-id）。
// 嵌套与数量在每次解析之前按文字数，没超出才交给 JSON.parse；全部通过之后才规范化（规范化与资源的规则会再解析资源的 data，
// 那时已经数过）。与文档有关的两条（unit-id、resource-missing）在保存的事务里；too-complex（子进程的堆超过上限）由 SnapshotInspector 给出
import type { DocumentProfile, SnapshotRule } from '@nerve-office/contracts'
import type { EntryCount } from './snapshot-checks.ts'
import { createHash } from 'node:crypto'
import { canonicalContentTextOf, checkResources, contentHashInput } from '@nerve-office/contracts'
import { embeddedJson, hasForeignImage, measureJsonText, PROFILE_SNAPSHOT_RULES } from './snapshot-checks.ts'

/** 只看快照本身就能判断的规则：不含要读文档的 unit-id、resource-missing，与子进程池给出的 too-complex */
export type SnapshotContentRule = Exclude<SnapshotRule, 'unit-id' | 'resource-missing' | 'too-complex'>

/** 检查通过的快照 */
export interface PassedSnapshot {
  readonly ok: true
  /** 快照顶层的 id（Univer 的 unitId），事务里与文档的 unit_id 核对 */
  readonly unitId: string
  /** 规范化内容的 SHA-256（contracts 的 contentHashInput，32 字节），"内容相同不递增"按它比较 */
  readonly contentHash: Uint8Array
  /** 这一版里在的资源名，按名称排序：不缩水按它核对上一版的非空资源 */
  readonly presentResources: readonly string[]
  /** 其中非空的资源名，按名称排序：随内容存下，下一次保存的不缩水按它核对 */
  readonly nonEmptyResources: readonly string[]
  /** 原文（解压之后）的字节数 */
  readonly rawBytes: number
}

/** 检查的结果：通过，或者违反的规则 */
export type SnapshotInspection = PassedSnapshot | { readonly ok: false, readonly rule: SnapshotContentRule }

/** 交给子进程的任务：解压之后的字节与文档的档案 */
export interface InspectionTask {
  readonly bytes: Uint8Array
  readonly profile: DocumentProfile
}

// 不自动去掉 BOM：JSON 不允许它，客户端的 JSON.stringify 与 TextEncoder 也不会写出它
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function violated(rule: SnapshotContentRule): SnapshotInspection {
  return { ok: false, rule }
}

/** 解码、按文字数外层的嵌套与元素、解析：不合格时给出规则。解码出的文字只活在这一步里 */
function parsed(raw: Uint8Array, count: EntryCount): { readonly value: unknown } | SnapshotContentRule {
  let text: string
  try {
    text = UTF8.decode(raw)
  }
  catch {
    return 'encoding'
  }
  const limit = measureJsonText(text, 1, count)
  if (limit !== undefined)
    return limit
  try {
    return { value: JSON.parse(text) as unknown }
  }
  catch {
    return 'json'
  }
}

/** 检查一份快照（见文件开头）。raw 是解压之后的字节；profile 决定结构、资源与链接的规则 */
export function inspectSnapshot(raw: Uint8Array, profile: DocumentProfile): SnapshotInspection {
  const count: EntryCount = { entries: 0 }
  const json = parsed(raw, count)
  if (typeof json === 'string')
    return violated(json)
  const snapshot = json.value
  const embedded = embeddedJson(snapshot, count)
  if (typeof embedded === 'string')
    return violated(embedded)
  const rules = PROFILE_SNAPSHOT_RULES[profile]
  const structure = rules.structure(snapshot)
  if (structure === undefined)
    return violated('structure')
  const resources = checkResources(structure.snapshot.resources, profile)
  if (!resources.ok)
    return violated(resources.rule)
  if (hasForeignImage([snapshot, ...embedded]))
    return violated('image-source')
  const links = rules.links(structure)
  if (!links.ok)
    return violated(links.rule)
  const digest = createHash('sha256').update(contentHashInput(canonicalContentTextOf(snapshot))).digest()
  return {
    ok: true,
    unitId: structure.unitId,
    // 复制成刚好 32 字节的 Uint8Array（结果的类型）：digest 是 Buffer，可能是共用的缓冲池里的一段
    contentHash: new Uint8Array(digest),
    presentResources: resources.present,
    nonEmptyResources: resources.nonEmpty,
    rawBytes: raw.byteLength,
  }
}

// 存量修订的图片标识（M5-P7 设计 §3.2，D-01 的比较基准）：P7 起每次写入都把这一版正文里存在、却没有登记关系的图片标识存进
// document_revisions.unlinked_asset_ids，之后的写入不升级它们；P7 之前写的修订这一列为空，这里解析当前正文得到全部标识，
// 由调用方减去当前已登记的关系（asset-reference-bases.ts）。
// 与 legacy-resources.ts 同样在主线程、文档行的锁下解析，不经快照检查的子进程，理由相同：
// - 检查器只在全部规则都通过时才给出结果，而存量内容可能过不了今天的规则；这里要的只是“上一版出现过哪些图片标识”；
// - 只有 P7 之前写的修订走这里，每份文档至多一次（这一次写入就补上了这一列）。v0.1 上线之前没有真实数据，
//   存量只在开发库与测试样本里；正文受数据库约束（解压后不超过 5 MiB），并经过当时的嵌套与数量检查。
// 解压、解析不了，或者超出今天的嵌套与数量上限，按“没有可核对的上一版”处理，返回 undefined，由调用方当作没有未登记的标识并记警告。
import type { EntryCount } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { measureJsonText, SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { snapshotAssetIds } from './snapshot-assets.ts'
import { embeddedJson } from './snapshot-checks.ts'

/** gzip 压缩的存量快照里出现过的全部平台图片标识（去重、按码元排序）；解压、解析不了或超出上限时为 undefined */
export function legacyAssetIds(stored: Buffer): readonly string[] | undefined {
  let text: string
  try {
    text = zlib.gunzipSync(stored, { maxOutputLength: SNAPSHOT_MAX_RAW_BYTES }).toString('utf8')
  }
  catch {
    return undefined
  }
  const count: EntryCount = { entries: 0 }
  if (measureJsonText(text, 1, count) !== undefined)
    return undefined
  let snapshot: unknown
  try {
    snapshot = JSON.parse(text) as unknown
  }
  catch {
    return undefined
  }
  const embedded = embeddedJson(snapshot, count)
  if (typeof embedded === 'string')
    return undefined
  return snapshotAssetIds(snapshot, embedded.map(entry => entry.value))
}

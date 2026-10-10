// 草稿的附加认证数据（AAD，M4-P1 设计 §3.3，00 号计划书 §7.6）：覆盖全部明文元数据，改动任何一项（基准修订号、在途的请求、
// 更新时间……）解密都失败——明文的元数据决定恢复怎么走，被改过就可能把冲突伪装成能直接恢复（M0 审查 G1）。
// 写法：UTF-8 的 JSON 数组，第一项是格式标识，之后按字段表的固定顺序排列 DraftMeta 的每一项；format 与 inFlight 各展开成
// 固定顺序的子数组（不在途时是 null）。用 JSON 而不用分隔符拼接：字段的边界不会因为取值里有分隔符而挪动（M0 审查 G1）。
// 写法与顺序一旦有库里的数据就不能改（单元测试的金标准钉住）；要改就换格式标识、加记录的格式版本。
// Worker 也引用这个文件：不引用 zod，不依赖 DOM
import type { ContentFormat, DraftMeta, InFlightSave } from './draft-record.ts'

/** AAD 的格式标识（第一项） */
export const DRAFT_AAD_FORMAT = 'nerve-office/outbox-draft/v1'

/** T 的键里字段表没有列出的 */
type Unlisted<T, Fields extends readonly unknown[]> = Exclude<keyof T, Fields[number]>

/**
 * 字段表的写法：固定顺序，类型上要求恰好列出 T 的全部键——T 加了字段而表里忘了，调用处的类型检查就过不了，报出少了哪个
 * （参数要多一个 unlistedFields，数组字面量没有它）；不是 T 的键同样过不了。重复由单元测试拦
 */
function fieldTable<T>() {
  return <const Fields extends readonly (keyof T)[]>(fields: Fields & ([Unlisted<T, Fields>] extends [never] ? unknown : { readonly unlistedFields: Unlisted<T, Fields> })): Fields => fields
}

/** 草稿元数据的字段表（AAD 里的顺序） */
export const DRAFT_AAD_FIELDS = fieldTable<DraftMeta>()([
  'userId',
  'documentId',
  'recordVersion',
  'draftSeq',
  'baseRevision',
  'writeEpoch',
  'writerId',
  'writtenBy',
  'format',
  'formulasPending',
  'keyVersion',
  'inFlight',
  'rawBytes',
  'updatedAt',
])

/** format 的子数组 */
export const CONTENT_FORMAT_AAD_FIELDS = fieldTable<ContentFormat>()(['clientBuild', 'univerVersion', 'profile', 'formatVersion'])

/** inFlight 的子数组 */
export const IN_FLIGHT_AAD_FIELDS = fieldTable<InFlightSave>()(['requestId', 'clientInstanceId', 'localSeq', 'sentAt'])

type AadValue = string | number | boolean | null | readonly AadValue[]

/** 一个字段在 AAD 里的值：format 与 inFlight 展开成固定顺序的子数组，其余原样 */
function aadValueOf(meta: DraftMeta, field: (typeof DRAFT_AAD_FIELDS)[number]): AadValue {
  if (field === 'format')
    return CONTENT_FORMAT_AAD_FIELDS.map(name => meta.format[name])
  if (field === 'inFlight') {
    const inFlight = meta.inFlight
    return inFlight === null ? null : IN_FLIGHT_AAD_FIELDS.map(name => inFlight[name])
  }
  return meta[field]
}

/** 这份元数据的 AAD（加密与解密用同一个函数生成，解密时按库里记录的元数据生成） */
export function draftAad(meta: DraftMeta): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([DRAFT_AAD_FORMAT, ...DRAFT_AAD_FIELDS.map(field => aadValueOf(meta, field))]))
}

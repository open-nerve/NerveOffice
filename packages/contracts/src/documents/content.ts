import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'

/**
 * 快照解压后的上限（00 号计划书 §12.1）：平台格式的一部分，调整按格式变更处理（P4 设计 §3.11）。
 * 上传的压缩数据同样以它为上限。
 */
export const SNAPSHOT_MAX_RAW_BYTES = 5 * 1024 * 1024

/** 快照的嵌套上限（M1 总设计 §6.5 的基本校验）。 */
export const SNAPSHOT_MAX_DEPTH = 64

/** 上传快照的内容类型：正文是 gzip 压缩的快照 JSON 字节，不经 JSON 请求体的解析（P4 设计 §3.3）。 */
export const SNAPSHOT_UPLOAD_CONTENT_TYPE = 'application/gzip'

/**
 * 平台内置的 Univer SDK 版本：写入 documents.sdk_version，与 pnpm 目录里 Univer 各包的版本、门禁的 UNIVER_POLICY 相同。
 * 直接核对（复验 RA6）：后端的单元测试（sdk-version.test.ts）核对它与目录里的核心包一致，deps 门禁核对目录与安装的版本都等于 UNIVER_POLICY。
 * 快照里的 appVersion 不能代表版本：Univer 载入快照时沿用其中的 appVersion，模板里的值会一直留在新建的文档里。
 */
export const UNIVER_SDK_VERSION = '1.0.1'

/** 修订号与数据库的 integer 一致。 */
const REVISION_MAX = 2_147_483_647

/** 查询串里的整数：只接受不带前导零的十进制数字（空串、正负号、小数、指数与十六进制都不接受）。 */
function integerParam(min: number) {
  return z.string()
    .regex(/^(?:0|[1-9]\d{0,9})$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(REVISION_MAX))
}

/**
 * 保存的元数据（PUT /api/documents/{id}/content 的查询参数，P4 设计 §3.5）：
 * - baseRevision：这份快照基于的修订号，不是当前修订号时拒绝保存；
 * - requestId：一次保存尝试一个，网络错误后内容没变就用同一个重发；
 * - clientInstanceId：编辑器页每次加载生成；localSeq：捕获时本页的修改序号。两者用来识别"自己追自己"；
 * - writeEpoch：申请编辑权时得到的代次（M3-P1 设计 §3.4.4），与请求头里的租约令牌（EDIT_LEASE_HEADER）一起核对：
 *   删除、跨空间移动、收回写入权或者有了新的一代之后就对不上，保存被拒（EDIT_LEASE_LOST）。必填（契约是严格结构；v0.1 还没有部署，没有旧页面）
 */
export const saveContentQuerySchema = z.strictObject({
  baseRevision: integerParam(1),
  requestId: uuidSchema,
  clientInstanceId: uuidSchema,
  localSeq: integerParam(0),
  writeEpoch: integerParam(0),
})

export type SaveContentQuery = z.output<typeof saveContentQuerySchema>

/** 保存成功：新的修订号与保存时间。重放时是原来的结果。 */
export const saveContentResponseSchema = z.object({
  revision: z.number().int().min(1),
  savedAt: z.iso.datetime(),
})

export type SaveContentResponse = z.infer<typeof saveContentResponseSchema>

/**
 * 一次修订的来源：产生它的那次保存的标签页（编辑器页每次加载生成的标识）与那次捕获的本地修改序号。
 * 页面据此认出"这一版是本页自己的保存"（P4 设计 §3.5.2 的"自己追自己"，00 号计划书 §7.5）：修订号冲突的详情、
 * 申请编辑权的响应都带它，取法相同（文档当前修订的那一条修订记录）。只给保存这一版的人本人（本人在别的标签页保存的也给，
 * 页面再按标签页比较），别人得到 null：标签页标识是页面自报的，给了别人，就能被照着伪造（M3-P1 复验 C4）
 */
export const revisionSourceSchema = z.object({
  clientInstanceId: z.uuid(),
  localSeq: z.number().int().min(0),
})

export type RevisionSource = z.infer<typeof revisionSourceSchema>

/**
 * 修订号冲突（DOCUMENT_REVISION_CONFLICT）的详情：当前修订号及其来源。
 * 来源是产生当前修订的那次保存；当前修订是新建出来的、或者不是调用者本人保存的时候为 null。
 */
export const revisionConflictDetailsSchema = z.object({
  currentRevision: z.number().int().min(1),
  source: revisionSourceSchema.nullable(),
})

export type RevisionConflictDetails = z.infer<typeof revisionConflictDetailsSchema>

/** 读取内容时的 ETag：修订号加引号（强校验器）。 */
export function revisionEtag(revision: number): string {
  return `"${revision}"`
}

/**
 * 从 ETag 取回修订号；不是 revisionEtag 的写法时为 undefined。
 * 反向代理改动响应的编码（例如重新压缩）时会把它标成弱校验器（W/"n"）：修订号不变，同样接受（审查 B10）。
 */
export function revisionFromEtag(etag: string | null | undefined): number | undefined {
  const match = /^(?:W\/)?"([1-9]\d{0,9})"$/.exec(etag ?? '')
  const revision = match === null ? Number.NaN : Number(match[1])
  return Number.isSafeInteger(revision) && revision <= REVISION_MAX ? revision : undefined
}

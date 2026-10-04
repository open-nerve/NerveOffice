// 客户端上报的构建与数据格式（M3-P3 设计 §3.5，00 号计划书 §7.4 第 4 条、§8.7）：保存、另存为副本、申请编辑权与心跳都带上，
// 服务端核对 Univer 版本、插件档案与平台格式版本等于自己的（UNIVER_SDK_VERSION、DOCUMENT_PROFILE_OF、PLATFORM_FORMAT_VERSION）、
// 构建不低于运维开关（NERVE_MIN_CLIENT_BUILD），否则 CLIENT_OUTDATED。
// 这几个字段在契约里都是可选的：旧页面重试一次结果未知的写入时，到得了重放（重放先于拦截旧客户端，§3.1 第 3 步）；缺字段由服务端按过旧处理
import { z } from 'zod'

/**
 * 版本的写法：x.y.z（不带前导零的十进制，每段最多 9 位），可带 + 之后的诊断信息（点分隔的字母、数字与连字符，例如提交号）。
 * 客户端构建是根 package.json 的 version，构建时注入页面，镜像构建可以把提交号附在 + 之后；SDK 版本也按这个写法比较
 */
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:\+[\dA-Z-]+(?:\.[\dA-Z-]+)*)?$/i

/** 客户端构建的长度上限 */
export const CLIENT_BUILD_MAX_LENGTH = 64

/** x.y.z 的三段数字；不是这个写法（或超过长度上限）时为 undefined。+ 之后的诊断信息不参与 */
export function parseVersion(value: string): readonly [major: number, minor: number, patch: number] | undefined {
  const match = value.length <= CLIENT_BUILD_MAX_LENGTH ? VERSION.exec(value) : null
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 两个版本的先后：负数表示 a 较旧，0 表示相同（+ 之后的诊断信息不比较），正数表示 a 较新；任何一个认不出时为 undefined，
 * 由调用方按不兼容处理（客户端构建按过旧，SDK 版本按文档比服务端新）
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === undefined || right === undefined)
    return undefined
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

/** 上报的客户端构建（请求里）：x.y.z，可带 + 之后的诊断信息 */
export const clientBuildSchema = z.string().max(CLIENT_BUILD_MAX_LENGTH).regex(VERSION)

/**
 * 上报的 Univer 版本与插件档案（请求里）：只限字符与长度，取值不按已知的校验——认不出的由服务端比较之后回答 CLIENT_OUTDATED，
 * 不是 400（不同版本的页面与服务端相遇时要能得到"需要刷新"）
 */
const formatTokenSchema = z.string().regex(/^[\w.@+-]{1,64}$/)

/** 申请编辑权与心跳（JSON 的请求体）里的上报字段，都可选 */
export const clientFormatBodyShape = {
  clientBuild: clientBuildSchema.optional(),
  univerVersion: formatTokenSchema.optional(),
  profile: formatTokenSchema.optional(),
  formatVersion: z.number().int().min(1).max(999_999_999).optional(),
}

/** 保存与另存为副本（查询参数）里的上报字段，都可选；格式版本是不带前导零的十进制 */
export const clientFormatQueryShape = {
  clientBuild: clientBuildSchema.optional(),
  univerVersion: formatTokenSchema.optional(),
  profile: formatTokenSchema.optional(),
  formatVersion: z.string().regex(/^[1-9]\d{0,8}$/).transform(Number).optional(),
}

/** 解析之后的上报字段（请求体与查询参数相同） */
export interface ClientFormat {
  readonly clientBuild?: string | undefined
  readonly univerVersion?: string | undefined
  readonly profile?: string | undefined
  readonly formatVersion?: number | undefined
}

/**
 * CLIENT_OUTDATED 的原因：format——数据格式（Univer 版本、插件档案、平台格式版本）与服务端的不同，或者没有上报；
 * build——构建低于运维开关（或者认不出）
 */
export const CLIENT_OUTDATED_REASONS = ['format', 'build'] as const
export type ClientOutdatedReason = (typeof CLIENT_OUTDATED_REASONS)[number]

/** CLIENT_OUTDATED 的详情。响应宽松：不认识的原因（以及缺少原因）解析成 undefined，页面照样说"需要刷新" */
export const clientOutdatedDetailsSchema = z.object({
  reason: z.enum(CLIENT_OUTDATED_REASONS).optional().catch(undefined),
})

export type ClientOutdatedDetails = z.infer<typeof clientOutdatedDetailsSchema>

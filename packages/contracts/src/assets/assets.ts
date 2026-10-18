import { z } from 'zod'
import { uuidSchema } from '../ids/ids.ts'

/** 图片上传与处理后文件的固定边界（ADR-021），不能由客户端调大。 */
export const ASSET_MAX_BYTES = 5 * 1024 * 1024
export const ASSET_MAX_SIDE = 8192
export const ASSET_MAX_PIXELS = 16_000_000
export const ASSET_EXTENSION_HEADER = 'X-Asset-Extension'
export const ASSET_STATUS_HEADER = 'X-Asset-Status'
export const ASSET_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AssetMimeType = (typeof ASSET_MIME_TYPES)[number]
export const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export type AssetExtension = (typeof ASSET_EXTENSIONS)[number]

/** 请求只交后缀，原文件名不进入服务端任务或日志；只规范化大小写。 */
export const assetExtensionSchema = z.string().toLowerCase().pipe(z.enum(ASSET_EXTENSIONS))
export const assetIdSchema = uuidSchema

/** 读取路径先接受字符串，非规范 ID 也进入鉴权后返回统一占位，不能被参数管线提前变成另一类响应。 */
export const assetReadTargetSchema = z.string()

/** 从服务端的资源 ID 生成规范相对地址；纯地址判定模块不因此引入 zod。 */
export function assetUrl(assetId: string): string {
  return `/api/assets/${assetIdSchema.parse(assetId)}`
}

/** 响应丢弃未来字段，但 ID、地址、字节和尺寸必须自洽。 */
export const assetUploadResponseSchema = z.object({
  assetId: z.uuid().refine(value => value === value.toLowerCase()),
  url: z.string(),
  mimeType: z.enum(ASSET_MIME_TYPES),
  width: z.number().int().min(1).max(ASSET_MAX_SIDE),
  height: z.number().int().min(1).max(ASSET_MAX_SIDE),
  bytes: z.number().int().min(1).max(ASSET_MAX_BYTES),
}).refine(value => assetIdSchema.safeParse(value.assetId).success
  && value.url === assetUrl(value.assetId)
  && value.width * value.height <= ASSET_MAX_PIXELS)
export type AssetUploadResponse = z.infer<typeof assetUploadResponseSchema>

export const ASSET_INVALID_RULES = ['type', 'corrupt', 'dimensions', 'pixels', 'frames', 'animation', 'output', 'too-complex'] as const
export type AssetInvalidRule = (typeof ASSET_INVALID_RULES)[number]

/** 不认识的规则/配额类别回退到通用提示，避免旧客户端因未来详情无法展示错误。 */
export const assetInvalidDetailsSchema = z.object({ rule: z.enum(ASSET_INVALID_RULES).optional().catch(undefined) })
export const assetQuotaDetailsSchema = z.object({ kind: z.enum(['bytes', 'count']).optional().catch(undefined) })
export type AssetInvalidDetails = z.infer<typeof assetInvalidDetailsSchema>
export type AssetQuotaDetails = z.infer<typeof assetQuotaDetailsSchema>

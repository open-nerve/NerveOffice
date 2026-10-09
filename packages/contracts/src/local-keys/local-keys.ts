// 本机密钥（M3-P6 设计 §3.5、§3.6，M3 总设计 §6.6，00 号计划书 §7.6）：每人一把当前有效的 AES-GCM-256 密钥，带版本号，
// 服务端用主密钥包装之后保存。页面（M4）用它加密保存在浏览器里、还没同步的草稿：系统管理员吊销之后，用旧密钥加密的草稿再也解不开，
// 恢复时按版本区分"已吊销"与"被篡改"。M3 的页面不取密钥。
// 字节数与 base64 的写法在 local-key-format.ts（不引用 zod）
import { z } from 'zod'
import { LOCAL_KEY_PATTERN_SOURCE } from './local-key-format.ts'

/** 本机密钥的版本：每人从 1 起，吊销一次加一 */
export const localKeyVersionSchema = z.int().min(1)

/**
 * 取当前的本机密钥（POST /api/local-key，只给本人，M3-P6 设计 §3.5）：版本与原始密钥（32 字节的标准 base64）。第一次取时生成第 1 版，
 * 之后的各版在系统管理员吊销时生成。不用 GET：第一次取要写库，而登录之后的 GET 一律在只读快照里（ADR-017）。
 * 响应不缓存（接口的响应都带 Cache-Control: no-store）；页面只放在内存里（M4 导入为不可导出的 CryptoKey）
 */
export const localKeySchema = z.object({
  version: localKeyVersionSchema,
  key: z.string().regex(new RegExp(LOCAL_KEY_PATTERN_SOURCE)),
})

export type LocalKey = z.infer<typeof localKeySchema>

/**
 * 一个人当前的本机密钥的摘要（管理界面的账户，M3-P6 设计 §3.5）：版本与生成的时刻。只有这两项，绝不带密钥材料（原始的、包装之后的都不带）
 */
export const localKeySummarySchema = z.object({
  version: localKeyVersionSchema,
  createdAt: z.iso.datetime(),
})

export type LocalKeySummary = z.infer<typeof localKeySummarySchema>

// ADR-021：来源和许可必须与已核对的精确原生版本对应；只读取/校验资料，不执行其中的构建脚本。
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export const materialPathSchema = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !/^[a-z]:/iu.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), '材料路径必须是安全的相对路径')
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export const materialFileSchema = z.strictObject({ path: materialPathSchema, bytes: z.number().int().positive(), sha256: digestSchema })
const httpsUrl = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}, '来源只接受不带凭据的 HTTPS 地址')
export const sourceManifestSchema = z.strictObject({
  format: z.literal(1),
  sharp: z.string().regex(/^\d+\.\d+\.\d+$/u),
  sharpLibvips: z.string().regex(/^\d+\.\d+\.\d+$/u),
  libvips: z.string().regex(/^\d+\.\d+\.\d+$/u),
  platforms: z.array(z.enum(['darwin-arm64', 'linux-arm64', 'linux-x64'])).min(1),
  sources: z.array(materialFileSchema.extend({
    kind: z.enum(['source', 'patch', 'license', 'license-supplement', 'rust-crate']),
    url: httpsUrl,
    vendoredPath: materialPathSchema.refine(value => value.startsWith('inputs/'), '仓库补件必须位于 inputs/').optional(),
  })).min(1),
  rustLockBasis: z.string().min(1),
  noticeBook: materialFileSchema.extend({ path: z.literal('apps/api/third-party-licenses/native-images/LICENSE') }),
})
const noticeSchema = z.strictObject({
  title: z.string().min(1),
  source: materialPathSchema,
  member: materialPathSchema.nullable(),
  // 原始归档中也有空 AUTHORS：保留零字节事实，不把它当成完整许可。
  bytes: z.number().int().nonnegative(),
  sha256: digestSchema,
  encoding: z.enum(['utf-8', 'latin-1']),
  note: z.string().optional(),
})
export const noticeIndexSchema = z.strictObject({
  format: z.literal(1),
  noticeBook: sourceManifestSchema.shape.noticeBook,
  entries: z.array(noticeSchema).min(1),
  missingStandaloneLicenseResolution: z.array(z.strictObject({ crate: z.string().min(1), method: z.string().min(1) })),
  unresolved: z.array(z.string()),
})

export type SourceManifest = z.infer<typeof sourceManifestSchema>
export type NativeSource = SourceManifest['sources'][number]
export type MaterialFile = z.infer<typeof materialFileSchema>
export interface NativeMaterials {
  readonly directory: string
  readonly manifest: SourceManifest
  readonly index: z.infer<typeof noticeIndexSchema>
  readonly book: Buffer
  readonly readme: Buffer
}

/** 受控根之下逐级拒绝符号链接与非普通文件；根以上的系统路径（如 macOS /var）按真实路径解析。 */
export function materialFilePath(root: string, relative: string): string {
  materialPathSchema.parse(relative)
  if (lstatSync(root).isSymbolicLink())
    throw new Error(`材料根不能是符号链接：${root}`)
  let current = realpathSync(root)
  const parts = relative.split('/')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink())
      throw new Error(`材料路径不能包含符号链接：${relative}`)
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      throw new Error(`材料路径不是普通文件或目录：${relative}`)
  }
  return current
}

export function loadNativeMaterials(root: string): NativeMaterials {
  const directory = join(root, 'deploy/native-images')
  const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(materialFilePath(directory, 'sources.json'), 'utf8')))
  const index = noticeIndexSchema.parse(JSON.parse(readFileSync(materialFilePath(directory, 'notices-index.json'), 'utf8')))
  return { directory, manifest, index, book: readFileSync(materialFilePath(root, manifest.noticeBook.path)), readme: readFileSync(materialFilePath(directory, 'README.md')) }
}

export function verifyBytes(bytes: Uint8Array, expected: Pick<MaterialFile, 'bytes' | 'sha256'>): void {
  if (bytes.length !== expected.bytes)
    throw new Error('材料大小与清单不符')
  if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
    throw new Error('材料摘要与清单不符')
}

export function uniqueMaterialPaths(paths: readonly string[]): void {
  const set = new Set(paths)
  if (set.size !== paths.length)
    throw new Error('材料路径重复')
  for (const path of paths) {
    materialPathSchema.parse(path)
    const parts = path.split('/')
    for (let end = 1; end < parts.length; end += 1) {
      if (set.has(parts.slice(0, end).join('/')))
        throw new Error(`材料路径同时被用作文件和目录：${path}`)
    }
  }
}

function noticeHeader(entry: z.infer<typeof noticeSchema>): string {
  return `\n\n${'='.repeat(72)}\n${entry.title}\n来源：${entry.source}${entry.member === null ? '' : `\n归档成员：${entry.member}`}\n原始 SHA-256：${entry.sha256}${entry.note === undefined ? '' : `\n说明：${entry.note}`}\n\n`
}

/** 同时用于仓库门禁与已分发成品；正文的每一节仍要对应索引，不能只检查文件存在。 */
export function validateNativeMetadata(input: Pick<NativeMaterials, 'manifest' | 'index' | 'book'>): void {
  const manifest = sourceManifestSchema.parse(input.manifest)
  const index = noticeIndexSchema.parse(input.index)
  uniqueMaterialPaths(manifest.sources.map(row => row.path))
  if (new Set(manifest.platforms).size !== manifest.platforms.length)
    throw new Error('平台重复')
  if (index.unresolved.length !== 0)
    throw new Error('存在未解决的许可声明')
  for (const key of ['path', 'sha256', 'bytes'] as const) {
    if (index.noticeBook[key] !== manifest.noticeBook[key])
      throw new Error('两份清单的声明正文记录不同')
  }
  verifyBytes(input.book, manifest.noticeBook)
  const sources = new Set(manifest.sources.map(row => row.path))
  let cursor = 0
  for (const entry of index.entries) {
    if (!sources.has(entry.source))
      throw new Error(`许可声明缺少来源：${entry.source}`)
    const header = Buffer.from(noticeHeader(entry))
    const position = input.book.indexOf(header, cursor)
    if (position < 0)
      throw new Error(`许可正文与索引不一致：${entry.title}`)
    const start = position + header.length
    // 节之间另有原始 crate 声明与归档摘要，不能把这些说明误算为前一许可的字节。
    // Latin-1 原文每字节对应一个码位，汇总文件统一编码为 UTF-8。
    const section = entry.encoding === 'latin-1' ? input.book.subarray(start).toString('utf8').slice(0, entry.bytes) : undefined
    const bytes = section === undefined ? input.book.subarray(start, start + entry.bytes) : Buffer.from(section, 'latin1')
    if (section !== undefined && bytes.toString('latin1') !== section)
      throw new Error('许可正文编码与索引不一致')
    try {
      verifyBytes(bytes, entry)
    }
    catch (error) {
      throw new Error(`许可节 ${entry.title}：${error instanceof Error ? error.message : '校验失败'}`, { cause: error })
    }
    cursor = start + (section === undefined ? bytes.length : Buffer.byteLength(section))
  }
}

export function validateNativeMaterials(input: NativeMaterials): void {
  validateNativeMetadata(input)
  if (input.readme.length === 0)
    throw new Error('缺少构建与替换说明')
  for (const source of input.manifest.sources) {
    if (source.vendoredPath !== undefined)
      verifyBytes(readFileSync(materialFilePath(input.directory, source.vendoredPath)), source)
  }
}

export function nativePackageProblems(manifest: SourceManifest, packages: readonly { name: string, version: string }[]): string[] {
  return packages.flatMap((item) => {
    if (item.name === 'sharp')
      return item.version === manifest.sharp ? [] : [`Sharp ${item.version} 与来源清单 ${manifest.sharp} 不同`]
    const libvips = item.name.startsWith('@img/sharp-libvips-')
    const prefix = libvips ? '@img/sharp-libvips-' : '@img/sharp-'
    if (!item.name.startsWith(prefix))
      return []
    const platform = item.name.slice(prefix.length)
    const version = libvips ? manifest.sharpLibvips : manifest.sharp
    return (manifest.platforms as readonly string[]).includes(platform) && item.version === version ? [] : [`未经本清单核对的原生包：${item.name}@${item.version}`]
  })
}

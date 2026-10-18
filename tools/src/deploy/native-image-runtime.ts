import type { SourceManifest } from './native-image-materials.ts'
import { createRequire } from 'node:module'
import process from 'node:process'
import { z } from 'zod'

/** 由 API 的依赖入口解析，不能用构建工具自己装的版本替代运行版本。 */
export function verifyInstalledNativeImages(apiPackage: string, expected: Pick<SourceManifest, 'sharp' | 'sharpLibvips' | 'libvips' | 'platforms'>): { platform: string, sharp: string, sharpLibvips: string, libvips: string } {
  const platform = `${process.platform}-${process.arch}`
  const supported: readonly string[] = expected.platforms
  if (!supported.includes(platform))
    throw new Error(`原生图片平台未核对：${platform}`)
  const api = createRequire(apiPackage)
  const sharp: unknown = api('sharp')
  if (typeof sharp !== 'function' || !('versions' in sharp))
    throw new Error('无法读取实际 Sharp 版本')
  const versions = z.object({ sharp: z.string(), vips: z.string() }).parse(sharp.versions)
  const binding = createRequire(api.resolve('sharp'))
  const metadata = z.object({ name: z.literal(`@img/sharp-libvips-${platform}`), version: z.string() }).parse(binding(`@img/sharp-libvips-${platform}/package`))
  if (versions.sharp !== expected.sharp || versions.vips !== expected.libvips || metadata.version !== expected.sharpLibvips)
    throw new Error('实际 Sharp/libvips 版本与随附材料不一致')
  return { platform, sharp: versions.sharp, sharpLibvips: metadata.version, libvips: versions.vips }
}

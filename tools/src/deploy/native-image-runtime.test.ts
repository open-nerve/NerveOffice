import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'
import { loadNativeMaterials } from './native-image-materials.ts'
import { verifyInstalledNativeImages } from './native-image-runtime.ts'

describe('实际原生绑定与分发材料版本一致', () => {
  const manifest = loadNativeMaterials(REPO_ROOT).manifest
  const api = join(REPO_ROOT, 'apps/api/package.json')
  it('从 API 自己的生产依赖解析 Sharp，读取实际加载的 libvips 版本与平台包', () => {
    expect(verifyInstalledNativeImages(api, manifest)).toEqual({ platform: `${process.platform}-${process.arch}`, sharp: manifest.sharp, sharpLibvips: manifest.sharpLibvips, libvips: manifest.libvips })
  })
  it.each(['sharp', 'sharpLibvips', 'libvips'] as const)('材料声称另一 %s 版本时拒绝', (key) => {
    expect(() => verifyInstalledNativeImages(api, { ...manifest, [key]: '0.0.1' })).toThrow(/版本/u)
  })
  it('当前平台不在材料已核对范围内时拒绝', () => {
    expect(() => verifyInstalledNativeImages(api, { ...manifest, platforms: [] })).toThrow(/平台/u)
  })
})

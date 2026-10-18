import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'
import { loadNativeMaterials, nativePackageProblems, sourceManifestSchema, validateNativeMaterials, verifyBytes } from './native-image-materials.ts'

describe('图片原生依赖的来源与声明清单', () => {
  it('真实材料闭合：每份声明有来源，全部补件和正文逐字节对应，GPL 正文与概述不混淆', () => {
    const input = loadNativeMaterials(REPO_ROOT)
    expect(input.manifest.sources).toHaveLength(398)
    expect(input.index.entries).toHaveLength(816)
    expect(() => validateNativeMaterials(input)).not.toThrow()
    const overview = input.index.entries.find(entry => entry.source === 'native/GPL-3.0' && entry.member === null)
    expect(overview?.title).toBe('gnulib 原始许可概述（并非 GPLv3 正文）')
    expect(input.index.entries.some(entry => entry.source === 'native/lcms' && entry.member?.endsWith('/COPYING.GPL3'))).toBe(true)
  })

  it.each(['../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', 'C:/escape', 'a/./b'])('拒绝不安全材料路径 %s', (path) => {
    const input = loadNativeMaterials(REPO_ROOT)
    expect(() => sourceManifestSchema.parse({ ...input.manifest, sources: [{ ...input.manifest.sources[0], path }] })).toThrow()
  })

  it('精确大小与摘要都必须一致，坏缓存不视为命中', () => {
    const input = loadNativeMaterials(REPO_ROOT)
    const item = input.manifest.sources.find(row => row.vendoredPath !== undefined)!
    const bytes = readFileSync(join(input.directory, item.vendoredPath!))
    expect(() => verifyBytes(bytes, item)).not.toThrow()
    expect(() => verifyBytes(Buffer.concat([bytes, Buffer.from('x')]), item)).toThrow(/大小/u)
    const changed = Buffer.from(bytes)
    changed[0] = changed[0]! ^ 1
    expect(() => verifyBytes(changed, item)).toThrow(/摘要/u)
  })

  it('重复或文件/目录冲突的来源路径必须失败', () => {
    const input = loadNativeMaterials(REPO_ROOT)
    const first = input.manifest.sources[0]!
    for (const path of [first.path, `${first.path}/nested`])
      expect(() => validateNativeMaterials({ ...input, manifest: { ...input.manifest, sources: [...input.manifest.sources, { ...first, path }] } })).toThrow(/路径/u)
  })

  it('索引遗漏来源、声明未解决、正文与清单不一致均不能通过', () => {
    const input = loadNativeMaterials(REPO_ROOT)
    expect(() => validateNativeMaterials({ ...input, manifest: { ...input.manifest, sources: input.manifest.sources.slice(1) } })).toThrow(/来源/u)
    expect(() => validateNativeMaterials({ ...input, index: { ...input.index, unresolved: ['missing-license'] } })).toThrow(/未解决/u)
    expect(() => validateNativeMaterials({ ...input, book: Buffer.from('missing text') })).toThrow(/大小|摘要/u)
    expect(() => validateNativeMaterials({ ...input, index: { ...input.index, noticeBook: { ...input.index.noticeBook, sha256: '0'.repeat(64) } } })).toThrow(/声明正文/u)
  })

  it('正文整体摘要不能代替逐节索引：节摘要、编码与内容仍需对应', () => {
    const input = loadNativeMaterials(REPO_ROOT)
    expect(() => validateNativeMaterials({ ...input, index: { ...input.index, entries: input.index.entries.map((entry, index) => index === 0 ? { ...entry, bytes: entry.bytes + 1 } : entry) } })).toThrow(/大小|摘要/u)
  })

  it('只接受已核对的精确 Sharp、绑定和 libvips 包版本及平台', () => {
    const { manifest } = loadNativeMaterials(REPO_ROOT)
    expect(nativePackageProblems(manifest, [
      { name: 'sharp', version: '0.35.5' },
      { name: '@img/sharp-linux-x64', version: '0.35.5' },
      { name: '@img/sharp-libvips-linux-x64', version: '1.3.4' },
    ])).toEqual([])
    for (const item of [
      { name: 'sharp', version: '0.35.6' },
      { name: '@img/sharp-linux-x64', version: '0.35.6' },
      { name: '@img/sharp-libvips-linux-x64', version: '1.3.5' },
      { name: '@img/sharp-libvips-linuxmusl-x64', version: '1.3.4' },
    ])
      expect(nativePackageProblems(manifest, [item])).toHaveLength(1)
  })
})

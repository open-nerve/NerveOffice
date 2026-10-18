import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPrivateAssetRoot } from './asset-deployment.ts'

describe('运行镜像中的私有资源根', () => {
  const directories: string[] = []
  function setup(): { root: string, web: string } {
    const directory = mkdtempSync(join(tmpdir(), 'nerve-asset-deployment-'))
    directories.push(directory)
    const root = join(directory, 'assets')
    const web = join(directory, 'web')
    mkdirSync(root, { mode: 0o700 })
    mkdirSync(web, { mode: 0o755 })
    return { root, web }
  }
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })
  it('真实写入并同步私有文件，完成后不留下探针', () => {
    const { root, web } = setup()
    expect(verifyPrivateAssetRoot(root, web)).toMatchObject({ private: true, writable: true, separated: true })
    expect(readdirSync(root)).toEqual([])
  })
  it.each([0o755, 0o750, 0o500])('不是 0700 时拒绝（%i）', (mode) => {
    const { root, web } = setup()
    chmodSync(root, mode)
    expect(() => verifyPrivateAssetRoot(root, web)).toThrow(/权限/u)
  })
  it('目录不存在时不悄悄创建', () => {
    const { root, web } = setup()
    rmSync(root, { recursive: true })
    expect(() => verifyPrivateAssetRoot(root, web)).toThrow()
    expect(existsSync(root)).toBe(false)
  })
  it('私有根的符号链接不通过', () => {
    const { root, web } = setup()
    const link = `${root}-link`
    symlinkSync(root, link)
    expect(() => verifyPrivateAssetRoot(link, web)).toThrow(/符号链接/u)
  })
  it('相等或互相包含的真实 Web 根不能通过（包括 Web 符号链接）', () => {
    const { root, web } = setup()
    mkdirSync(join(root, 'nested'))
    for (const pair of [[root, root], [root, join(root, 'nested')], [join(root, 'nested'), root]])
      expect(() => verifyPrivateAssetRoot(pair[0] ?? '', pair[1] ?? '')).toThrow(/重叠/u)
    const link = `${web}-link`
    symlinkSync(root, link)
    expect(() => verifyPrivateAssetRoot(root, link)).toThrow(/重叠/u)
  })
})

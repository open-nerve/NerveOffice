import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertPrivateAssetLocation } from './asset-location.ts'

let directory: string
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'nerve-asset-location-')))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('资源目录与静态托管的启动边界', () => {
  it('资源目录尚未创建也不能配置为前端目录或其子目录', async () => {
    const web = join(directory, 'web')
    await mkdir(web)
    for (const assets of [web, join(web, 'private-assets'), join(web, 'a', '..', 'private-assets')])
      expect(() => assertPrivateAssetLocation(assets, web)).toThrow('NERVE_ASSET_ROOT 与 NERVE_WEB_ROOT 必须位于互不包含的目录')
  })

  it('前端目录不能位于私有资源根下，前端的符号链接也不能隐藏重叠', async () => {
    const assets = join(directory, 'assets')
    const web = join(assets, 'web')
    await mkdir(web, { recursive: true })
    const alias = join(directory, 'public-alias')
    await symlink(assets, alias)
    expect(() => assertPrivateAssetLocation(assets, web)).toThrow()
    expect(() => assertPrivateAssetLocation(join(assets, 'images'), alias)).toThrow()
    expect(() => assertPrivateAssetLocation(join(alias, 'web', 'images'), web)).toThrow()
  })

  it('相邻目录或同名前缀目录互不影响；不托管前端时不增加目录限制', async () => {
    const web = join(directory, 'web')
    await mkdir(web)
    expect(() => assertPrivateAssetLocation(join(directory, 'web-private'), web)).not.toThrow()
    expect(() => assertPrivateAssetLocation(join(directory, 'assets'), web)).not.toThrow()
    expect(() => assertPrivateAssetLocation(join(directory, 'assets'), undefined)).not.toThrow()
  })
})

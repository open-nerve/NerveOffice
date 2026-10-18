import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { ConfigError } from '../modules/config/index.ts'

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

/** 未创建的末级目录用最近的真实祖先定位，也覆盖不区分大小写的文件系统。 */
function canonicalLocation(path: string): string {
  const suffix: string[] = []
  let ancestor = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...suffix)
    }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || dirname(ancestor) === ancestor)
        throw new ConfigError([{ variable: 'NERVE_ASSET_ROOT', problem: '无法核对资源目录的位置' }])
      suffix.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}

/**
 * 在构建应用之前拒绝静态托管与私有卷重叠。资源根允许尚未创建，但其所有祖先随后由
 * FileStorage 拒绝符号链接；前端根可以是发布用的符号链接，此处按真实路径判断。
 */
export function assertPrivateAssetLocation(assetRoot: string | undefined, webRoot: string | undefined): void {
  if (assetRoot === undefined || webRoot === undefined)
    return
  let web: string
  try {
    web = realpathSync(webRoot)
  }
  catch {
    throw new ConfigError([{ variable: 'NERVE_WEB_ROOT', problem: '必须指向可访问的前端构建目录' }])
  }
  const assets = canonicalLocation(assetRoot)
  if (contains(web, assets) || contains(assets, web))
    throw new ConfigError([{ variable: 'NERVE_ASSET_ROOT', problem: 'NERVE_ASSET_ROOT 与 NERVE_WEB_ROOT 必须位于互不包含的目录' }])
}

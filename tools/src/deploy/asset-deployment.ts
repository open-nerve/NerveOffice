import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import process from 'node:process'

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** 对实际挂载路径做一次写入/fsync；不是仅检查 Compose 声明。 */
export function verifyPrivateAssetRoot(root: string, webRoot: string): { uid: number, private: true, writable: true, separated: true } {
  const uid = process.getuid?.()
  if (uid === undefined || uid === 0)
    throw new Error('资源部署检查必须以非 root 应用用户运行')
  if (!isAbsolute(root) || !isAbsolute(webRoot))
    throw new Error('资源根与 Web 根必须为绝对路径')
  const stat = lstatSync(root)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('资源根必须是普通目录，不能是符号链接')
  const realRoot = realpathSync(root)
  const realWeb = realpathSync(webRoot)
  if (within(realRoot, realWeb) || within(realWeb, realRoot))
    throw new Error('资源根与 Web 根重叠')
  if (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)
    throw new Error('资源根所有者或私有权限不符')
  const probe = join(root, `.deployment-${randomUUID()}`)
  const fd = openSync(probe, 'wx', 0o600)
  try {
    // 先摘掉目录项，进程即使中断也不留下探针；同步已打开的同一文件。
    unlinkSync(probe)
    writeSync(fd, 'private asset volume')
    fsyncSync(fd)
  }
  finally {
    closeSync(fd)
  }
  return { uid, private: true, writable: true, separated: true }
}

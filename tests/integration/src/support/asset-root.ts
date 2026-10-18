import { mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directories = new Map<string, string>()
function keyOf(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  return `${url.host}${url.pathname}`
}

/** 同一隔离库的重启/多实例共用私有卷；测试结束删库时统一回收，命令行不创建目录。 */
export function testAssetRoot(databaseUrl: string): string {
  const key = keyOf(databaseUrl)
  let directory = directories.get(key)
  if (directory === undefined) {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'nerve-it-assets-')))
    directories.set(key, directory)
  }
  return join(directory, 'assets')
}

export async function removeTestAssetRoot(databaseUrl: string): Promise<void> {
  const key = keyOf(databaseUrl)
  const directory = directories.get(key)
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true })
    directories.delete(key)
  }
}

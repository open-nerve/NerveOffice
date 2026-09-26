// 读取仓库状态的公共函数：仓库根目录、工作区的包、执行 pnpm 并解析 JSON 输出。
import { execFileSync } from 'node:child_process'
import { globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from 'yaml'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

export function readText(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

export function readJson(path: string): unknown {
  return JSON.parse(readText(path))
}

export interface WorkspaceConfig {
  packages: string[]
  catalog: Record<string, string>
  catalogs: Record<string, Record<string, string>>
}

export function readWorkspaceConfig(): WorkspaceConfig {
  const raw = parse(readText('pnpm-workspace.yaml')) as Partial<WorkspaceConfig> | null
  return { packages: raw?.packages ?? [], catalog: raw?.catalog ?? {}, catalogs: raw?.catalogs ?? {} }
}

/** 工作区里各包的目录（相对仓库根目录），按 pnpm-workspace.yaml 的 packages 展开。 */
export function workspacePackageDirs(config: WorkspaceConfig): string[] {
  const dirs = config.packages.flatMap(pattern => globSync(pattern, { cwd: REPO_ROOT }))
  return dirs.filter(dir => statSync(join(REPO_ROOT, dir, 'package.json'), { throwIfNoEntry: false })?.isFile() === true).sort()
}

/** 执行 pnpm 命令并解析它的 JSON 输出；pnpm audit 发现漏洞时退出码不为 0，输出仍是 JSON。 */
export function pnpmJson(args: readonly string[]): unknown {
  try {
    return JSON.parse(execFileSync('pnpm', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
  catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && stdout.trim().startsWith('{'))
      return JSON.parse(stdout)
    throw error
  }
}

/** 递归列出目录下的文件（相对仓库根目录）；目录不存在时返回空数组。 */
export function listFiles(dir: string, include: (path: string) => boolean): string[] {
  const absolute = join(REPO_ROOT, dir)
  if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory() !== true)
    return []
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(REPO_ROOT, join(entry.parentPath, entry.name)))
    .filter(include)
    .sort()
}

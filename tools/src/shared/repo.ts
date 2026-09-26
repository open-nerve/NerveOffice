// 读取仓库状态的公共函数：仓库根目录、工作区的包、执行命令并解析 JSON 输出。外部数据一律先校验结构。
import { execFileSync, spawnSync } from 'node:child_process'
import { globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

export const REPO_ROOT = resolve(import.meta.dirname, '../../..')

export function readText(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

export function readJson(path: string): unknown {
  return JSON.parse(readText(path))
}

const versionMap = z.record(z.string(), z.string())

const workspaceConfigSchema = z.object({
  packages: z.array(z.string()).default([]),
  catalog: versionMap.default({}),
  catalogs: z.record(z.string(), versionMap).default({}),
})

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>

export function readWorkspaceConfig(): WorkspaceConfig {
  return workspaceConfigSchema.parse(parse(readText('pnpm-workspace.yaml')) ?? {})
}

/** 工作区里各包的目录（相对仓库根目录），按 pnpm-workspace.yaml 的 packages 展开。 */
export function workspacePackageDirs(config: WorkspaceConfig): string[] {
  const dirs = config.packages.flatMap(pattern => globSync(pattern, { cwd: REPO_ROOT }))
  return dirs.filter(dir => statSync(join(REPO_ROOT, dir, 'package.json'), { throwIfNoEntry: false })?.isFile() === true).sort()
}

const manifestNameSchema = z.object({ name: z.string() })

export function packageName(dir: string): string {
  return manifestNameSchema.parse(readJson(join(dir, 'package.json'))).name
}

/**
 * 执行命令并解析它输出的 JSON。有的命令发现问题时退出码不为 0（例如 pnpm audit 发现漏洞），
 * 但输出仍是完整的 JSON，这时照常解析；输出不是 JSON 时抛出原来的错误。
 */
export function commandJson(command: string, args: readonly string[]): unknown {
  try {
    return JSON.parse(execFileSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
  catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string' && /^\s*[[{]/.test(stdout))
      return JSON.parse(stdout)
    throw error
  }
}

export interface CommandOptions {
  /** 默认是仓库根目录 */
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** 执行命令并返回它的标准输出；失败时抛出的错误带上标准错误的内容。 */
export function commandText(command: string, args: readonly string[], options: CommandOptions = {}): string {
  try {
    return execFileSync(command, args, { cwd: options.cwd ?? REPO_ROOT, env: options.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    throw new Error(`${command} ${args.join(' ')} 失败${typeof stderr === 'string' && stderr.trim() !== '' ? `：${stderr.trim()}` : ''}`, { cause: error })
  }
}

export interface CommandOutput {
  stdout: string
  stderr: string
}

/**
 * 执行命令，返回标准输出与标准错误（有的工具把结论写在标准错误里）。
 * 命令无法执行、退出码不为 0 或被信号结束时抛出错误，说明里带上标准错误的内容。
 */
export function commandOutput(command: string, args: readonly string[], options: CommandOptions = {}): CommandOutput {
  const commandLine = `${command} ${args.join(' ')}`
  const result = spawnSync(command, args, { cwd: options.cwd ?? REPO_ROOT, env: options.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined)
    throw new Error(`${commandLine} 无法执行：${result.error.message}`, { cause: result.error })
  if (result.status !== 0) {
    const ending = result.signal === null ? `退出码 ${String(result.status)}` : `被信号 ${result.signal} 结束`
    const stderr = result.stderr.trim()
    throw new Error(`${commandLine} 失败（${ending}）${stderr === '' ? '' : `：${stderr}`}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
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

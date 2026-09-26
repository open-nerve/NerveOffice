// 迁移门禁的装配（ADR-005）：从工作区与 git 读取当前与基准版本的迁移目录，交给 checkMigrations 判断。
// 仓库根目录与 git 的读取方式可以注入，用临时 git 仓库测试（审查 B10）。
import type { MigrationFiles } from './migrations.ts'
import type { Violation } from './types.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { commandText } from '../shared/repo.ts'
import { checkMigrations, MIGRATIONS_DIR } from './migrations.ts'

export interface GitReader {
  mergeBase: (left: string, right: string) => string
  /** ref 里某个目录下的文件（相对仓库根） */
  listFiles: (ref: string, dir: string) => string[]
  show: (ref: string, path: string) => string
}

export function gitIn(root: string): GitReader {
  const git = (args: readonly string[]): string => commandText('git', args, { cwd: root })
  return {
    mergeBase: (left, right) => git(['merge-base', left, right]).trim(),
    // -z：路径按 NUL 分隔、不转义；否则非 ASCII 的文件名会被加引号转义，读取时找不到（审查 B5）
    listFiles: (ref, dir) => git(['ls-tree', '-r', '-z', '--name-only', ref, '--', dir]).split('\0').filter(path => path !== ''),
    show: (ref, path) => git(['show', `${ref}:${path}`]),
  }
}

/**
 * 比较的基准（审查 B4、B6）：
 * - GATE_MIGRATIONS_BASE 指定：CI 的推送事件传入推送之前的提交，一次推送里的每个提交都在比较范围内；
 * - CI 的其他事件（定时、手动）用 HEAD^1；
 * - 本机用与 main 的分叉点。
 * 新建分支的推送里"推送之前的提交"是全零，视为没有指定。
 */
export function migrationsBaseRef(env: NodeJS.ProcessEnv, mergeBase: () => string): string {
  const explicit = env.GATE_MIGRATIONS_BASE
  if (explicit !== undefined && explicit !== '' && !/^0+$/.test(explicit))
    return explicit
  if (env.GITHUB_ACTIONS === 'true')
    return 'HEAD^1'
  return mergeBase()
}

/** 工作区里的迁移目录：相对迁移目录的路径 → 内容。 */
export function readWorkingTree(root: string): MigrationFiles {
  const dir = join(root, MIGRATIONS_DIR)
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true)
    return new Map()
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  return new Map(files.map((entry) => {
    const path = join(entry.parentPath, entry.name)
    return [relative(dir, path).split('\\').join('/'), readFileSync(path, 'utf8')]
  }))
}

/** 某个提交里的迁移目录。 */
export function readAt(git: GitReader, ref: string): MigrationFiles {
  const prefix = `${MIGRATIONS_DIR}/`
  return new Map(git.listFiles(ref, MIGRATIONS_DIR).map(path => [path.slice(prefix.length), git.show(ref, path)]))
}

export interface MigrationsGateResult {
  violations: Violation[]
  notes: string[]
}

export function runMigrationsGate(options: { root: string, env: NodeJS.ProcessEnv, git: GitReader }): MigrationsGateResult {
  let ref: string
  let base: MigrationFiles
  try {
    ref = migrationsBaseRef(options.env, () => options.git.mergeBase('HEAD', 'main'))
    base = readAt(options.git, ref)
  }
  catch (error) {
    const detail = `取不到比较的基准，不能确认已合并的迁移没有被改动：${error instanceof Error ? error.message : String(error)}（可以用 GATE_MIGRATIONS_BASE 指定基准）`
    return { violations: [{ rule: 'migrations/base', subject: MIGRATIONS_DIR, detail }], notes: [] }
  }
  const current = readWorkingTree(options.root)
  const count = (files: MigrationFiles): number => [...files.keys()].filter(path => path.endsWith('.sql')).length
  return { violations: checkMigrations(current, base), notes: [`基准 ${ref}：已合并 ${count(base)} 个迁移，当前 ${count(current)} 个`] }
}

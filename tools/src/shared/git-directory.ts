// Git hooks 导出的仓库定位变量会覆盖 cwd。指定另一目录时，只净化该子进程的环境。
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { commandText } from './repo.ts'

export function gitDirectoryEnvironment(root: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = commandText('git', ['rev-parse', '--local-env-vars'], { cwd: root, env: inherited }).trim().split('\n')
  if (names.length > 64 || names.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))
    || !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].every(name => names.includes(name))) {
    throw new Error('无法核对 Git 仓库局部环境变量')
  }
  const local = new Set(names)
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !local.has(name) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)))
}

/** 只操作指定的工作树根；初始化必须是尚无 .git 的新目录。 */
export function gitInDirectory(root: string, args: readonly string[], inherited: NodeJS.ProcessEnv = process.env): string {
  const directory = realpathSync(root)
  const env = gitDirectoryEnvironment(directory, inherited)
  const run = (command: readonly string[]): string => commandText('git', command, { cwd: directory, env })
  if (args[0] === 'init') {
    if (lstatSync(join(directory, '.git'), { throwIfNoEntry: false }) !== undefined)
      throw new Error('拒绝重新初始化已有 Git 目录')
  }
  else if (realpathSync(run(['rev-parse', '--show-toplevel']).trim()) !== directory) {
    throw new Error('指定目录不是 Git 工作树根')
  }
  const output = run(args)
  if (args[0] === 'init' && realpathSync(run(['rev-parse', '--show-toplevel']).trim()) !== directory)
    throw new Error('新 Git 工作树不属于指定目录')
  return output
}

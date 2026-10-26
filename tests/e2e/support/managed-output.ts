// 正式命令由 tools/test-resources/run.py 登记；只读 --list 不创建资源。
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export function managedOutputPath(name?: string): string {
  if (name !== undefined && (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)))
    throw new Error('测试结果文件名不得越界')
  const scratch = process.env.NERVE_TEST_SCRATCH
  const output = process.env.NERVE_TEST_OUTPUT_DIR
  const runId = process.env.NERVE_TEST_RUN_ID
  if (scratch === undefined || output === undefined || runId === undefined) {
    if (process.argv.includes('--list')) {
      const directory = fileURLToPath(new URL('../test-results', import.meta.url))
      return name === undefined ? directory : join(directory, name)
    }
    throw new Error('请通过测试资源运行器执行：pnpm --filter @nerve-office/e2e test；手动命令用 python3 tools/test-resources/run.py e2e -- …')
  }
  const manifest = join(dirname(scratch), 'run.json')
  if (realpathSync(scratch) !== scratch || lstatSync(manifest).isSymbolicLink()
    || output !== join(scratch, 'tests/e2e/test-results')) {
    throw new Error('测试目录归属不符')
  }
  const value = JSON.parse(readFileSync(manifest, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('runId' in value) || value.runId !== runId || !('status' in value) || value.status !== 'running') {
    throw new Error('测试运行归属或状态不符')
  }
  const target = name === undefined ? output : join(output, name)
  requireInside(target, scratch)
  return target
}

function inside(path: string, root: string): boolean {
  const absolute = resolve(path)
  if (!absolute.startsWith(root + sep))
    return false
  for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
    try {
      if (lstatSync(parent).isSymbolicLink())
        return false
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }
  return true
}

export function requireInside(path: string, root: string): void {
  if (!inside(path, root))
    throw new Error('测试目录不得越界或经过链接')
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error('测试目录不得是链接')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
}

export function requireManagedReport(path: string): void {
  requireInside(path, managedOutputPath())
}

/** Unix socket 的路径长度有限，短根由运行器单独预登记，不能借用任意 /tmp 目录。 */
export function managedVmTemporaryRoot(): string {
  managedOutputPath()
  const runId = process.env.NERVE_TEST_RUN_ID!
  const root = process.env.NERVE_TEST_SHORT_ROOT
  const scratch = process.env.NERVE_TEST_SCRATCH!
  if (root !== join(realpathSync('/tmp'), `nerve-vm-${runId}`))
    throw new Error('VM 短路径不属于本轮')
  const record = JSON.parse(readFileSync(join(dirname(scratch), 'run.json'), 'utf8')) as { shortRoot?: unknown, repo?: unknown }
  if (record.shortRoot !== root || realpathSync(root) !== root || lstatSync(join(root, 'owner.json')).isSymbolicLink())
    throw new Error('VM 短路径登记不符')
  const owner = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8')) as { runId?: unknown, repo?: unknown, kind?: unknown }
  if (owner.runId !== runId || owner.repo !== record.repo || owner.kind !== 'vm-short-path')
    throw new Error('VM 短路径创建证明不符')
  return root
}

/** VM 资格、克隆、实验须在同一个管理运行中；不接管用户或其他任务的既有 VM。 */
export function requireManagedVm(resource: { readonly directory: string, readonly disk: string }, output: string): void {
  const reports = managedOutputPath()
  const scratch = process.env.NERVE_TEST_SCRATCH!
  if (!inside(resource.directory, scratch) || !inside(resource.disk, resource.directory) || !inside(output, reports))
    throw new Error('VM 磁盘、目录和结果必须归属本轮 scratch')
  if (lstatSync(resource.directory).isSymbolicLink() || lstatSync(resource.disk).isSymbolicLink())
    throw new Error('VM 资源不得使用链接')
  if (!lstatSync(resource.disk).isFile())
    throw new Error('VM 磁盘不是本轮普通文件')
}

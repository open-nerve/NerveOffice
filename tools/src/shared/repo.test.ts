import { describe, expect, it } from 'vitest'
import { commandJson, listFiles, packageName, readWorkspaceConfig, workspacePackageDirs } from './repo.ts'

describe('repo', () => {
  it('按 pnpm-workspace.yaml 展开工作区的包，只保留有 package.json 的目录', () => {
    expect(workspacePackageDirs(readWorkspaceConfig())).toEqual(['apps/web', 'packages/contracts', 'tests/e2e', 'tests/integration', 'tools'])
  })

  it('读取默认目录里的精确版本与包名', () => {
    expect(readWorkspaceConfig().catalog.typescript).toMatch(/^\d+\.\d+\.\d+$/)
    expect(packageName('packages/contracts')).toBe('@nerve-office/contracts')
  })

  it('递归列出目录下的文件，目录不存在时返回空数组', () => {
    expect(listFiles('tools/src/git', p => p.endsWith('.ts'))).toContain('tools/src/git/strip-ai-trailers.ts')
    expect(listFiles('no/such/dir', () => true)).toEqual([])
  })

  it('命令退出码不为 0 但输出是 JSON 时照常解析；不是 JSON 时抛出错误', () => {
    expect(commandJson('node', ['-e', 'console.log(JSON.stringify({ ok: 1 })); process.exit(1)'])).toEqual({ ok: 1 })
    expect(() => commandJson('node', ['-e', 'console.log("not json"); process.exit(1)'])).toThrow()
  })
})

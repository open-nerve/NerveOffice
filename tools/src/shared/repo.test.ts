import { describe, expect, it } from 'vitest'
import { listFiles, readWorkspaceConfig, workspacePackageDirs } from './repo.ts'

describe('repo', () => {
  it('按 pnpm-workspace.yaml 展开工作区的包，只保留有 package.json 的目录', () => {
    expect(workspacePackageDirs(readWorkspaceConfig())).toEqual(['apps/web', 'packages/contracts', 'tests/e2e', 'tests/integration', 'tools'])
  })

  it('读取默认目录里的精确版本', () => {
    expect(readWorkspaceConfig().catalog.typescript).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('递归列出目录下的文件，目录不存在时返回空数组', () => {
    expect(listFiles('tools/src/git', p => p.endsWith('.ts'))).toContain('tools/src/git/strip-ai-trailers.ts')
    expect(listFiles('no/such/dir', () => true)).toEqual([])
  })
})

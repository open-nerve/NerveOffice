import { describe, expect, it } from 'vitest'
import { commandJson, commandOutput, listFiles, packageName, readWorkspaceConfig, workspacePackageDirs } from './repo.ts'

describe('repo', () => {
  it('按 pnpm-workspace.yaml 展开工作区的包，只保留有 package.json 的目录', () => {
    expect(workspacePackageDirs(readWorkspaceConfig())).toEqual(['apps/api', 'apps/web', 'packages/contracts', 'tests/e2e', 'tests/integration', 'tools'])
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

describe('commandOutput', () => {
  it('返回标准输出与标准错误', () => {
    expect(commandOutput('node', ['-e', 'console.log("out"); console.error("err")'])).toEqual({ stdout: 'out\n', stderr: 'err\n' })
  })

  it('退出码不为 0：抛出错误，带上退出码与标准错误', () => {
    expect(() => commandOutput('node', ['-e', 'console.error("出错了"); process.exit(3)'])).toThrow(/失败（退出码 3）：出错了/)
  })

  it('被信号结束：说明里写信号，不写"退出码 null"', () => {
    expect(() => commandOutput('node', ['-e', 'process.kill(process.pid, "SIGTERM")'])).toThrow(/被信号 SIGTERM 结束/)
  })

  it('命令无法执行（不存在）：抛出错误，保留原因', () => {
    expect(() => commandOutput('nerve-no-such-command', [])).toThrow(expect.objectContaining({
      message: expect.stringContaining('无法执行') as unknown,
      cause: expect.objectContaining({ code: 'ENOENT' }) as unknown,
    }))
  })
})

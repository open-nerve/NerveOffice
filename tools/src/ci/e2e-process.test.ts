import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { OWNER_VARIABLE, parseProcessStat, prepareRun } from './e2e-process.ts'

describe('CI E2E 的 Linux 内核身份与平台边界', () => {
  it('跨进程归属标记属于配置模块已保留的测试命名空间', () => {
    expect(OWNER_VARIABLE).toMatch(/^NERVE_TEST_[A-Z0-9_]+$/)
  })

  it('comm 含空格和括号时仍读取真正的进程组与启动 tick', () => {
    expect(parseProcessStat('421 (worker (a)) S 400 421 421 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0', 501))
      .toEqual({ pid: 421, parent: 400, group: 421, start: '987654', uid: 501, state: 'S' })
    expect(() => parseProcessStat('broken', 501)).toThrow()
    expect(parseProcessStat('2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0', 0)).toBeUndefined()
  })

  it.each(['R', 'S', 'D', 'T', 't', 'X', 'Z', 'P', 'I'])('Linux 内核状态 %s 仍给出真实身份，tracing stop 不能误判为坏数据或已退出', (state) => {
    expect(parseProcessStat(`421 (browser) ${state} 400 421 421 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0`, 501))
      .toEqual({ pid: 421, parent: 400, group: 421, start: '987654', uid: 501, state })
  })

  it.each(['?', 'tt', 'q'])('未识别或非法的状态 %s 仍拒绝解析', (state) => {
    expect(() => parseProcessStat(`421 (browser) ${state} 400 421 421 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0`, 501)).toThrow()
  })

  if (process.platform === 'linux') {
    it('真实子进程：单次软停止、独立收尾预算、脱离组/父进程、恢复停止与无关进程保护', { timeout: 60_000 }, () => {
      execFileSync(process.execPath, ['--test', new URL('./e2e-process.test-support.ts', import.meta.url).pathname], { stdio: 'pipe', timeout: 55_000 })
    })
  }
  else {
    it('非 Linux 显式拒绝启用监督器；此断言不是 Linux 进程契约通过', () => {
      const root = mkdtempSync(join(tmpdir(), 'nerve-ci-platform-'))
      try {
        expect(() => prepareRun(join(root, 'owner'), root)).toThrow('只支持 Linux')
      }
      finally { rmSync(root, { recursive: true, force: true }) }
    })
  }
})

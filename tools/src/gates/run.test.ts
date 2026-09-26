// 对仓库现状执行不依赖网络与构建产物的门禁（漏洞扫描要联网，产物扫描要先构建，由 verify 与 CI 执行）。
// 这些门禁会执行 pnpm、vitest、playwright 的列举命令，比其他单元测试慢。
import { describe, expect, it } from 'vitest'
import { runGate } from './run.ts'

describe('US-M1-11 门禁对仓库现状通过', () => {
  it.each(['pins', 'config', 'stories', 'deps', 'licenses'] as const)('%s', (name) => {
    const outcome = runGate(name)
    expect(outcome.violations).toEqual([])
    expect(outcome.name).toBe(name)
  })
}, 120_000)

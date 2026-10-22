import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { planSteps } from '../verify/plan.ts'
import { checkReports, ciE2eCommand } from './e2e-command.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

it('本机/容器默认命令不变；CI E2E 只替换执行器，不移除构建或添加测试筛选', () => {
  const options = { ci: true, fast: false, audit: false, scope: 'e2e' as const }
  const steps = planSteps(options)
  expect(steps.map(step => ciE2eCommand(step, options, {}, '/worktree'))).toEqual(steps.map(step => step.command))
  const controlled = steps.map(step => ciE2eCommand(step, options, { CI: 'true', NERVE_CI_E2E_STATE: '/owned/run' }, '/worktree'))
  expect(controlled.slice(0, -1)).toEqual(steps.slice(0, -1).map(step => step.command))
  expect(controlled.at(-1)).toEqual([process.execPath, '/worktree/tools/src/ci/e2e-cli.ts', 'run'])
  expect(() => ciE2eCommand(steps[0]!, { ...options, ci: false }, { NERVE_CI_E2E_STATE: '/owned/run' }, '/worktree')).toThrow()
})

it('缺 JSON/HTML 或执行器结果都真实失败，不能用其他文件替代报告；失败用例报告仍可归档', () => {
  const root = mkdtempSync(join(tmpdir(), 'nerve-ci-reports-'))
  roots.push(root)
  const directory = join(root, 'owner')
  const results = join(root, 'tests/e2e/test-results')
  const html = join(root, 'tests/e2e/playwright-report')
  for (const path of [directory, results, html])
    mkdirSync(path, { recursive: true })
  writeFileSync(join(directory, 'quiescence.json'), JSON.stringify({ quiescent: true, forced: false }))
  expect(() => checkReports(root, directory)).toThrow()
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ exitCode: 1, quiescent: true, forced: false, stopped: false }))
  expect(() => checkReports(root, directory)).toThrow()
  writeFileSync(join(results, 'results.json'), JSON.stringify({ suites: [], errors: [], stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 } }))
  expect(() => checkReports(root, directory)).toThrow()
  writeFileSync(join(html, 'index.html'), '<html>actual report</html>')
  expect(() => checkReports(root, directory)).not.toThrow()
  writeFileSync(join(results, 'results.json'), '{}')
  expect(() => checkReports(root, directory)).toThrow()
  writeFileSync(join(directory, 'quiescence.json'), JSON.stringify({ quiescent: true, forced: true }))
  expect(() => checkReports(root, directory)).toThrow('强制停止')
})

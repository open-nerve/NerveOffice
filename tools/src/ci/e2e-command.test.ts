import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** 真正启动 Python，资源合同的深层反例由 Python 测试负责；这里守住 TS 不能跳过或吞掉核验失败。 */
function resourceChecker(root: string): { script: string, decision: string, called: string } {
  const directory = join(root, 'tools/test-resources')
  mkdirSync(directory, { recursive: true })
  const script = join(directory, 'check_ci_resources.py')
  const decision = join(root, 'resource-check-exit-code.txt')
  const called = join(root, 'resource-check-called.txt')
  writeFileSync(decision, '0')
  writeFileSync(script, [
    'from pathlib import Path',
    'import sys',
    'root = Path(__file__).resolve().parents[2]',
    'assert Path.cwd().resolve() == root',
    'assert len(sys.argv) == 1 and sys.dont_write_bytecode',
    '(root / "resource-check-called.txt").write_text("checked")',
    'raise SystemExit(int((root / "resource-check-exit-code.txt").read_text()))',
    '',
  ].join('\n'))
  return { script, decision, called }
}

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
  const checker = resourceChecker(root)
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
  expect(readFileSync(checker.called, 'utf8')).toBe('checked')
  writeFileSync(join(results, 'results.json'), '{}')
  expect(() => checkReports(root, directory)).toThrow()
  writeFileSync(join(directory, 'quiescence.json'), JSON.stringify({ quiescent: true, forced: true }))
  expect(() => checkReports(root, directory)).toThrow('强制停止')
})

it.each([0, 1])('产品退出码 %s 的 JSON/HTML 完整也不能掩盖资源核验拒绝；核验通过不改写产品结果', (exitCode) => {
  const root = mkdtempSync(join(tmpdir(), 'nerve-ci-resource-check-'))
  roots.push(root)
  const checker = resourceChecker(root)
  const directory = join(root, 'owner')
  const results = join(root, 'tests/e2e/test-results')
  const html = join(root, 'tests/e2e/playwright-report')
  for (const path of [directory, results, html])
    mkdirSync(path, { recursive: true })
  writeFileSync(join(directory, 'quiescence.json'), JSON.stringify({ quiescent: true, forced: false }))
  const result = JSON.stringify({ exitCode, quiescent: true, forced: false, stopped: false })
  writeFileSync(join(directory, 'result.json'), result)
  writeFileSync(join(results, 'results.json'), JSON.stringify({ suites: [], errors: [], stats: { expected: 1, unexpected: exitCode, flaky: 0, skipped: 0 } }))
  writeFileSync(join(html, 'index.html'), '<html>actual report</html>')

  writeFileSync(checker.decision, '17')
  expect(() => checkReports(root, directory)).toThrow()
  expect(readFileSync(checker.called, 'utf8')).toBe('checked')

  writeFileSync(checker.decision, '0')
  expect(() => checkReports(root, directory)).not.toThrow()
  expect(readFileSync(join(directory, 'result.json'), 'utf8')).toBe(result)

  rmSync(checker.script)
  expect(() => checkReports(root, directory)).toThrow()
})

import type { PlanOptions, Step } from '../verify/plan.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'

/** 只有工作流显式准备了本轮目录的 CI E2E 分片替换执行器；计划、用例参数与本机入口不变。 */
export function ciE2eCommand(step: Step, options: PlanOptions, env: NodeJS.ProcessEnv, root: string): readonly string[] {
  if (env.NERVE_CI_E2E_STATE === undefined)
    return step.command
  if (env.CI !== 'true' || !options.ci || options.fast || options.scope !== 'e2e')
    throw new Error('CI E2E 监督目录只能用于 --ci --scope=e2e')
  return step.id === 'e2e' ? [process.execPath, join(root, 'tools/src/ci/e2e-cli.ts'), 'run'] : step.command
}

const count = z.number().int().nonnegative()
const reportSchema = z.object({ suites: z.array(z.unknown()), errors: z.array(z.unknown()), stats: z.object({ expected: count, unexpected: count, flaky: count, skipped: count }) })

/** 缺失/损坏的报告不能被“上传了其他文件”掩盖；失败用例的真实报告仍可以上传。 */
export function checkReports(root: string, directory: string): void {
  const quiescence = z.object({ quiescent: z.literal(true), forced: z.boolean() }).parse(JSON.parse(readFileSync(join(directory, 'quiescence.json'), 'utf8')))
  if (quiescence.forced)
    throw new Error('归档前曾强制停止残留进程，本轮 CI 不能通过')
  z.object({ exitCode: z.number().int(), quiescent: z.literal(true), forced: z.boolean(), stopped: z.boolean() })
    .parse(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')))
  reportSchema.parse(JSON.parse(readFileSync(join(root, 'tests/e2e/test-results/results.json'), 'utf8')))
  const html = statSync(join(root, 'tests/e2e/playwright-report/index.html'))
  if (!html.isFile() || html.size === 0)
    throw new Error('缺少完整的 Playwright HTML 报告')
  // 资源身份、稳定导出和处置状态由同一个 Python 合同核验；产品退出码仍由原执行步骤保留。
  execFileSync('python3', ['-B', join(root, 'tools/test-resources/check_ci_resources.py')], { cwd: root, stdio: 'inherit' })
}

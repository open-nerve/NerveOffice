// 仅工作流 E2E 分片使用；不接收测试筛选/重试/超时参数，照常运行原配置的全部项目。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { REPO_ROOT } from '../shared/repo.ts'
import { checkReports } from './e2e-command.ts'
import { failureStageSchema, processDiagnostic } from './e2e-diagnostics.ts'
import { prepareRun, recordProcessFailure, runOwnedCommand, settleRun, snapshotDiagnostics } from './e2e-process.ts'

async function main(): Promise<number> {
  const directory = process.env.NERVE_CI_E2E_STATE
  if (process.env.CI !== 'true' || directory === undefined || directory === '')
    throw new Error('CI E2E 工具需要 CI=true 与本轮独占目录')
  switch (process.argv[2] ?? '') {
    case 'prepare':
      prepareRun(directory, REPO_ROOT)
      return 0
    case 'run': {
      const cwd = join(REPO_ROOT, 'tests/e2e')
      const require = createRequire(join(cwd, 'package.json'))
      const cli = require.resolve('@playwright/test/cli')
      const result = await runOwnedCommand(directory, REPO_ROOT, 'python3', [join(REPO_ROOT, 'tools/test-resources/run.py'), 'e2e', '--', process.execPath, cli, 'test'], {
        cwd,
        // 与 tests/e2e 的 test 脚本相同，保留调用者已有的 NODE_OPTIONS。
        env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=@nerve-office/source` },
      })
      return result.exitCode
    }
    case 'settle':
      await settleRun(directory, REPO_ROOT)
      execFileSync('python3', [join(REPO_ROOT, 'tools/test-resources/run.py'), '--ci-state', directory, 'recover-ci'], { cwd: REPO_ROOT, stdio: 'inherit' })
      return 0
    case 'reports':
      checkReports(REPO_ROOT, directory)
      return 0
    case 'diagnostics':
      snapshotDiagnostics(directory, REPO_ROOT)
      return 0
    default:
      throw new Error('用法：e2e-cli.ts prepare|run|settle|reports|diagnostics')
  }
}

void main().then(code => process.exit(code)).catch((error: unknown) => {
  const parsed = failureStageSchema.safeParse(process.argv[2])
  const stage = parsed.success ? parsed.data : 'unknown'
  let recorded = false
  try {
    if (process.env.NERVE_CI_E2E_STATE !== undefined) {
      recordProcessFailure(process.env.NERVE_CI_E2E_STATE, REPO_ROOT, stage, error)
      recorded = true
    }
  }
  catch { /* 不能核对目录身份或写记录时仍失败；不输出底层异常正文。 */ }
  console.error(JSON.stringify({ stage, recorded, ...processDiagnostic(error) }))
  console.error('CI E2E 执行/退出核验/报告核验失败；保留本轮监督记录，不宣告通过。')
  process.exit(1)
})

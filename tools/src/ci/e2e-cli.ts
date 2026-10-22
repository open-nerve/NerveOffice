// 仅工作流 E2E 分片使用；不接收测试筛选/重试/超时参数，照常运行原配置的全部项目。
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { REPO_ROOT } from '../shared/repo.ts'
import { checkReports } from './e2e-command.ts'
import { prepareRun, runOwnedCommand, settleRun, snapshotDiagnostics } from './e2e-process.ts'

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
      const result = await runOwnedCommand(directory, REPO_ROOT, process.execPath, [cli, 'test'], {
        cwd,
        // 与 tests/e2e 的 test 脚本相同，保留调用者已有的 NODE_OPTIONS。
        env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=@nerve-office/source` },
      })
      return result.exitCode
    }
    case 'settle':
      await settleRun(directory, REPO_ROOT)
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

void main().then(code => process.exit(code)).catch(() => {
  // 不把第三方异常的参数、环境或 JSON 正文写进日志。具体阶段由命令名与保留的运行记录识别。
  console.error('CI E2E 执行/退出核验/报告核验失败；保留本轮监督记录，不宣告通过。')
  process.exit(1)
})

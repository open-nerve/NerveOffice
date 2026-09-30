// 用法：pnpm verify [--fast] [--audit] [--keep-going]；CI 的分片：pnpm verify --ci [--scope=all|no-e2e|e2e]
// 参数的解析与步骤的编排都是纯函数（plan.ts），这里只负责执行命令与输出结果
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { REPO_ROOT } from '../shared/repo.ts'
import { githubAnnotations } from './github-annotations.ts'
import { parseArgs, planSteps, runSteps, summarize } from './plan.ts'

const parsed = parseArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(parsed.error)
  process.exit(2)
}

const steps = planSteps(parsed.options)
const results = runSteps(steps, (step) => {
  console.log(`\n▶ ${step.id}：${step.command.join(' ')}`)
  const [command = '', ...rest] = step.command
  return spawnSync(command, rest, { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1
}, { keepGoing: parsed.keepGoing, now: () => performance.now() })

const { ok, lines } = summarize(results)
console.log(`\n${ok ? '✔ verify 通过' : '✖ verify 失败'}`)
for (const line of lines)
  console.log(`  ${line}`)
if (process.env.GITHUB_ACTIONS === 'true') {
  for (const annotation of githubAnnotations(results))
    console.log(annotation)
}
process.exit(ok ? 0 : 1)

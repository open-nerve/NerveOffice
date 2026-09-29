// 用法：pnpm verify [--fast] [--ci] [--audit] [--keep-going] [--scope=all|no-e2e|e2e]
// --scope 只给 CI 的分片用（见 plan.ts 的 PlanScope）；本机不用，省略即 all
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { REPO_ROOT } from '../shared/repo.ts'
import { githubAnnotations } from './github-annotations.ts'
import { PLAN_SCOPES, planSteps, runSteps, summarize } from './plan.ts'

const USAGE = '用法：pnpm verify [--fast] [--ci] [--audit] [--keep-going] [--scope=all|no-e2e|e2e]'
const args = new Set(process.argv.slice(2))
const known = new Set(['--fast', '--ci', '--audit', '--keep-going'])
const scopeArgs = [...args].filter(arg => arg.startsWith('--scope='))
const unknown = [...args].filter(arg => !known.has(arg) && !arg.startsWith('--scope='))
if (unknown.length > 0) {
  console.error(`未知的参数：${unknown.join(' ')}。${USAGE}`)
  process.exit(2)
}
const scope = scopeArgs.at(-1)?.slice('--scope='.length) ?? 'all'
if (!PLAN_SCOPES.includes(scope)) {
  console.error(`不认识的分片：${scope}（可选 ${PLAN_SCOPES.join('、')}）。${USAGE}`)
  process.exit(2)
}

const steps = planSteps({ fast: args.has('--fast'), ci: args.has('--ci'), audit: args.has('--audit'), scope })
const results = runSteps(steps, (step) => {
  console.log(`\n▶ ${step.id}：${step.command.join(' ')}`)
  const [command = '', ...rest] = step.command
  return spawnSync(command, rest, { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1
}, { keepGoing: args.has('--keep-going'), now: () => performance.now() })

const { ok, lines } = summarize(results)
console.log(`\n${ok ? '✔ verify 通过' : '✖ verify 失败'}`)
for (const line of lines)
  console.log(`  ${line}`)
if (process.env.GITHUB_ACTIONS === 'true') {
  for (const annotation of githubAnnotations(results))
    console.log(annotation)
}
process.exit(ok ? 0 : 1)

// 用法：pnpm verify [--fast] [--ci] [--audit] [--keep-going]
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { REPO_ROOT } from '../shared/repo.ts'
import { githubAnnotations } from './github-annotations.ts'
import { planSteps, runSteps, summarize } from './plan.ts'

const args = new Set(process.argv.slice(2))
const known = new Set(['--fast', '--ci', '--audit', '--keep-going'])
const unknown = [...args].filter(arg => !known.has(arg))
if (unknown.length > 0) {
  console.error(`未知的参数：${unknown.join(' ')}。用法：pnpm verify [--fast] [--ci] [--audit] [--keep-going]`)
  process.exit(2)
}

const steps = planSteps({ fast: args.has('--fast'), ci: args.has('--ci'), audit: args.has('--audit') })
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

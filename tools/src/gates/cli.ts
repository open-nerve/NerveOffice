// 用法：node tools/src/gates/cli.ts <检查…>，检查名见 GATE_NAMES；不带参数时执行全部。
import type { GateName } from './run.ts'
import process from 'node:process'
import { GATE_NAMES, runGate } from './run.ts'

const requested = process.argv.slice(2)
const unknown = requested.filter(name => !(GATE_NAMES as readonly string[]).includes(name))
if (unknown.length > 0) {
  console.error(`未知的检查：${unknown.join('、')}。可用：${GATE_NAMES.join('、')}`)
  process.exit(2)
}

let failed = false
for (const name of (requested.length > 0 ? requested : GATE_NAMES) as GateName[]) {
  const outcome = runGate(name)
  const status = outcome.violations.length === 0 ? '✔' : '✖'
  console.log(`${status} ${outcome.name}（${outcome.title}）${outcome.violations.length === 0 ? '：通过' : `：${outcome.violations.length} 处违规`}`)
  for (const note of outcome.notes)
    console.log(`    ${note}`)
  for (const v of outcome.violations)
    console.log(`  - [${v.rule}] ${v.subject}：${v.detail}`)
  failed ||= outcome.violations.length > 0
}
process.exit(failed ? 1 : 0)

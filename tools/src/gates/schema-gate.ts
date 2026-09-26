// 表定义与迁移同步（审查 B12）：改了表定义（或 CHECK 约束取值的枚举）却忘了生成迁移时，别的门禁都不报。
// 做法：把迁移目录复制到临时目录，对它执行一次 drizzle-kit generate：
// - 生成了新文件：两者不同步；
// - 没有生成文件，也要 drizzle-kit 明确说"没有变化"且没有写标准错误才算同步。遇到要人工确认的变更（例如改列名）时，
//   它在没有终端的环境里只往标准错误写一行提示，退出码 0、不生成文件（复验 N1）。
import type { CommandOutput } from '../shared/repo.ts'
import type { Violation } from './types.ts'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { commandOutput, REPO_ROOT } from '../shared/repo.ts'
import { MIGRATIONS_DIR } from './migrations.ts'

const API_DIR = join(REPO_ROOT, 'apps/api')
/** drizzle-kit 在表定义与迁移一致时的结论 */
const NO_CHANGES = 'No schema changes'

/** 按表定义往 outDir 生成迁移（drizzle-kit 用 --conditions 读 contracts 的源码，--out 只接受相对路径）。 */
export function generateWithDrizzleKit(outDir: string): CommandOutput {
  return commandOutput('pnpm', ['exec', 'drizzle-kit', 'generate', '--dialect', 'postgresql', '--schema', './src/db/schema/*/index.ts', '--out', relative(API_DIR, outDir)], {
    cwd: API_DIR,
    env: { ...process.env, NODE_OPTIONS: '--conditions=@nerve-office/source' },
  })
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(dir, join(entry.parentPath, entry.name))).sort()
}

export interface SchemaGateResult {
  violations: Violation[]
  notes: string[]
}

export function runSchemaGate(migrationsDir: string, generate: (outDir: string) => CommandOutput = generateWithDrizzleKit): SchemaGateResult {
  const copy = mkdtempSync(join(tmpdir(), 'nerve-schema-'))
  try {
    cpSync(migrationsDir, copy, { recursive: true })
    const before = new Set(listFiles(copy))
    const output = generate(copy)
    const added = listFiles(copy).filter(file => !before.has(file))
    const notes = [`已有 ${[...before].filter(file => file.endsWith('.sql')).length} 个迁移`]
    if (added.length > 0)
      return { violations: [{ rule: 'schema/drift', subject: MIGRATIONS_DIR, detail: `表定义与已有的迁移不一致（按表定义会生成 ${added.join('、')}）：先执行 pnpm db:generate --name <名称>，审阅后提交` }], notes }
    if (!output.stdout.includes(NO_CHANGES) || output.stderr.trim() !== '') {
      // 只取第一行有内容的提示，不带 drizzle-kit 的堆栈
      const said = [output.stderr, output.stdout].flatMap(text => text.split('\n')).map(line => line.trim()).find(line => line !== '') ?? '（没有输出）'
      return { violations: [{ rule: 'schema/unknown', subject: MIGRATIONS_DIR, detail: `drizzle-kit 没有给出"没有变化"的结论，可能有需要人工确认的变更（例如改列名）：${said}。在终端里执行 pnpm db:generate --name <名称> 处理` }], notes }
    }
    return { violations: [], notes }
  }
  finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

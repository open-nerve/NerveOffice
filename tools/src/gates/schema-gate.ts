// 表定义与迁移同步（审查 B12）：改了表定义（或 CHECK 约束取值的枚举）却忘了生成迁移时，别的门禁都不报。
// 做法：把迁移目录复制到临时目录，对它执行一次 drizzle-kit generate；生成了新文件，就说明两者不同步。
import type { Violation } from './types.ts'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import process from 'node:process'
import { commandText, REPO_ROOT } from '../shared/repo.ts'
import { MIGRATIONS_DIR } from './migrations.ts'

const API_DIR = join(REPO_ROOT, 'apps/api')

/** 按表定义往 outDir 生成迁移（drizzle-kit 用 --conditions 读 contracts 的源码，--out 只接受相对路径）。 */
export function generateWithDrizzleKit(outDir: string): void {
  commandText('pnpm', ['exec', 'drizzle-kit', 'generate', '--dialect', 'postgresql', '--schema', './src/db/schema/*/index.ts', '--out', relative(API_DIR, outDir)], {
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

export function runSchemaGate(migrationsDir: string, generate: (outDir: string) => void = generateWithDrizzleKit): SchemaGateResult {
  const copy = mkdtempSync(join(tmpdir(), 'nerve-schema-'))
  try {
    cpSync(migrationsDir, copy, { recursive: true })
    const before = new Set(listFiles(copy))
    generate(copy)
    const added = listFiles(copy).filter(file => !before.has(file))
    const violations: Violation[] = added.length === 0
      ? []
      : [{ rule: 'schema/drift', subject: MIGRATIONS_DIR, detail: `表定义与已有的迁移不一致（按表定义会生成 ${added.join('、')}）：先执行 pnpm db:generate --name <名称>，审阅后提交` }]
    return { violations, notes: [`已有 ${[...before].filter(file => file.endsWith('.sql')).length} 个迁移`] }
  }
  finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

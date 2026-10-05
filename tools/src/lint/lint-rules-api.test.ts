// lint 规则的自测（后端与契约，P2 设计 §3.1）：模块边界、只有仓储访问数据库、仓储只在本模块里用、SQL 只用参数、输入都经校验、
// 环境变量只在 config 模块里读、不取本机的"现在"、几个绕过权限的服务只给指定的模块、契约的请求 id。
// 共用的准备与时限见 lint-harness.test-support.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'
import {
  API_CONFIG,
  API_CONTROLLER,
  API_INTEGRATION_ENTRY,
  API_SERVICE,
  CONTRACTS_FILE,
  INTEGRATION_FILE,
  LINT_TIMEOUT,
  prepareLint,
  restrictedImports,
  restrictedPatterns,
  severity,
} from './lint-harness.test-support.ts'

const { lint, rulesFor, configFor } = prepareLint({ warmUp: [API_CONTROLLER, INTEGRATION_FILE, CONTRACTS_FILE] })

describe('US-M1-11 lint 规则的自测：后端的模块边界', () => {
  it('模块之间只经对方的 index.ts；模块不能引用应用的组装', async () => {
    expect(await rulesFor('import { loadConfig } from \'../config/config.ts\'\nexport const f = loadConfig\n', API_SERVICE)).toContain('boundaries/dependencies')
    expect(await rulesFor('import { loadConfig } from \'../config/index.ts\'\nexport const f = loadConfig\n', API_SERVICE)).not.toContain('boundaries/dependencies')
    expect(await rulesFor('import { createApplication } from \'../../app/index.ts\'\nexport const f = createApplication\n', API_SERVICE)).toContain('boundaries/dependencies')
  })

  it('命令行只经模块的入口，或者 app 层的程序接口（index.ts）', async () => {
    const CLI = 'apps/api/src/cli/migrate.ts'
    expect(await rulesFor('import { initializeAdmin } from \'../app/index.ts\'\nexport const f = initializeAdmin\n', CLI)).not.toContain('boundaries/dependencies')
    expect(await rulesFor('import { runMigrations } from \'../modules/database/index.ts\'\nexport const f = runMigrations\n', CLI)).not.toContain('boundaries/dependencies')
    expect(await rulesFor('import { createApplication } from \'../app/create-application.ts\'\nexport const f = createApplication\n', CLI)).toContain('boundaries/dependencies')
    expect(await rulesFor('import { UsersService } from \'../modules/users/users.service.ts\'\nexport const f = UsersService\n', CLI)).toContain('boundaries/dependencies')
  })

  it('一个模块只能引用自己的表定义：别的模块的表读写不到', async () => {
    const code = 'import { auditEvents } from \'../../db/schema/audit/index.ts\'\nexport const table = auditEvents\n'
    expect(await rulesFor(code, API_SERVICE)).toContain('boundaries/dependencies')
    expect(await rulesFor(code, 'apps/api/src/modules/audit/audit.repository.ts')).not.toContain('boundaries/dependencies')
  })

  it('集成测试只经 @nerve-office/api 的入口引用后端', async () => {
    const code = 'import { loadConfig } from \'../../../../apps/api/src/modules/config/index.ts\'\nexport const f = loadConfig\n'
    expect(await rulesFor(code, INTEGRATION_FILE)).toContain('boundaries/dependencies')
  })

  it('admin 与 workspace 是最上层的编排：只由 app 层组装，别的模块都不引用它们，经 admin 转手的转移同样拦下（M2-P2 复验 N2）', async () => {
    const TOP_LEVEL = '是最上层的编排（ADR-014）'
    expect(await rulesFor('import { AdminModule } from \'../modules/admin/index.ts\'\nimport { WorkspaceModule } from \'../modules/workspace/index.ts\'\n\nexport const modules = [AdminModule, WorkspaceModule]\n', 'apps/api/src/app/app.module.ts')).not.toContain('boundaries/dependencies')
    // 模块自己内部的引用照常
    expect(await rulesFor('import { AdminTransferService } from \'./admin-transfer.service.ts\'\n\nexport const service = AdminTransferService\n', 'apps/api/src/modules/admin/admin.module.ts')).not.toContain('boundaries/dependencies')
    const violations: [string, string][] = [
      ['import { AdminModule } from \'../admin/index.ts\'\n\nexport const module = AdminModule\n', 'apps/api/src/modules/workspace/workspace.module.ts'],
      ['import { WorkspaceModule } from \'../workspace/index.ts\'\n\nexport const module = WorkspaceModule\n', 'apps/api/src/modules/admin/admin.module.ts'],
      ['import type { AdminModule } from \'../admin/index.ts\'\n\nexport type Module = AdminModule\n', 'apps/api/src/modules/documents/documents.service.ts'],
      // admin 转出绕过内容权限的转移，别的模块再从 admin 引用：在这一步拦下
      ['export { DocumentTransferService } from \'../admin/index.ts\'\n', 'apps/api/src/modules/spaces/index.ts'],
      ['import { WorkspaceModule } from \'../workspace/index.ts\'\n\nexport const module = WorkspaceModule\n', 'apps/api/src/modules/users/users.module.ts'],
    ]
    for (const [code, file] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(TOP_LEVEL)
    }
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：只有仓储访问数据库', () => {
  it('只有 database 模块、仓储与表定义能引用 drizzle-orm 与 pg', async () => {
    const code = 'import { sql } from \'drizzle-orm\'\n\nexport const s = sql\n'
    expect(await rulesFor('import pg from \'pg\'\n\nexport const Pool = pg.Pool\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor(code, API_SERVICE)).toContain('no-restricted-imports')
    for (const allowed of ['apps/api/src/modules/audit/audit.repository.ts', 'apps/api/src/modules/database/pool.ts', 'apps/api/src/db/schema/audit/index.ts'])
      expect(await rulesFor(code, allowed), allowed).not.toContain('no-restricted-imports')
  })

  it('documents 与 users 的仓储里一串 id 用 inIdArray，不用 drizzle 的 inArray、notInArray（M2-P6 复核 A 的 S-2，M2-P5 审查 B 的 G6）；别的模块的仓储不受影响', async () => {
    const ID_LISTS_MESSAGE = 'documents 与 users 的仓储里一串 id 用 inIdArray'
    const documentsRepository = 'apps/api/src/modules/documents/folders.repository.ts'
    const violations = [
      'import { inArray } from \'drizzle-orm\'\n\nexport const f = inArray\n',
      'import { notInArray as notIn } from \'drizzle-orm\'\n\nexport const f = notIn\n',
      // 命名空间导入认不出用的是哪个名字，一并拦下；包里的深层路径同样拿得到它们
      'import * as orm from \'drizzle-orm\'\n\nexport const f = orm.inArray\n',
      'import { inArray } from \'drizzle-orm/sql/expressions/conditions\'\n\nexport const f = inArray\n',
      'export { inArray } from \'drizzle-orm\'\n',
    ]
    for (const code of violations) {
      for (const file of [documentsRepository, 'apps/api/src/modules/documents/space-tree.repository.ts', 'apps/api/src/modules/users/users.repository.ts']) {
        const report = await lint(code, file)
        expect(report.rules, `${file}：${code}`).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), `${file}：${code}`).toContain(ID_LISTS_MESSAGE)
      }
    }
    // 同一个仓储里 drizzle-orm 的其余写法照常；别的模块的仓储（id 列表有上限）照样能用 inArray
    expect(await rulesFor('import { and, eq, sql } from \'drizzle-orm\'\n\nexport const f = [and, eq, sql]\n', documentsRepository)).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { inArray } from \'drizzle-orm\'\n\nexport const f = inArray\n', 'apps/api/src/modules/auth/sessions.repository.ts')).not.toContain('no-restricted-imports')
  })

  it('控制器不引用仓储；输入必须带 schema；不用 @Req、@Res', async () => {
    expect(await rulesFor('import { AuditRepository } from \'./audit.repository.ts\'\nexport const r = AuditRepository\n', API_CONTROLLER)).toContain('no-restricted-imports')
    const controller = (parameter: string): string => [
      'import { Body, Controller, Post, Req } from \'@nestjs/common\'',
      'import { z } from \'zod\'',
      '',
      '@Controller(\'x\')',
      'export class XController {',
      '  @Post()',
      `  create(${parameter}): unknown {`,
      '    return z',
      '  }',
      '}',
      '',
    ].join('\n')
    expect(await rulesFor(controller('@Body() body: unknown'), API_CONTROLLER)).toContain('no-restricted-syntax')
    expect(await rulesFor(controller('@Req() request: unknown'), API_CONTROLLER)).toContain('no-restricted-syntax')
    expect(await rulesFor(controller('@Body({ schema: z.object({}) }) body: unknown'), API_CONTROLLER)).not.toContain('no-restricted-syntax')
  })

  it('SQL 只用参数：不用 sql.raw，query()、execute() 的参数不能拼接', async () => {
    const withQuery = (call: string): string => `export async function find(db: { query: (text: string, values?: unknown[]) => Promise<unknown> }, id: string): Promise<unknown> {\n  return ${call}\n}\n`
    expect(await rulesFor(withQuery(`db.query(\`SELECT * FROM t WHERE id = \${id}\`)`), API_SERVICE)).toContain('no-restricted-syntax')
    expect(await rulesFor(withQuery('db.query(\'SELECT * FROM t WHERE id = \' + id)'), API_SERVICE)).toContain('no-restricted-syntax')
    expect(await rulesFor(withQuery('db.query(\'SELECT * FROM t WHERE id = $1\', [id])'), API_SERVICE)).not.toContain('no-restricted-syntax')
    expect(await rulesFor('declare const sql: { raw: (text: string) => unknown }\nexport const s = sql.raw(\'x\')\n', API_SERVICE)).toContain('no-restricted-properties')
    // 解构与别名同样拦下；写成对象的 query({ text }) 也算
    expect(await rulesFor('declare const q: { raw: (text: string) => unknown }\nconst { raw } = q\nexport const s = raw(\'x\')\n', API_SERVICE)).toContain('no-restricted-properties')
    expect(await rulesFor(withQuery(`db.query({ text: \`SELECT * FROM t WHERE id = \${id}\` })`), API_SERVICE)).toContain('no-restricted-syntax')
    // concat() 与 + 一样是拼接（复验 N6）
    expect(await rulesFor(withQuery('db.query(\'SELECT * FROM t WHERE id = \'.concat(id))'), API_SERVICE)).toContain('no-restricted-syntax')
    expect(await rulesFor(withQuery('db.query({ text: \'SELECT * FROM t WHERE id = \'.concat(id) })'), API_SERVICE)).toContain('no-restricted-syntax')
    // 只看第一个参数（SQL 文本）：后面的参数是绑定的值（复验 F5）
    expect(await rulesFor(withQuery('db.query(\'SELECT $1, $2\', [\'a\'].concat([id]))'), API_SERVICE)).not.toContain('no-restricted-syntax')
    expect(await rulesFor(withQuery(`db.query('SELECT $1', \`\${id}\`, 'a' + id)`), API_SERVICE)).not.toContain('no-restricted-syntax')
    expect(await rulesFor(withQuery('db.query({ text: \'SELECT $1\', values: [\'a\'].concat([id]) })'), API_SERVICE)).not.toContain('no-restricted-syntax')
  })

  it('服务拿不到数据库句柄：DATABASE、数据库类型与表定义只有仓储能引用；开事务用 TransactionRunner；不能动态导入数据库的库', async () => {
    expect(await rulesFor('import { DATABASE } from \'../database/index.ts\'\nexport const token = DATABASE\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor('import type { Database } from \'../database/index.ts\'\nexport type D = Database\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { TransactionRunner } from \'../database/index.ts\'\nexport const runner = TransactionRunner\n', API_SERVICE)).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { auditEvents } from \'../../db/schema/audit/index.ts\'\nexport const table = auditEvents\n', 'apps/api/src/modules/audit/audit.service.ts')).toContain('no-restricted-imports')
    const repository = 'import { auditEvents } from \'../../db/schema/audit/index.ts\'\nimport { DATABASE } from \'../database/index.ts\'\n\nexport const used = [auditEvents, DATABASE]\n'
    expect(await rulesFor(repository, 'apps/api/src/modules/audit/audit.repository.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('export async function load(): Promise<unknown> {\n  return import(\'pg\')\n}\n', API_SERVICE)).toContain('no-restricted-syntax')
  })

  it('数据库的库：包本身、子路径与 pg-* 都拦下；名字只是以 pg 开头的包与本地文件不算（复验 N6、F1）', async () => {
    const importOf = (source: string): string => `import value from '${source}'\n\nexport const v = value\n`
    for (const source of ['pg/lib/client', 'pg-pool', 'drizzle-orm/node-postgres'])
      expect(await rulesFor(importOf(source), API_SERVICE), source).toContain('no-restricted-imports')
    for (const source of ['pgx-utils', './pg-errors.ts', '../../shared/pg-codes.ts'])
      expect(await rulesFor(importOf(source), API_SERVICE), source).not.toContain('no-restricted-imports')
  })

  it('后端不用动态导入：受限导入与模块边界都只检查静态引用（复验 F3）', async () => {
    for (const source of ['pg', '../database/index.ts', 'node:events']) {
      const code = `export async function load(): Promise<unknown> {\n  return import('${source}')\n}\n`
      expect(await rulesFor(code, API_SERVICE), source).toContain('no-restricted-syntax')
    }
  })

  it('相对引用写 .ts：写成 .js 同样能解析到源文件，按路径生效的限制却认不出来（复验 F3）', async () => {
    expect(await rulesFor('import { DATABASE } from \'../database/index.js\'\n\nexport const token = DATABASE\n', API_SERVICE)).toContain('no-restricted-imports')
    const report = await lint('import { TransactionRunner } from \'../database/index.js\'\n\nexport const runner = TransactionRunner\n', API_CONTROLLER)
    expect(report.messages.some(message => message.includes('扩展名 .ts'))).toBe(true)
    expect(await rulesFor('import { loadConfig } from \'../config/index.ts\'\n\nexport const f = loadConfig\n', API_SERVICE)).not.toContain('no-restricted-imports')
  })

  it('只有集成测试专用的入口能转出数据库句柄：app 层的程序接口（index.ts）与 app 层的其他文件同样拿不到（复验 N6、M2-P6 复验 R-S4）', async () => {
    const code = 'import { DATABASE } from \'../modules/database/index.ts\'\n\nexport const token = DATABASE\n'
    expect(await rulesFor(code, 'apps/api/src/app/app.module.ts')).toContain('no-restricted-imports')
    expect(await rulesFor('export { DATABASE } from \'../modules/database/index.ts\'\n', 'apps/api/src/app/index.ts')).toContain('no-restricted-imports')
    expect(await rulesFor('export type { Database } from \'../modules/database/index.ts\'\n', 'apps/api/src/app/index.ts')).toContain('no-restricted-imports')
    expect(await rulesFor('export { DATABASE } from \'../modules/database/index.ts\'\nexport type { Database } from \'../modules/database/index.ts\'\n', API_INTEGRATION_ENTRY)).not.toContain('no-restricted-imports')
  })

  it('控制器不自己开事务', async () => {
    expect(await rulesFor('import { TransactionRunner } from \'../database/index.ts\'\nexport const runner = TransactionRunner\n', API_CONTROLLER)).toContain('no-restricted-imports')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：一个模块的仓储只在这个模块里用（规范 §1.2，M2-P6 第 6 片复核 S4）', () => {
  const REPOSITORY_MESSAGE = '一个模块的仓储只在这个模块里使用（规范 §1.2）'

  it('经别的模块的公开入口引用它的仓储都失败：静态导入、import type、命名空间导入、再导出与 export *；app 层的程序接口与其他文件也一样', async () => {
    const importRepository = (name: string, source: string): string => `import { ${name} } from '${source}'\n\nexport const repository = ${name}\n`
    const violations: [string, string][] = [
      // documents 的公开入口确实转出了它的仓储（为集成测试专用的入口），别的模块照样拿不到（M2-P6 复核 A 的 S3）
      [importRepository('DocumentsRepository', '../documents/index.ts'), 'apps/api/src/modules/workspace/space-directory.service.ts'],
      [importRepository('DocumentsRepository', '../documents/index.ts'), 'apps/api/src/modules/admin/admin-transfer.service.ts'],
      [importRepository('DocumentsRepository', '../documents/index.ts'), 'apps/api/src/modules/jobs/trash-purge.job.ts'],
      [importRepository('DocumentsRepository', '../modules/documents/index.ts'), 'apps/api/src/app/app.module.ts'],
      // 别的模块的仓储：哪个模块的公开入口将来转出了它，也一样拦下
      [importRepository('UsersRepository', '../users/index.ts'), 'apps/api/src/modules/admin/admin-users.service.ts'],
      [importRepository('SessionsRepository', '../auth/index.ts'), 'apps/api/src/modules/users/users.service.ts'],
      [importRepository('SpacesRepository', '../spaces/index.ts'), 'apps/api/src/modules/documents/documents.service.ts'],
      ['import type { AuditRepository } from \'../audit/index.ts\'\n\nexport type Repository = AuditRepository\n', 'apps/api/src/modules/admin/admin-audit.service.ts'],
      ['import * as documents from \'../documents/index.ts\'\n\nexport const repository = documents.DocumentsRepository\n', 'apps/api/src/modules/workspace/space-directory.service.ts'],
      ['export { DocumentsRepository } from \'../documents/index.ts\'\n', 'apps/api/src/modules/spaces/index.ts'],
      ['export * from \'../users/index.ts\'\n', 'apps/api/src/modules/admin/index.ts'],
      // app 层的程序接口（index.ts）不转出仓储：命令行与 app 层的其他文件经它转手时，按路径的限制认不出来（复验 R-S4）
      ['export { DocumentsRepository } from \'../modules/documents/index.ts\'\n', 'apps/api/src/app/index.ts'],
      [importRepository('UsersRepository', '../modules/users/index.ts'), 'apps/api/src/cli/migrate.ts'],
    ]
    for (const [code, file] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('no-restricted-imports')
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(REPOSITORY_MESSAGE)
    }
  })

  it('模块自己的文件经相对路径引用自己的仓储照常；集成测试专用的入口可以转出 documents 的仓储；公开入口里的其他符号照常引用', async () => {
    expect(await rulesFor('import { DocumentsRepository } from \'./documents.repository.ts\'\n\nexport const repository = DocumentsRepository\n', 'apps/api/src/modules/documents/document-search.service.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { UsersRepository } from \'./users.repository.ts\'\n\nexport const repository = UsersRepository\n', 'apps/api/src/modules/users/users.service.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('export { DocumentsRepository } from \'../modules/documents/index.ts\'\n', API_INTEGRATION_ENTRY)).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { UsersService } from \'../users/index.ts\'\n\nexport const service = UsersService\n', 'apps/api/src/modules/admin/admin-users.service.ts')).not.toContain('no-restricted-imports')
    // 仓储文件里的类型（例如审计的记录）经公开入口照常引用：限制只认以 Repository 结尾的名字
    expect(await rulesFor('import type { AuditRecord } from \'../audit/index.ts\'\n\nexport type Row = AuditRecord\n', 'apps/api/src/modules/admin/admin-audit.service.ts')).not.toContain('no-restricted-imports')
  })

  it('按名字认仓储，所以每个 *.repository.ts 导出的类都以 Repository 结尾', () => {
    const modules = join(REPO_ROOT, 'apps/api/src/modules')
    const files = readdirSync(modules, { recursive: true, encoding: 'utf8' }).filter(path => path.endsWith('.repository.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const classes = [...readFileSync(join(modules, file), 'utf8').matchAll(/^export (?:abstract )?class (\w+)/gm)].map(match => match[1] ?? '')
      expect(classes, file).not.toEqual([])
      for (const name of classes)
        expect(name, file).toMatch(/Repository$/)
    }
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：后端不取本机的"现在"，与时间有关的判断用数据库时间（规范 §5，M2-P6 第 6 片复核 S5）', () => {
  const WALL_CLOCK_MESSAGE = '后端不取本机的"现在"'
  const CASES = [
    'export const now = Date.now()\n',
    'export const now = new Date()\n',
    'export const now = String(Date())\n',
    'export function expired(at: Date): boolean {\n  return at.getTime() <= Date.now()\n}\n',
  ]

  it.each([API_SERVICE, API_CONTROLLER, 'apps/api/src/modules/documents/trash.service.ts', 'apps/api/src/modules/jobs/job-scheduler.ts', 'apps/api/src/modules/database/database-time.ts', 'apps/api/src/app/validation.test.ts'])('%s', async (file) => {
    for (const code of CASES) {
      const report = await lint(code, file)
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(WALL_CLOCK_MESSAGE)
    }
  })

  it('带参数的 new Date(…) 照常；进程自己的计时按文件放行（关停的时限、就绪检查结果的缓存），其余的限制照旧', async () => {
    expect((await lint('export const at = new Date(\'2026-10-02T00:00:00Z\')\n', API_SERVICE)).messages.join('\n')).not.toContain(WALL_CLOCK_MESSAGE)
    for (const file of ['apps/api/src/app/shutdown.ts', 'apps/api/src/modules/database/database-readiness.ts']) {
      expect((await lint('export const now = Date.now()\n', file)).messages.join('\n'), file).not.toContain(WALL_CLOCK_MESSAGE)
      expect(await rulesFor('export async function load(): Promise<unknown> {\n  return import(\'node:events\')\n}\n', file), file).toContain('no-restricted-syntax')
    }
    // database 模块里的文件仍然可以引用数据库的库（放行只放开时钟）
    expect(await rulesFor('import { sql } from \'drizzle-orm\'\n\nexport const s = sql\n', 'apps/api/src/modules/database/database-readiness.ts')).not.toContain('no-restricted-imports')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：配置与输入', () => {
  it('只有 config 模块读取 process.env', async () => {
    const code = 'import process from \'node:process\'\n\nexport const url = process.env.NERVE_DATABASE_URL\n'
    expect(await rulesFor(code, API_SERVICE)).toContain('node/no-process-env')
    expect(severity((await configFor(API_CONFIG)).rules?.['node/no-process-env'])).toBe(0)
  })

  it('环境变量的其他读法同样只能在 config 模块里：import { env }、解构、globalThis.process.env', async () => {
    expect(await rulesFor('import { env } from \'node:process\'\n\nexport const url = env.NERVE_DATABASE_URL\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor('import process from \'node:process\'\n\nconst { env } = process\nexport const url = env.NERVE_DATABASE_URL\n', API_SERVICE)).toContain('no-restricted-syntax')
    expect(await rulesFor('export const url = globalThis.process.env.NERVE_DATABASE_URL\n', API_SERVICE)).toContain('no-restricted-syntax')
    // 给 process 改名或用命名空间引用：node/no-process-env 认不出来，这里拦下（复验 N6）
    expect(await rulesFor('import proc from \'node:process\'\n\nexport const url = proc.env.NERVE_DATABASE_URL\n', API_SERVICE)).toContain('no-restricted-syntax')
    expect(await rulesFor('import * as proc from \'node:process\'\n\nexport const url = proc.env.NERVE_DATABASE_URL\n', API_SERVICE)).toContain('no-restricted-syntax')
    expect(await rulesFor('import process from \'node:process\'\n\nexport const pid = process.pid\n', API_SERVICE)).toEqual([])
  })

  it('控制器只写在 *.controller.ts 里；参数的限制对所有后端文件生效；不用 @Headers 等不经校验的装饰器', async () => {
    const controllerIn = (parameter: string): string => [
      'import { Body, Controller, Headers, Post } from \'@nestjs/common\'',
      '',
      '@Controller(\'x\')',
      'export class XController {',
      '  @Post()',
      `  create(${parameter}): unknown {`,
      '    return Headers',
      '  }',
      '}',
      '',
      'export const unused = Body',
      '',
    ].join('\n')
    const inService = await lint(controllerIn('@Body() body: unknown'), API_SERVICE)
    expect(inService.messages.filter(message => message.includes('*.controller.ts'))).toHaveLength(1)
    expect(inService.messages.filter(message => message.includes('必须带 schema'))).toHaveLength(1)
    expect(await rulesFor(controllerIn('@Headers(\'if-match\') header: string'), API_CONTROLLER)).toContain('no-restricted-syntax')
  })

  it('不经校验的装饰器在引用处就拦下，改名也拦得住；上传文件的装饰器同样不用（复验 N6）', async () => {
    const aliased = [
      'import { Controller, Post, Req as R } from \'@nestjs/common\'',
      '',
      '@Controller(\'x\')',
      'export class XController {',
      '  @Post()',
      '  create(@R() request: unknown): unknown {',
      '    return request',
      '  }',
      '}',
      '',
    ].join('\n')
    const report = await lint(aliased, API_CONTROLLER)
    expect(report.rules).toContain('no-restricted-imports')
    expect(report.messages.some(message => message.includes('不经校验的参数装饰器'))).toBe(true)
    expect(await rulesFor('import { UploadedFile } from \'@nestjs/common\'\n\nexport const decorator = UploadedFile\n', API_SERVICE)).toContain('no-restricted-imports')
    // 包里的深层路径同样拦下，Logger 也一样（复验 F2）
    expect(await rulesFor('import { Req as R } from \'@nestjs/common/decorators/http/route-params.decorator.js\'\n\nexport const decorator = R\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { Logger } from \'@nestjs/common/services/logger.service.js\'\n\nexport const logger = Logger\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor('import * as common from \'@nestjs/common\'\n\nexport const decorator = common.Req\n', API_SERVICE)).toContain('no-restricted-imports')
    // 从别处引来的同名装饰器：按写法拦下
    const uploaded = [
      'import { Controller, Post } from \'@nestjs/common\'',
      '',
      'declare function UploadedFile(): ParameterDecorator',
      '',
      '@Controller(\'x\')',
      'export class XController {',
      '  @Post()',
      '  create(@UploadedFile() file: unknown): unknown {',
      '    return file',
      '  }',
      '}',
      '',
    ].join('\n')
    expect(await rulesFor(uploaded, API_CONTROLLER)).toContain('no-restricted-syntax')
  })

  it('每类后端文件都仍然禁止 Univer、Pro、Nest 的 Logger 与不经校验的装饰器（各覆盖块由同一个函数组合，审查 B15）', async () => {
    const files = [
      API_SERVICE,
      API_CONTROLLER,
      API_CONFIG,
      'apps/api/src/modules/audit/audit.repository.ts',
      'apps/api/src/modules/database/pool.ts',
      'apps/api/src/db/schema/audit/index.ts',
      'apps/api/src/app/index.ts',
      API_INTEGRATION_ENTRY,
      'apps/api/src/cli/migrate.ts',
      // 按文件放行本机时钟的两块（M2-P6 第 6 片复核 S5）
      'apps/api/src/app/shutdown.ts',
      'apps/api/src/modules/database/database-readiness.ts',
    ]
    for (const file of files) {
      const config = await configFor(file)
      expect(restrictedPatterns(config), file).toEqual(expect.arrayContaining(['@univerjs/*', '@univerjs-pro/*']))
      expect(restrictedImports(config).paths?.some(path => path.name === '@nestjs/common' && path.importNames?.includes('Logger')), file).toBe(true)
      expect(restrictedImports(config).paths?.some(path => path.name === '@nestjs/common' && path.importNames?.includes('Req')), file).toBe(true)
    }
  })

  it('应用代码不用 Nest 的 Logger（进程级的静态实例），经依赖注入使用 AppLogger', async () => {
    expect(await rulesFor('import { Logger } from \'@nestjs/common\'\n\nexport const logger = new Logger(\'x\')\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { Injectable } from \'@nestjs/common\'\n\nexport const decorator = Injectable\n', API_SERVICE)).not.toContain('no-restricted-imports')
  })

  it('依赖注入要用的类不会被要求改成 import type（开启 emitDecoratorMetadata 时 typescript-eslint 会跳过）', async () => {
    const code = [
      'import { Controller } from \'@nestjs/common\'',
      'import { ApplicationState } from \'./application-state.ts\'',
      '',
      '@Controller(\'x\')',
      'export class XController {',
      '  constructor(private readonly state: ApplicationState) {}',
      '}',
      '',
    ].join('\n')
    expect(await rulesFor(code, API_CONTROLLER)).not.toContain('ts/consistent-type-imports')
  })

  it('契约的请求结构（z.strictObject）与路径里的 id（*IdSchema）用 uuidSchema，不直接用 z.uuid()；响应结构照常（M2-P2 审查 A1、复验 N3）', async () => {
    const UUID_MESSAGE = '请求里的 UUID 用 uuidSchema'
    const fine = [
      'import { z } from \'zod\'\n\nexport const response = z.object({ id: z.uuid(), items: z.array(z.object({ id: z.uuid() })) })\n',
      'import { z } from \'zod\'\nimport { uuidSchema } from \'../ids/ids.ts\'\n\nexport const request = z.strictObject({ userId: uuidSchema, ids: z.array(uuidSchema) })\nexport const thingIdSchema = uuidSchema\n',
    ]
    for (const code of fine)
      expect(await rulesFor(code, CONTRACTS_FILE), code).not.toContain('no-restricted-syntax')
    const violations = [
      'import { z } from \'zod\'\n\nexport const request = z.strictObject({ userId: z.uuid() })\n',
      'import { z } from \'zod\'\n\nexport const request = z.strictObject({ ids: z.array(z.uuid()).min(1) })\n',
      'import { z } from \'zod\'\n\nexport const request = z.strictObject({ target: z.discriminatedUnion(\'type\', [z.strictObject({ type: z.literal(\'a\'), id: z.uuid().optional() })]) })\n',
      'import { z } from \'zod\'\n\nexport const thingIdSchema = z.uuid()\n',
    ]
    for (const code of violations) {
      const report = await lint(code, CONTRACTS_FILE)
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(UUID_MESSAGE)
    }
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：绕过权限的服务只给指定的模块', () => {
  it('停用者文档的转移（DocumentTransferService）只由管理界面的模块引用：别的模块、应用层引用都失败，documents 模块自己不受影响（M2-P2 审查 A9）', async () => {
    const TRANSFER_MESSAGE = '停用者文档的转移（DocumentTransferService）不经内容权限，只由管理界面的模块（modules/admin）调用'
    const importTransfer = 'import { DocumentTransferService } from \'../documents/index.ts\'\n\nexport const service = DocumentTransferService\n'
    expect(await rulesFor(importTransfer, 'apps/api/src/modules/admin/admin-transfer.service.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { DocumentTransferService } from \'./document-transfer.service.ts\'\n\nexport const service = DocumentTransferService\n', 'apps/api/src/modules/documents/documents.module.ts')).not.toContain('no-restricted-imports')
    // 同一个公开入口里的其他符号照常引用
    expect(await rulesFor('import { DocumentAccessPolicy } from \'../documents/index.ts\'\n\nexport const policy = DocumentAccessPolicy\n', 'apps/api/src/modules/workspace/space-membership.service.ts')).not.toContain('no-restricted-imports')
    const violations: [string, string][] = [
      [importTransfer, 'apps/api/src/modules/workspace/space-membership.service.ts'],
      [importTransfer, 'apps/api/src/modules/workspace/spaces.controller.ts'],
      ['import type { DocumentTransferService } from \'../documents/index.ts\'\n\nexport type Service = DocumentTransferService\n', 'apps/api/src/modules/workspace/space-membership.service.ts'],
      ['import * as documents from \'../documents/index.ts\'\n\nexport const service = documents.DocumentTransferService\n', 'apps/api/src/modules/workspace/space-membership.service.ts'],
      ['export { DocumentTransferService } from \'../documents/index.ts\'\n', 'apps/api/src/modules/spaces/index.ts'],
      ['import { DocumentTransferService } from \'../modules/documents/index.ts\'\n\nexport const service = DocumentTransferService\n', 'apps/api/src/app/app.module.ts'],
    ]
    for (const [code, file] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('no-restricted-imports')
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(TRANSFER_MESSAGE)
    }
  })

  it('不判断权限的回收站清理只在 documents 与 jobs 里：TrashPurgeService 只给 jobs，删除单元的本体 TrashEntryPurger 谁都拿不到（M2-P6 复核 A 的 G1）', async () => {
    const PURGE_MESSAGE = '到期的回收站清理（TrashPurgeService）不判断人的权限'
    const PURGER_MESSAGE = '永久删除一个删除单元的本体（TrashEntryPurger）不判断权限'
    const importPurge = 'import { TrashPurgeService } from \'../documents/index.ts\'\n\nexport const service = TrashPurgeService\n'
    const importPurger = 'import { TrashEntryPurger } from \'../documents/index.ts\'\n\nexport const purger = TrashEntryPurger\n'
    // jobs 经公开入口引用到期的清理；documents 模块自己经相对路径引用本体
    expect(await rulesFor(importPurge, 'apps/api/src/modules/jobs/trash-purge.job.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { TrashEntryPurger } from \'./trash-entry-purger.ts\'\n\nexport const purger = TrashEntryPurger\n', 'apps/api/src/modules/documents/trash.service.ts')).not.toContain('no-restricted-imports')
    // 同一个公开入口里的 TrashService（它上面没有不判断权限就能永久删除的方法）照常引用
    expect(await rulesFor('import { TrashService } from \'../documents/index.ts\'\n\nexport const service = TrashService\n', 'apps/api/src/modules/workspace/trash.controller.ts')).not.toContain('no-restricted-imports')
    const violations: [string, string, string, string][] = [
      [importPurge, 'apps/api/src/modules/workspace/trash-directory.service.ts', 'no-restricted-imports', PURGE_MESSAGE],
      [importPurger, 'apps/api/src/modules/workspace/trash-directory.service.ts', 'no-restricted-imports', PURGER_MESSAGE],
      // jobs 也只经 TrashPurgeService，拿不到本体
      [importPurger, 'apps/api/src/modules/jobs/trash-purge.job.ts', 'no-restricted-imports', PURGER_MESSAGE],
      ['import type { TrashEntryPurger } from \'../documents/index.ts\'\n\nexport type Purger = TrashEntryPurger\n', 'apps/api/src/modules/admin/admin-spaces.service.ts', 'no-restricted-imports', PURGER_MESSAGE],
      ['export { TrashEntryPurger } from \'../modules/documents/index.ts\'\n', 'apps/api/src/app/index.ts', 'no-restricted-imports', PURGER_MESSAGE],
      ['export { TrashEntryPurger } from \'../modules/documents/index.ts\'\n', API_INTEGRATION_ENTRY, 'no-restricted-imports', PURGER_MESSAGE],
      // 不经公开入口、直接引用它的文件：模块边界拦下
      ['import { TrashEntryPurger } from \'../documents/trash-entry-purger.ts\'\n\nexport const purger = TrashEntryPurger\n', 'apps/api/src/modules/workspace/trash-directory.service.ts', 'boundaries/dependencies', ''],
      ['import { TrashEntryPurger } from \'../documents/trash-entry-purger.ts\'\n\nexport const purger = TrashEntryPurger\n', 'apps/api/src/modules/jobs/trash-purge.job.ts', 'boundaries/dependencies', ''],
    ]
    for (const [code, file, rule, message] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain(rule)
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(message)
    }
  })

  it('修订记录与回执的保留期清理（RevisionPurgeService）只给 jobs：别的模块、app 层与集成测试专用的入口引用都失败，documents 模块自己不受影响（M3-P3 设计 §3.9）', async () => {
    const RETENTION_MESSAGE = '修订记录与回执的保留期清理（RevisionPurgeService）不判断人的权限'
    const importRetention = 'import { RevisionPurgeService } from \'../documents/index.ts\'\n\nexport const service = RevisionPurgeService\n'
    // jobs 经公开入口引用；documents 模块自己经相对路径引用
    expect(await rulesFor(importRetention, 'apps/api/src/modules/jobs/revision-purge.job.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { RevisionPurgeService } from \'./revision-purge.service.ts\'\n\nexport const service = RevisionPurgeService\n', 'apps/api/src/modules/documents/documents.module.ts')).not.toContain('no-restricted-imports')
    // 同一个公开入口里的类型照常引用（它只是一批的结果）
    expect(await rulesFor('import type { PurgedRecords } from \'../documents/index.ts\'\n\nexport type Batch = PurgedRecords\n', 'apps/api/src/modules/workspace/trash-directory.service.ts')).not.toContain('no-restricted-imports')
    const violations: [string, string][] = [
      [importRetention, 'apps/api/src/modules/workspace/trash-directory.service.ts'],
      [importRetention, 'apps/api/src/modules/admin/admin-spaces.service.ts'],
      ['import type { RevisionPurgeService } from \'../documents/index.ts\'\n\nexport type Service = RevisionPurgeService\n', 'apps/api/src/modules/workspace/space-membership.service.ts'],
      ['import * as documents from \'../documents/index.ts\'\n\nexport const service = documents.RevisionPurgeService\n', 'apps/api/src/modules/workspace/space-membership.service.ts'],
      ['export { RevisionPurgeService } from \'../modules/documents/index.ts\'\n', 'apps/api/src/app/index.ts'],
      ['export { RevisionPurgeService } from \'../modules/documents/index.ts\'\n', API_INTEGRATION_ENTRY],
    ]
    for (const [code, file] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('no-restricted-imports')
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(RETENTION_MESSAGE)
    }
  })

  it('集成测试专用的入口（@nerve-office/api/testing）只给 tests/integration：命令行、app 层的程序接口与其他文件、各模块、单元测试引用都失败（M2-P6 复验 R-S4）', async () => {
    const ENTRY_MESSAGE = '集成测试专用的入口（app/integration.test-support.ts）只给 tests/integration'
    const fromTests = await lint('import { DATABASE, DocumentsRepository } from \'@nerve-office/api/testing\'\n\nexport const used = [DATABASE, DocumentsRepository]\n', INTEGRATION_FILE)
    expect(fromTests.rules).toEqual([])
    const importEntry = (source: string): string => `import { DATABASE, DocumentsRepository } from '${source}'\n\nexport const used = [DATABASE, DocumentsRepository]\n`
    const violations: [string, string, readonly string[]][] = [
      // 命令行：相对路径与包名的出口都拦下；模块边界同样不许命令行引用 app 层的其他文件
      [importEntry('../app/integration.test-support.ts'), 'apps/api/src/cli/migrate.ts', ['import-x/no-restricted-paths', 'boundaries/dependencies']],
      [importEntry('@nerve-office/api/testing'), 'apps/api/src/cli/reset-link.ts', ['import-x/no-restricted-paths', 'boundaries/dependencies']],
      // app 层的其他文件与进程入口：同一个元素里模块边界不管，按解析之后的路径拦下
      [importEntry('./integration.test-support.ts'), 'apps/api/src/app/app.module.ts', ['import-x/no-restricted-paths']],
      [importEntry('@nerve-office/api/testing'), 'apps/api/src/app/main.ts', ['import-x/no-restricted-paths']],
      // app 层的程序接口转手它（再导出）
      ['export { DATABASE, DocumentsRepository } from \'./integration.test-support.ts\'\n', 'apps/api/src/app/index.ts', ['import-x/no-restricted-paths']],
      // 单元测试：测试辅助的限制只管生产代码，这条规则照样拦下
      [importEntry('./integration.test-support.ts'), 'apps/api/src/app/validation.test.ts', ['import-x/no-restricted-paths']],
      // 各模块
      [importEntry('../../app/integration.test-support.ts'), API_SERVICE, ['import-x/no-restricted-paths', 'boundaries/dependencies']],
      [importEntry('../../app/integration.test-support.ts'), 'apps/api/src/modules/documents/trash.service.ts', ['import-x/no-restricted-paths', 'boundaries/dependencies']],
    ]
    for (const [code, file, rules] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toEqual(expect.arrayContaining([...rules]))
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(ENTRY_MESSAGE)
    }
    // 它为集成测试转出全部的表定义（迁移与表定义逐项核对，M2-P6 复核 B 的 B4）；app 层的其他文件照旧引用不到表定义
    const importTables = 'import { auditEvents } from \'../db/schema/audit/index.ts\'\nimport { folders } from \'../db/schema/documents/index.ts\'\n\nexport const tables = [auditEvents, folders]\n'
    expect(await rulesFor(importTables, API_INTEGRATION_ENTRY)).not.toContain('boundaries/dependencies')
    expect(await rulesFor(importTables, 'apps/api/src/app/app.module.ts')).toContain('boundaries/dependencies')
  })
}, LINT_TIMEOUT)

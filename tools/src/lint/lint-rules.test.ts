// 规范里标为【自动】的 lint 规则真的生效：对违规的代码执行 ESLint，确认报出对应的规则；
// 按路径生效的规则，再用 ESLint 为该路径计算出的配置来确认。
// 类型感知的解析只接受 tsconfig 里真实存在的文件，所以 lintText 借用仓库里已有的文件路径；
// 需要"被引用的目标"时，临时创建探针文件（已加入 .gitignore），用完删除。
import type { Linter } from 'eslint'
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../shared/repo.ts'

const PROBE = `lint-probe-${process.pid}`
const PROBE_FILES = {
  // 编辑器里的文件（任何一个都不应被平台入口引用）
  editor: `apps/web/src/editor/${PROBE}/editor-part.ts`,
  // 不属于任何元素的"无主"文件：借它中转就能绕过边界
  stray: `apps/web/src/${PROBE}.ts`,
  // 编辑器页的入口与编辑器页（sheet-editor 功能）里的文件：作为"从这里引用"的位置（P4 设计 §3.1）
  editorEntry: `apps/web/src/entries/editor/${PROBE}.ts`,
  sheetEditor: `apps/web/src/features/sheet-editor/${PROBE}.ts`,
  // 编辑器页里被引用的文件
  sheetEditorPart: `apps/web/src/features/sheet-editor/${PROBE}-part.ts`,
}

const WEB_FILE = 'apps/web/src/app/app.tsx'
const WEB_TEST_FILE = 'apps/web/src/app/app.test.tsx'
const WEB_TEST_SUPPORT = 'apps/web/src/app/render-app.test-support.tsx'
const WEB_SHARED_FILE = 'apps/web/src/shared/lib/format.ts'
const WEB_FEATURE_FILE = 'apps/web/src/features/auth/session.ts'
const PLATFORM_ENTRY = 'apps/web/src/entries/platform/main.tsx'
const CONTRACTS_FILE = 'packages/contracts/src/errors/error-response.ts'
const TOOLS_TEST_FILE = 'tools/src/git/strip-ai-trailers.test.ts'
const E2E_FILE = 'tests/e2e/specs/foundation/framework-smoke.spec.ts'
const API_CONTROLLER = 'apps/api/src/modules/health/health.controller.ts'
const API_SERVICE = 'apps/api/src/modules/health/application-state.ts'
const API_CONFIG = 'apps/api/src/modules/config/config.ts'
const INTEGRATION_FILE = 'tests/integration/src/support/api-app.ts'

// 类型感知的 lint 第一次运行时，要加载整份配置，并为每个 tsconfig 工程建立类型程序；
// 这是整组用例共用的准备工作，放在 beforeAll 里做完，不算进某一个用例的时限。
// 本组用到的每个工程各检查一个真实文件，之后的用例只做增量检查。
const WARM_UP_FILES = [WEB_FILE, CONTRACTS_FILE, TOOLS_TEST_FILE, E2E_FILE, API_CONTROLLER, INTEGRATION_FILE]
// 冷启动在 CI 的 4 核机器上还要和并行的测试文件抢 CPU，本机约 3 秒，这里留足余量
const WARM_UP_TIMEOUT = 120_000
// 预热之后，一个用例最多检查五段代码，本机合计不到 0.2 秒；CI 上按慢几十倍留余量
const LINT_TIMEOUT = 20_000

let eslint: ESLint
/**
 * 不按忽略规则跳过的实例：探针文件在 .gitignore 里，普通的实例不检查它们。
 * 编辑器页的入口与 sheet-editor 功能在 P4 的 S3 之前还没有真实的文件，"从这里引用"的规则只能借探针的位置检查
 */
let eslintOnProbes: ESLint
/** 为探针新建的目录，由深到浅。清理时只删空目录，不递归删除，免得删掉同一时间别人写进去的文件。 */
const createdDirs: string[] = []

beforeAll(async () => {
  for (const path of Object.values(PROBE_FILES)) {
    const dir = join(REPO_ROOT, dirname(path))
    const firstCreated = mkdirSync(dir, { recursive: true })
    if (firstCreated !== undefined) {
      for (let current = dir; current.startsWith(firstCreated); current = dirname(current))
        createdDirs.push(current)
    }
    writeFileSync(join(REPO_ROOT, path), 'export const probe = 1\n')
  }
  eslint = new ESLint({ cwd: REPO_ROOT })
  eslintOnProbes = new ESLint({ cwd: REPO_ROOT, ignore: false })
  await Promise.all([
    eslint.lintFiles(WARM_UP_FILES.map(file => join(REPO_ROOT, file))),
    eslintOnProbes.lintFiles([join(REPO_ROOT, PROBE_FILES.sheetEditor)]),
  ])
}, WARM_UP_TIMEOUT)

afterAll(() => {
  for (const path of Object.values(PROBE_FILES))
    rmSync(join(REPO_ROOT, path), { force: true })
  for (const dir of createdDirs) {
    try {
      rmdirSync(dir)
    }
    catch (error) {
      // 目录里还有别的文件（ENOTEMPTY）或已经不在（ENOENT）时放过
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT')
        throw error
    }
  }
})

interface Report { rules: string[], messages: string[] }

async function lint(code: string, filePath: string): Promise<Report> {
  const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, filePath) })
  const messages = result?.messages ?? []
  return { rules: messages.map(m => m.ruleId ?? `解析失败：${m.message}`), messages: messages.map(m => m.message) }
}

async function rulesFor(code: string, filePath: string): Promise<string[]> {
  return (await lint(code, filePath)).rules
}

/** 把代码放在探针文件的位置检查（探针在 .gitignore 里，用不跳过忽略规则的实例） */
async function lintAtProbe(code: string, probePath: string): Promise<Report> {
  const [result] = await eslintOnProbes.lintText(code, { filePath: join(REPO_ROOT, probePath) })
  const messages = result?.messages ?? []
  return { rules: messages.map(m => m.ruleId ?? `解析失败：${m.message}`), messages: messages.map(m => m.message) }
}

async function configFor(filePath: string): Promise<Linter.Config> {
  return await eslint.calculateConfigForFile(join(REPO_ROOT, filePath)) as Linter.Config
}

function severity(entry: Linter.RuleEntry | undefined): unknown {
  return Array.isArray(entry) ? entry[0] : entry
}

interface RestrictedImports {
  paths?: { name: string, importNames?: string[] }[]
  patterns?: { group?: string[], regex?: string }[]
}

function restrictedImports(config: Linter.Config): RestrictedImports {
  const entry = config.rules?.['no-restricted-imports']
  return Array.isArray(entry) ? entry[1] as RestrictedImports : {}
}

/** 受限导入的模式：group 里的每一项与 regex。 */
function restrictedPatterns(config: Linter.Config): string[] {
  return (restrictedImports(config).patterns ?? []).flatMap(p => [...(p.group ?? []), ...(p.regex === undefined ? [] : [p.regex])])
}

describe('US-M1-11 lint 规则的自测：受限导入', () => {
  it('编辑器之外引用 @univerjs/* 或 Pro 会失败，静态导入、再导出与动态导入都算', async () => {
    expect(await rulesFor('import { Univer } from \'@univerjs/core\'\nexport const u = Univer\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('export * from \'@univerjs/core\'\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('import { x } from \'@univerjs-pro/license\'\nexport const y = x\n', WEB_FILE)).toContain('no-restricted-imports')
    expect(await rulesFor('export async function load() {\n  return import(\'@univerjs/core\')\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
    expect(await rulesFor('export async function load() {\n  return import(\'@univerjs-pro/license\')\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
  })

  it('动态导入的路径必须是字面量', async () => {
    expect(await rulesFor('export async function load(name: string) {\n  return import(name)\n}\n', WEB_FILE)).toContain('no-restricted-syntax')
  })

  it('编辑器适配层可以引用 @univerjs/*，但不能引用 Pro', async () => {
    // 按路径计算配置不需要文件存在；探针文件在 .gitignore 里，ESLint 会忽略它们，所以这里用普通路径
    const editor = await configFor('apps/web/src/editor/adapter.ts')
    expect(restrictedPatterns(editor)).toContain('@univerjs-pro/*')
    expect(restrictedPatterns(editor)).not.toContain('@univerjs/*')
    expect(restrictedPatterns(await configFor(WEB_FILE))).toContain('@univerjs/*')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：模块边界与循环依赖', () => {
  it('跨越模块边界的引用会失败（平台代码引用仓库工具）', async () => {
    const code = 'import { stripAiTrailers } from \'../../../../tools/src/git/strip-ai-trailers.ts\'\nexport const f = stripAiTrailers\n'
    expect(await rulesFor(code, WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('平台页面的入口不能引用编辑器', async () => {
    const report = await lint(`import { probe } from '../../editor/${PROBE}/editor-part.ts'\nexport const p = probe\n`, PLATFORM_ENTRY)
    expect(report.rules).toContain('boundaries/dependencies')
    expect(report.messages.join('\n')).toContain('平台页面的入口不得引用编辑器')
  })

  it('应用的入口只写副作用导入，第一个是 zod-jitless（ADR-008，审查 B1）', async () => {
    const valid = 'import \'../../shared/lib/zod-jitless.ts\'\nimport \'../../app/styles.css\'\nimport \'./mount.tsx\'\n'
    expect(await rulesFor(valid, PLATFORM_ENTRY)).toEqual([])
    const wrongOrder = 'import \'../../app/styles.css\'\nimport \'../../shared/lib/zod-jitless.ts\'\nimport \'./mount.tsx\'\n'
    const reordered = await lint(wrongOrder, PLATFORM_ENTRY)
    expect(reordered.rules).toContain('no-restricted-syntax')
    expect(reordered.messages.join('\n')).toContain('第一个导入 shared/lib/zod-jitless.ts')
    const withCode = 'import \'../../shared/lib/zod-jitless.ts\'\nimport { createAppRuntime } from \'../../app/runtime.ts\'\n\ncreateAppRuntime()\n'
    const mixed = await lint(withCode, PLATFORM_ENTRY)
    expect(mixed.rules.filter(rule => rule === 'no-restricted-syntax')).toHaveLength(2)
    expect(mixed.messages.join('\n')).toContain('只写副作用导入')
  })

  it('写成 main.ts 的入口同样受约束；CSP 阳性对照的入口除外（复验 R7）', async () => {
    const config = await configFor('apps/web/src/entries/editor/main.ts')
    const syntax = config.rules?.['no-restricted-syntax']
    expect(JSON.stringify(syntax)).toContain('zod-jitless')
    const probe = await configFor('apps/web/src/entries/csp-probe/main.ts')
    expect(JSON.stringify(probe.rules?.['no-restricted-syntax'])).not.toContain('zod-jitless')
  })

  it('每个页面（apps/web/*.html）引用的入口脚本都受入口规则约束，CSP 阳性对照除外：入口换了名字或写法也不会漏掉（复验 S7）', async () => {
    const pages = readdirSync(join(REPO_ROOT, 'apps/web')).filter(name => name.endsWith('.html'))
    expect(pages).toContain('index.html')
    for (const page of pages) {
      const html = readFileSync(join(REPO_ROOT, 'apps/web', page), 'utf8')
      const scripts = [...html.matchAll(/<script[^>]*\ssrc="\/([^"]+)"/g)].map(match => `apps/web/${match[1] ?? ''}`)
      expect(scripts, page).not.toEqual([])
      for (const script of scripts) {
        const syntax = JSON.stringify((await configFor(script)).rules?.['no-restricted-syntax'])
        if (page === 'csp-probe.html')
          expect(syntax, script).not.toContain('zod-jitless')
        else
          expect(syntax, script).toContain('zod-jitless')
      }
    }
  })

  it('不能借"无主"文件中转绕过边界', async () => {
    expect(await rulesFor(`import { probe } from '../../${PROBE}.ts'\nexport const p = probe\n`, PLATFORM_ENTRY)).toContain('boundaries/no-unknown-dependencies')
    const config = await configFor('apps/web/src/stray.ts')
    expect(severity(config.rules?.['boundaries/no-unknown-files'])).toBe(2)
  })

  it('跨元素只能引用公开入口', async () => {
    expect(await rulesFor('import { errorResponseSchema } from \'../../../../packages/contracts/src/errors/error-response.ts\'\nexport const s = errorResponseSchema\n', WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('前端分层：共享层不能引用应用层；功能模块之间只经对方的公开入口（审查 B23）', async () => {
    expect(await rulesFor('import { createAppRuntime } from \'../../app/runtime.ts\'\nexport const f = createAppRuntime\n', WEB_SHARED_FILE)).toContain('boundaries/dependencies')
    expect(await rulesFor('import { fetchPersonalDocuments } from \'../documents/documents-api.ts\'\nexport const f = fetchPersonalDocuments\n', WEB_FEATURE_FILE)).toContain('boundaries/dependencies')
    expect(await rulesFor('import { DocumentListPage } from \'../documents/index.ts\'\nexport const f = DocumentListPage\n', WEB_FEATURE_FILE)).not.toContain('boundaries/dependencies')
  })

  it('TypeScript 文件之间的循环依赖会失败', async () => {
    // licenses.ts 被 license-bundle.ts 引用，这里让它反过来引用 license-bundle.ts
    const code = 'import { checkLicenseBundle } from \'./license-bundle.ts\'\n\nexport const f = checkLicenseBundle\n'
    expect(await rulesFor(code, 'tools/src/gates/licenses.ts')).toContain('import-x/no-cycle')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：编辑器适配层与内部 API（P4 设计 §3.1、§3.6.9）', () => {
  const EDITOR_FILE = 'apps/web/src/editor/sheet-editor.ts'
  const INTERNAL_API_FILE = 'apps/web/src/editor/internal-api/index.ts'
  const INTERNAL_MESSAGE = '内部 API 只能经 apps/web/src/editor/internal-api/ 引用并登记'

  it('受限的内部符号在 internal-api 之外引用会失败：静态导入、import type、命名空间导入与再导出都算', async () => {
    const cases = [
      'import { IFunctionService } from \'@univerjs/engine-formula\'\n\nexport const s = IFunctionService\n',
      'import type { BaseFunction } from \'@univerjs/engine-formula\'\n\nexport type F = BaseFunction\n',
      'import * as formula from \'@univerjs/engine-formula\'\n\nexport const f = formula\n',
      'export { LifecycleService } from \'@univerjs/core\'\n',
      'import { SetRangeValuesMutation } from \'@univerjs/sheets\'\n\nexport const m = SetRangeValuesMutation\n',
      // 决定不用的：setCurrentUser 所在的服务与本地授权服务（ADR-009）
      'import { UserManagerService } from \'@univerjs/core\'\n\nexport const u = UserManagerService\n',
    ]
    for (const code of cases) {
      const report = await lint(code, EDITOR_FILE)
      expect(report.rules, code).toContain('no-restricted-imports')
      expect(report.messages.join('\n'), code).toContain(INTERNAL_MESSAGE)
    }
    // Facade 与公开的类型、枚举照常引用
    expect(await rulesFor('import { CommandType, Univer } from \'@univerjs/core\'\n\nexport const used = [CommandType, Univer]\n', EDITOR_FILE)).not.toContain('no-restricted-imports')
  })

  it('internal-api 里可以引用受限的内部符号、调用 __getInjector', async () => {
    const code = 'import type { Univer } from \'@univerjs/core\'\nimport { LifecycleService } from \'@univerjs/core\'\nimport { IFunctionService } from \'@univerjs/engine-formula\'\n\nexport function services(univer: Univer): unknown[] {\n  return [univer.__getInjector().get(IFunctionService), LifecycleService]\n}\n'
    const rules = await rulesFor(code, INTERNAL_API_FILE)
    expect(rules).not.toContain('no-restricted-imports')
    expect(rules).not.toContain('no-restricted-syntax')
  })

  it('__getInjector 的调用在 internal-api 之外一律失败：编辑器、平台代码、后端；计算属性与解构也算；对象字面量里同名的属性不算', async () => {
    const declared = 'declare const univer: { __getInjector: () => unknown }\n'
    for (const file of [EDITOR_FILE, WEB_FILE, API_SERVICE]) {
      const report = await lint(`${declared}export const injector = univer.__getInjector()\n`, file)
      expect(report.rules, file).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), file).toContain(INTERNAL_MESSAGE)
    }
    expect(await rulesFor(`${declared}export const injector = univer['__getInjector']()\n`, EDITOR_FILE)).toContain('no-restricted-syntax')
    expect(await rulesFor(`${declared}const { __getInjector } = univer\nexport const get = __getInjector\n`, EDITOR_FILE)).toContain('no-restricted-syntax')
    expect(await rulesFor('export const fake = { __getInjector: () => 1 }\n', EDITOR_FILE)).not.toContain('no-restricted-syntax')
  })

  it('__getInjector 的其他写法同样失败：模板字符串、字符串的键解构、Reflect.get（审查 B4）', async () => {
    const declared = 'declare const univer: { __getInjector: () => unknown }\n'
    const cases = [
      `${declared}export const injector = univer[\`__getInjector\`]()\n`,
      `${declared}const { '__getInjector': get } = univer\nexport const injector = get\n`,
      `${declared}export const get: unknown = Reflect.get(univer, '__getInjector')\n`,
    ]
    for (const code of cases) {
      for (const file of [EDITOR_FILE, WEB_FILE]) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-syntax')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(INTERNAL_MESSAGE)
      }
    }
  })

  it('私有字段 _injector 同样只能在 internal-api 里取：点号、方括号、字符串的键与 Reflect.get 都算（复验 RB4）', async () => {
    const declared = 'declare const univerAPI: { _injector: unknown }\n'
    const cases = [
      `${declared}export const injector = univerAPI._injector\n`,
      `${declared}export const injector = univerAPI['_injector']\n`,
      `${declared}export const injector = univerAPI[\`_injector\`]\n`,
      `${declared}const { _injector: injector } = univerAPI\nexport const i = injector\n`,
      `${declared}export const injector: unknown = Reflect.get(univerAPI, '_injector')\n`,
    ]
    for (const code of cases) {
      for (const file of [EDITOR_FILE, WEB_FILE]) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-syntax')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(INTERNAL_MESSAGE)
      }
    }
    expect(await rulesFor('export const fake = { _injector: 1 }\n', EDITOR_FILE)).not.toContain('no-restricted-syntax')
  })

  it('类型里的 import(\'@univerjs/…\') 在编辑器之外失败，在编辑器里（internal-api 之外）也失败：内部 API 的限制只认导入语句（复验 RB4）', async () => {
    const code = 'export type Service = import(\'@univerjs/engine-formula\').IFunctionService\nexport type Module = typeof import(\'@univerjs/core\')\n'
    for (const file of [EDITOR_FILE, WEB_FILE]) {
      const report = await lint(code, file)
      expect(report.rules, file).toContain('no-restricted-syntax')
    }
  })

  it('三斜杠引用与 import x = require() 会失败：它们绕得过受限导入（复验 RB4）', async () => {
    for (const code of [
      '/// <reference types="@univerjs/engine-formula" />\nexport const a = 1\n',
      '/// <reference path="../../../node_modules/@univerjs/engine-formula/lib/types/index.d.ts" />\nexport const a = 1\n',
    ]) {
      expect(await rulesFor(code, EDITOR_FILE), code).toContain('ts/triple-slash-reference')
    }
    expect(await rulesFor('import formula = require(\'@univerjs/engine-formula\')\nexport const f = formula\n', EDITOR_FILE)).toContain('no-restricted-syntax')
  })

  it('按 node_modules 里的路径引用依赖会失败：静态导入、再导出与动态导入都算，编辑器与 internal-api 也一样（审查 B4）', async () => {
    const NODE_MODULES_MESSAGE = '按包名引用依赖，不要写 node_modules 里的路径'
    const source = '../../../node_modules/@univerjs/engine-formula/lib/es/index.js'
    for (const file of [EDITOR_FILE, INTERNAL_API_FILE, WEB_FILE, API_SERVICE, CONTRACTS_FILE]) {
      for (const code of [`import * as formula from '${source}'\n\nexport const f = formula\n`, `export * from '${source}'\n`]) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(NODE_MODULES_MESSAGE)
      }
    }
    for (const file of [EDITOR_FILE, WEB_FILE]) {
      const report = await lint(`export async function load(): Promise<unknown> {\n  return import('${source}')\n}\n`, file)
      expect(report.rules, file).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), file).toContain(NODE_MODULES_MESSAGE)
    }
    // 名字里带 node_modules 字样的普通模块不算
    expect(await rulesFor('import { probe } from \'./my-node_modules-notes.ts\'\n\nexport const p = probe\n', WEB_FILE)).not.toContain('no-restricted-imports')
  })

  it('Univer 包里的深层路径会失败（它绕得过按导入名的限制），internal-api 也一样；只允许包入口、/facade、/locale/<语言> 与 /lib/index.css', async () => {
    for (const source of ['@univerjs/engine-formula/lib/es/index.js', '@univerjs/sheets/lib/facade', '@univerjs/core/lib/types/index.d.ts']) {
      const code = `import * as deep from '${source}'\n\nexport const d = deep\n`
      expect(await rulesFor(code, EDITOR_FILE), source).toContain('no-restricted-imports')
      expect(await rulesFor(code, INTERNAL_API_FILE), source).toContain('no-restricted-imports')
    }
    const allowed = 'import zhCN from \'@univerjs/sheets/locale/zh-CN\'\nimport \'@univerjs/sheets/facade\'\nimport \'@univerjs/design/lib/index.css\'\n\nexport const locale = zhCN\n'
    expect(await rulesFor(allowed, EDITOR_FILE)).not.toContain('no-restricted-imports')
  })

  it('编辑器里动态导入 @univerjs/* 会失败：按导入名的限制只认静态导入', async () => {
    const report = await lint('export async function load(): Promise<unknown> {\n  return import(\'@univerjs/engine-formula\')\n}\n', EDITOR_FILE)
    expect(report.rules).toContain('no-restricted-syntax')
    expect(report.messages.join('\n')).toContain('用静态导入')
  })

  it('internal-api 的配置不限制内部符号，编辑器的其他位置限制', async () => {
    const internal = restrictedImports(await configFor(INTERNAL_API_FILE))
    expect(internal.paths ?? []).toEqual([])
    const editor = restrictedImports(await configFor('apps/web/src/editor/change-tracking/change-tracker.ts'))
    expect(editor.paths?.find(path => path.name === '@univerjs/engine-formula')?.importNames).toEqual(expect.arrayContaining(['IActiveDirtyManagerService', 'IFunctionService', 'BaseFunction', 'ErrorValueObject', 'ErrorType']))
  })

  it('只有编辑器页的入口与编辑器页（sheet-editor 功能）能引用编辑器，而且只经公开入口', async () => {
    const importEditor = (path: string): string => `import { createSheetEditor } from '${path}'\n\nexport const f = createSheetEditor\n`
    expect((await lintAtProbe(importEditor('../../editor/index.ts'), PROBE_FILES.editorEntry)).rules).not.toContain('boundaries/dependencies')
    expect((await lintAtProbe(importEditor('../../editor/index.ts'), PROBE_FILES.sheetEditor)).rules).not.toContain('boundaries/dependencies')
    expect((await lintAtProbe(importEditor('../../editor/sheet-editor.ts'), PROBE_FILES.editorEntry)).rules).toContain('boundaries/dependencies')
    expect((await lintAtProbe(importEditor('../../editor/sheet-editor.ts'), PROBE_FILES.sheetEditor)).rules).toContain('boundaries/dependencies')
    // 其他功能模块与平台的应用层都不能引用编辑器
    expect(await rulesFor(importEditor('../../editor/index.ts'), WEB_FEATURE_FILE)).toContain('boundaries/dependencies')
    expect(await rulesFor(importEditor('../editor/index.ts'), WEB_FILE)).toContain('boundaries/dependencies')
  })

  it('平台的应用层、其他入口与其他功能不能引用编辑器页；编辑器页自己内部的引用不受影响', async () => {
    const importPart = (path: string): string => `import { probe } from '${path}'\n\nexport const p = probe\n`
    const part = `${PROBE}-part.ts`
    for (const [file, path] of [[WEB_FILE, `../features/sheet-editor/${part}`], [WEB_FEATURE_FILE, `../sheet-editor/${part}`], ['apps/web/src/entries/platform/mount.tsx', `../../features/sheet-editor/${part}`]] as const) {
      const report = await lint(importPart(path), file)
      expect(report.rules, file).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('只由编辑器页的入口引用')
    }
    expect((await lintAtProbe(importPart(`./${part}`), PROBE_FILES.sheetEditor)).rules).not.toContain('boundaries/dependencies')
    // 编辑器页的入口不受这条限制（它照常只能经公开入口引用编辑器页）
    const fromEntry = await lintAtProbe(importPart(`../../features/sheet-editor/${part}`), PROBE_FILES.editorEntry)
    expect(fromEntry.messages.join('\n')).not.toContain('只由编辑器页的入口引用')
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：类型与写法', () => {
  it('禁止 any、非空断言与 console（包括 console.error）', async () => {
    const rules = await rulesFor('export function f(x: any, y?: string): string {\n  console.error(x)\n  return y!\n}\n', CONTRACTS_FILE)
    expect(rules).toEqual(expect.arrayContaining(['ts/no-explicit-any', 'ts/no-non-null-assertion', 'no-console']))
  })

  it('禁止 @ts-ignore', async () => {
    expect(await rulesFor('// @ts-ignore\nexport const n: number = \'x\'\n', CONTRACTS_FILE)).toContain('ts/ban-ts-comment')
  })

  it('Promise 不能悬空', async () => {
    expect(await rulesFor('async function job(): Promise<void> {}\n\nexport function run(): void {\n  job()\n}\n', CONTRACTS_FILE)).toContain('ts/no-floating-promises')
  })

  it('switch 必须覆盖联合类型的全部分支', async () => {
    const code = 'export function f(x: \'a\' | \'b\'): number {\n  switch (x) {\n    case \'a\':\n      return 1\n  }\n  return 0\n}\n'
    expect(await rulesFor(code, CONTRACTS_FILE)).toContain('ts/switch-exhaustiveness-check')
  })

  it('只用于类型的导入写成 import type', async () => {
    expect(await rulesFor('import { z } from \'zod\'\n\nexport type S = z.ZodString\n', CONTRACTS_FILE)).toContain('ts/consistent-type-imports')
  })

  it('禁止 dangerouslySetInnerHTML，图片必须有替代文字（无障碍规则在 ESLint 10 下生效）', async () => {
    const code = 'export function App({ html }: { html: string }) {\n  return <div><div dangerouslySetInnerHTML={{ __html: html }} /><img src="a.png" /></div>\n}\n'
    expect(await rulesFor(code, WEB_FILE)).toEqual(expect.arrayContaining(['react/dom-no-dangerously-set-innerhtml', 'jsx-a11y/alt-text']))
  })

  it('文件名必须是短横线小写', async () => {
    expect((await configFor(CONTRACTS_FILE)).rules?.['unicorn/filename-case']).toEqual([2, { case: 'kebabCase' }])
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：后端', () => {
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

  it('只有 config 模块读取 process.env', async () => {
    const code = 'import process from \'node:process\'\n\nexport const url = process.env.NERVE_DATABASE_URL\n'
    expect(await rulesFor(code, API_SERVICE)).toContain('node/no-process-env')
    expect(severity((await configFor(API_CONFIG)).rules?.['node/no-process-env'])).toBe(0)
  })

  it('只有 database 模块、仓储与表定义能引用 drizzle-orm 与 pg', async () => {
    const code = 'import { sql } from \'drizzle-orm\'\n\nexport const s = sql\n'
    expect(await rulesFor('import pg from \'pg\'\n\nexport const Pool = pg.Pool\n', API_SERVICE)).toContain('no-restricted-imports')
    expect(await rulesFor(code, API_SERVICE)).toContain('no-restricted-imports')
    for (const allowed of ['apps/api/src/modules/audit/audit.repository.ts', 'apps/api/src/modules/database/pool.ts', 'apps/api/src/db/schema/audit/index.ts'])
      expect(await rulesFor(code, allowed), allowed).not.toContain('no-restricted-imports')
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

  it('app 层只有程序接口（index.ts）能转出数据库句柄，app 层的其他文件同样拿不到（复验 N6）', async () => {
    const code = 'import { DATABASE } from \'../modules/database/index.ts\'\n\nexport const token = DATABASE\n'
    expect(await rulesFor(code, 'apps/api/src/app/app.module.ts')).toContain('no-restricted-imports')
    expect(await rulesFor('export { DATABASE } from \'../modules/database/index.ts\'\n', 'apps/api/src/app/index.ts')).not.toContain('no-restricted-imports')
  })

  it('控制器不自己开事务', async () => {
    expect(await rulesFor('import { TransactionRunner } from \'../database/index.ts\'\nexport const runner = TransactionRunner\n', API_CONTROLLER)).toContain('no-restricted-imports')
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
      'apps/api/src/cli/migrate.ts',
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
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：测试代码只在测试里（审查 B17）', () => {
  const EXTRANEOUS = 'import-x/no-extraneous-dependencies'

  it('生产代码与仓库工具不能引用测试库：静态导入、import type 与动态导入都算', async () => {
    expect(await rulesFor('import { vi } from \'vitest\'\n\nexport const mock = vi.fn\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import type { Mock } from \'vitest\'\n\nexport type M = Mock\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('export async function load(): Promise<unknown> {\n  return import(\'vitest\')\n}\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { render } from \'@testing-library/react\'\n\nexport const r = render\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\nexport const t = test\n', WEB_FILE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { Test } from \'@nestjs/testing\'\n\nexport const t = Test\n', API_SERVICE)).toContain(EXTRANEOUS)
    expect(await rulesFor('import { describe } from \'vitest\'\n\nexport const d = describe\n', 'tools/src/gates/run.ts')).toContain(EXTRANEOUS)
    // 本包 dependencies 里的包照常引用
    expect(await rulesFor('import { z } from \'zod\'\n\nexport const s = z.string()\n', WEB_FILE)).not.toContain(EXTRANEOUS)
  })

  it('生产代码不能引用测试与测试辅助', async () => {
    expect(await rulesFor('import { renderApp } from \'./render-app.test-support.tsx\'\n\nexport const r = renderApp\n', WEB_FILE)).toContain('ts/no-restricted-imports')
    for (const path of ['./render-app.test-support.tsx?raw', './render-app.TEST-SUPPORT.tsx', './app.test.tsx#x'])
      expect(await rulesFor(`import value from '${path}'\n\nexport const v = value\n`, WEB_FILE), path).toContain('ts/no-restricted-imports')
    expect(await rulesFor('import { installFakeApi } from \'../shared/testing/fake-api.test-support.ts\'\n\nexport const f = installFakeApi\n', WEB_FILE)).toContain('ts/no-restricted-imports')
  })

  it('动态导入测试与测试辅助同样拦下（复验 R3）', async () => {
    const load = (path: string): string => `export async function load(): Promise<unknown> {\n  return import('${path}')\n}\n`
    for (const path of ['../shared/testing/fake-api.test-support.ts', './app.test.tsx', './render-app.test-support', './app.TEST.tsx', '../shared/testing/fake-api.test-support.ts?raw', './app.test.tsx#x'])
      expect(await rulesFor(load(path), WEB_FILE), path).toContain('no-restricted-syntax')
    expect(await rulesFor(load('../../../../tests/integration/src/support/api-app.ts'), 'tools/src/gates/run.ts')).not.toContain('no-restricted-syntax')
  })

  it('测试与测试辅助可以引用测试库与测试辅助；构建配置与构建插件可以用开发依赖', async () => {
    const code = 'import { render } from \'@testing-library/react\'\nimport { vi } from \'vitest\'\nimport { installFakeApi } from \'../shared/testing/fake-api.test-support.ts\'\n\nexport const used = [render, vi, installFakeApi]\n'
    for (const file of [WEB_TEST_SUPPORT, WEB_TEST_FILE]) {
      const rules = await rulesFor(code, file)
      expect(rules, file).not.toContain(EXTRANEOUS)
      expect(rules, file).not.toContain('ts/no-restricted-imports')
    }
    for (const file of ['apps/web/vite.config.ts', 'apps/web/build/third-party-licenses.ts', 'vitest.config.ts', 'tests/integration/src/support/api-app.ts'])
      expect(severity((await configFor(file)).rules?.[EXTRANEOUS]), file).toBeUndefined()
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：测试的写法', () => {
  it('不允许 .only', async () => {
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.only(\'x\', () => {})\n', TOOLS_TEST_FILE)).toContain('test/no-only-tests')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.only(\'x\', async () => {})\n', E2E_FILE)).toContain('playwright/no-focused-test')
  })

  it('不允许跳过或占位的用例（skip、todo、fixme）', async () => {
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.skip(\'x\', () => {})\n', TOOLS_TEST_FILE)).toContain('test/no-disabled-tests')
    expect(await rulesFor('import { it } from \'vitest\'\n\nit.todo(\'x\')\n', TOOLS_TEST_FILE)).toContain('test/warn-todo')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.skip(\'x\', async () => {})\n', E2E_FILE)).toContain('playwright/no-skipped-test')
    expect(await rulesFor('import { test } from \'@playwright/test\'\n\ntest.fixme(\'x\', async () => {})\n', E2E_FILE)).toContain('playwright/no-skipped-test')
  })

  it('没有警告级别的规则（规范 §2.2）', async () => {
    for (const file of [WEB_FILE, CONTRACTS_FILE, 'tools/src/git/strip-ai-trailers.ts', E2E_FILE, API_CONTROLLER, INTEGRATION_FILE, 'pnpm-workspace.yaml', 'package.json']) {
      const warned = Object.entries((await configFor(file)).rules ?? {}).filter(([, entry]) => [1, 'warn'].includes(severity(entry) as number | string))
      expect(warned.map(([name]) => `${file} ${name}`)).toEqual([])
    }
  })
}, LINT_TIMEOUT)

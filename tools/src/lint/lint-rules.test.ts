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

/** 弹窗类的 Radix 原语的限制的说明（开头一段，M2-P2 复验） */
const RADIX_DIALOG_MESSAGE = '弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入'

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
// 预热之后，一个用例检查几段到十几段代码：本机大多不到 1 秒，最慢的约 3 秒（按 node_modules 里的路径引用时要解析 Univer 的包、
// 按边界逐个功能检查时要多次解析路径）。CI 的 4 核机器慢十倍左右，还要与并行的测试文件抢 CPU：M2-P2 合并之后，
// 本机 2.1 秒的用例在 CI 上超过了原来的 20 秒。时限只用来发现卡住的用例，按本机最慢的二十倍留余量
const LINT_TIMEOUT = 60_000

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

  it('包名写成大写会失败：静态导入、再导出、动态导入与类型里的 import() 都算，编辑器与后端里也算；包里的路径与相对路径不管（复验 TB5）', async () => {
    const cases: [string, string][] = [
      ['import { IFunctionService } from \'@UniverJS/engine-formula\'\n\nexport const s = IFunctionService\n', 'no-restricted-imports'],
      ['import { IFunctionService } from \'@univerjs/Engine-formula\'\n\nexport const s = IFunctionService\n', 'no-restricted-imports'],
      ['export * from \'React\'\n', 'no-restricted-imports'],
      ['export async function load() {\n  return import(\'@UniverJS/engine-formula\')\n}\n', 'no-restricted-syntax'],
      ['export type F = typeof import(\'@UniverJS/engine-formula\')\n', 'no-restricted-syntax'],
    ]
    for (const file of [WEB_FILE, 'apps/web/src/editor/sheet-editor.ts', 'apps/web/src/editor/internal-api/index.ts', 'apps/api/src/modules/documents/documents.service.ts']) {
      for (const [code, rule] of cases) {
        const report = await lint(code, file)
        expect(report.rules, `${file}: ${code}`).toContain(rule)
        expect(report.messages.join('\n'), `${file}: ${code}`).toContain('包名写成小写')
      }
    }
    const allowed = 'import { createRoot } from \'react-dom/client\'\nimport { Univer } from \'./Sample.ts\'\n\nexport const used = [createRoot, Univer]\n'
    expect((await lint(allowed, WEB_FILE)).messages.join('\n')).not.toContain('包名写成小写')
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

  it('只读加固用到的内部符号（M2-P3 设计 §3.6）在 internal-api 之外引用会失败：只读守卫所在的位置也一样，命名空间导入与再导出同样拦下', async () => {
    const cases = [
      'import { IPermissionService } from \'@univerjs/core\'\n\nexport const s = IPermissionService\n',
      'import type { IUndoRedoService } from \'@univerjs/core\'\n\nexport type U = IUndoRedoService\n',
      'import { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel } from \'@univerjs/sheets\'\n\nexport const lists = [getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel]\n',
      'import { WorksheetCopyPermission, WorksheetViewPermission } from \'@univerjs/sheets\'\n\nexport const kept = [WorksheetViewPermission, WorksheetCopyPermission]\n',
      'import { WorkbookCopyPermission, WorkbookViewPermission } from \'@univerjs/sheets\'\n\nexport const allowed = [WorkbookViewPermission, WorkbookCopyPermission]\n',
      'import * as sheets from \'@univerjs/sheets\'\n\nexport const s = sheets\n',
      'export { IUndoRedoService } from \'@univerjs/core\'\n',
      'export { WorksheetViewPermission as View } from \'@univerjs/sheets\'\n',
    ]
    for (const file of [EDITOR_FILE, 'apps/web/src/editor/read-only/read-only-guard.ts']) {
      for (const code of cases) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(INTERNAL_MESSAGE)
      }
    }
    // 包里的其他导出照常引用（插件与公开的类型）
    expect(await rulesFor('import { UniverSheetsPlugin } from \'@univerjs/sheets\'\n\nexport const p = UniverSheetsPlugin\n', EDITOR_FILE)).not.toContain('no-restricted-imports')
  })

  it('只读守卫设图片不可编辑的服务（M2-P3 S3 之后的修复）在 internal-api 之外引用会失败；决定不用的表格图片服务同样受限；插件照常引用', async () => {
    const cases = [
      'import { IDrawingManagerService } from \'@univerjs/drawing\'\n\nexport const s = IDrawingManagerService\n',
      'import type { IDrawingManagerService } from \'@univerjs/drawing\'\n\nexport type S = IDrawingManagerService\n',
      'export { IDrawingManagerService as Drawings } from \'@univerjs/drawing\'\n',
      'import * as drawing from \'@univerjs/drawing\'\n\nexport const d = drawing\n',
      'import { ISheetDrawingService } from \'@univerjs/sheets-drawing\'\n\nexport const s = ISheetDrawingService\n',
    ]
    for (const file of [EDITOR_FILE, 'apps/web/src/editor/read-only/read-only-guard.ts']) {
      for (const code of cases) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(INTERNAL_MESSAGE)
      }
    }
    const plugins = 'import { UniverDrawingPlugin } from \'@univerjs/drawing\'\nimport { UniverSheetsDrawingPlugin } from \'@univerjs/sheets-drawing\'\n\nexport const p = [UniverDrawingPlugin, UniverSheetsDrawingPlugin]\n'
    expect(await rulesFor(plugins, 'apps/web/src/editor/profile/sheet-profile.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { IDrawingManagerService } from \'@univerjs/drawing\'\n\nexport const s = IDrawingManagerService\n', INTERNAL_API_FILE)).not.toContain('no-restricted-imports')
  })

  it('只读守卫放开编辑栏、拦下冻结线用到的内部符号（P3 审查 A1、B2）在 internal-api 之外引用会失败；这几个包的插件照常引用', async () => {
    const cases = [
      'import { IEditorService } from \'@univerjs/docs-ui\'\n\nexport const s = IEditorService\n',
      'import type { IEditorService } from \'@univerjs/docs-ui\'\n\nexport type S = IEditorService\n',
      'import { IContextService } from \'@univerjs/core\'\n\nexport const s = IContextService\n',
      'import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR } from \'@univerjs/core\'\n\nexport const keys = [DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR]\n',
      'import { IRenderManagerService } from \'@univerjs/engine-render\'\n\nexport const s = IRenderManagerService\n',
      'import { HeaderFreezeRenderController } from \'@univerjs/sheets-ui\'\n\nexport const c = HeaderFreezeRenderController\n',
      'export { HeaderFreezeRenderController as Freeze } from \'@univerjs/sheets-ui\'\n',
      'import * as docsUi from \'@univerjs/docs-ui\'\n\nexport const d = docsUi\n',
    ]
    for (const file of [EDITOR_FILE, 'apps/web/src/editor/read-only/formula-bar.ts']) {
      for (const code of cases) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(INTERNAL_MESSAGE)
      }
    }
    const plugins = 'import { UniverDocsUIPlugin } from \'@univerjs/docs-ui\'\nimport { UniverRenderEnginePlugin } from \'@univerjs/engine-render\'\nimport { UniverSheetsUIPlugin } from \'@univerjs/sheets-ui\'\n\nexport const p = [UniverDocsUIPlugin, UniverRenderEnginePlugin, UniverSheetsUIPlugin]\n'
    expect(await rulesFor(plugins, 'apps/web/src/editor/profile/sheet-profile.ts')).not.toContain('no-restricted-imports')
    const internal = [
      'import { DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR, IContextService } from \'@univerjs/core\'',
      'import { IEditorService } from \'@univerjs/docs-ui\'',
      'import { IRenderManagerService } from \'@univerjs/engine-render\'',
      'import { HeaderFreezeRenderController } from \'@univerjs/sheets-ui\'',
      '',
      'export const used = [DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, FOCUSING_FX_BAR_EDITOR, IContextService, IEditorService, IRenderManagerService, HeaderFreezeRenderController]',
      '',
    ].join('\n')
    expect(await rulesFor(internal, INTERNAL_API_FILE)).not.toContain('no-restricted-imports')
  })

  it('internal-api 里可以引用只读加固用到的内部符号（M2-P3 设计 §3.6）', async () => {
    const code = [
      'import { IPermissionService, IUndoRedoService } from \'@univerjs/core\'',
      'import { getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, WorkbookCopyPermission, WorkbookViewPermission, WorksheetCopyPermission, WorksheetViewPermission } from \'@univerjs/sheets\'',
      '',
      'export const used = [IPermissionService, IUndoRedoService, getAllWorksheetPermissionPoint, getAllWorksheetPermissionPointByPointPanel, WorkbookCopyPermission, WorkbookViewPermission, WorksheetCopyPermission, WorksheetViewPermission]',
      '',
    ].join('\n')
    expect(await rulesFor(code, INTERNAL_API_FILE)).not.toContain('no-restricted-imports')
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

  it('import.meta.glob 与带查询串或片段的 @univerjs 包名会失败（复验 SB7）', async () => {
    const glob = 'export const modules = import.meta.glob(\'../../node_modules/@univerjs/engine-formula/lib/es/index.js\', { eager: true })\n'
    for (const file of [EDITOR_FILE, WEB_FILE])
      expect(await rulesFor(glob, file), file).toContain('no-restricted-syntax')
    for (const source of ['@univerjs/engine-formula?raw', '@univerjs/engine-formula#x']) {
      const code = `import * as formula from '${source}'\n\nexport const f = formula\n`
      expect(await rulesFor(code, EDITOR_FILE), source).toContain('no-restricted-imports')
      expect(await rulesFor(code, INTERNAL_API_FILE), source).toContain('no-restricted-imports')
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
    // 只读加固（M2-P3 设计 §3.6）
    expect(editor.paths?.find(path => path.name === '@univerjs/core')?.importNames).toEqual(expect.arrayContaining(['IAuthzIoService', 'IPermissionService', 'IUndoRedoService']))
    expect(editor.paths?.find(path => path.name === '@univerjs/sheets')?.importNames).toEqual(expect.arrayContaining([
      'getAllWorksheetPermissionPoint',
      'getAllWorksheetPermissionPointByPointPanel',
      'WorkbookCopyPermission',
      'WorkbookViewPermission',
      'WorksheetCopyPermission',
      'WorksheetViewPermission',
    ]))
    // 浮动图片的可编辑（M2-P3 S3 之后的修复）
    expect(editor.paths?.find(path => path.name === '@univerjs/drawing')?.importNames).toEqual(['IDrawingManagerService'])
    expect(editor.paths?.find(path => path.name === '@univerjs/sheets-drawing')?.importNames).toEqual(['ISheetDrawingService'])
    // 放开编辑栏、拦下冻结线（P3 审查 A1、B2）
    expect(editor.paths?.find(path => path.name === '@univerjs/core')?.importNames).toEqual(expect.arrayContaining(['IContextService', 'FOCUSING_FX_BAR_EDITOR', 'DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY']))
    expect(editor.paths?.find(path => path.name === '@univerjs/docs-ui')?.importNames).toEqual(['IEditorService'])
    expect(editor.paths?.find(path => path.name === '@univerjs/engine-render')?.importNames).toEqual(['IRenderManagerService'])
    expect(editor.paths?.find(path => path.name === '@univerjs/sheets-ui')?.importNames).toEqual(['HeaderFreezeRenderController'])
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

  it('管理界面按需加载（M2-P1 审查 B2）：只有路由表能动态 import() 它的公开入口；静态引用、类型引用、再导出、别处的动态引用都不行', async () => {
    const ROUTES_FILE = 'apps/web/src/app/routes.ts'
    const dynamicImport = (path: string): string => `export async function pages() {\n  return import('${path}')\n}\n`
    expect(await rulesFor(dynamicImport('../features/admin/index.ts'), ROUTES_FILE)).not.toContain('boundaries/dependencies')
    const violations: [string, string][] = [
      // 路由表：静态引用、动态引用内部文件
      [`import { AdminLayout } from '../features/admin/index.ts'\n\nexport const layout = AdminLayout\n`, ROUTES_FILE],
      [dynamicImport('../features/admin/users-page.tsx'), ROUTES_FILE],
      // 应用层的其他文件、功能模块、入口
      [dynamicImport('../features/admin/index.ts'), WEB_FILE],
      [`import type { AdminLayout } from '../admin/index.ts'\n\nexport type Layout = typeof AdminLayout\n`, WEB_FEATURE_FILE],
      [`export { AdminLayout } from '../../features/admin/index.ts'\n`, PLATFORM_ENTRY],
    ]
    for (const [code, file] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('管理界面（features/admin）按需加载')
    }
    // 弹窗不经 shared 的任何文件转出：Radix Dialog 会随桶文件进首屏（复验 N2）。按解析之后的路径判断，中转与换写法都拦得住（复验 X6）
    const BARREL = 'apps/web/src/shared/ui/index.ts'
    const relayed: [string, string][] = [
      [`export { Dialog } from './dialog.tsx'\n`, BARREL],
      [`export * from './dialog.tsx'\n`, BARREL],
      [`export { Dialog } from '../ui/dialog.tsx'\n`, BARREL],
      [`export { Dialog } from './dialog.js'\n`, BARREL],
      [`export { Dialog } from './dialog'\n`, BARREL],
      [`export type { DialogContent } from './dialog.tsx'\n`, BARREL],
      // shared 里别的文件中转
      [`export { Dialog } from '../ui/dialog.tsx'\n`, WEB_SHARED_FILE],
    ]
    for (const [code, file] of relayed) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('import-x/no-restricted-paths')
      expect(report.messages.join('\n'), code).toContain('弹窗（shared/ui/dialog.tsx，Radix Dialog）不经 shared 的其他文件转出')
    }
    expect(await rulesFor(`export { Button } from './button.tsx'\n`, BARREL)).not.toContain('import-x/no-restricted-paths')
    // shared 的其他文件直接从 radix-ui 引入弹窗原语同样拦下；别的原语与弹窗自己的文件不受影响
    const radixDialog = 'import { Dialog } from \'radix-ui\'\n\nexport const Root = Dialog.Root\n'
    expect((await lint(radixDialog, WEB_SHARED_FILE)).messages.join('\n')).toContain('弹窗类的 Radix 原语（Dialog、AlertDialog）只在 shared/ui/dialog.tsx 里引入')
    expect((await lint(`export { AlertDialog } from 'radix-ui'\n`, BARREL)).messages.join('\n')).toContain('弹窗类的 Radix 原语')
    expect((await lint('import { Label } from \'radix-ui\'\n\nexport const Root = Label.Root\n', 'apps/web/src/shared/ui/label.tsx')).messages.join('\n')).not.toContain('弹窗类的 Radix 原语')
    expect((await lint(radixDialog, 'apps/web/src/shared/ui/dialog.tsx')).messages.join('\n')).not.toContain('弹窗类的 Radix 原语')
    // 用到弹窗的功能模块（确认的弹窗、按需加载的管理界面）直接引用它
    expect(await rulesFor('import { DialogContent } from \'../../shared/ui/dialog.tsx\'\n\nexport const content = DialogContent\n', 'apps/web/src/features/confirmation/confirm-dialog.tsx')).not.toContain('import-x/no-restricted-paths')
    // 管理界面自己内部的引用不受影响
    expect(await rulesFor('import { ADMIN_QUERY_KEY } from \'./admin-api.ts\'\n\nexport const key = ADMIN_QUERY_KEY\n', 'apps/web/src/features/admin/users-page.tsx')).not.toContain('boundaries/dependencies')
  })

  it('成员页按需加载；确认的弹窗只由按需加载的功能引用（M2-P2 设计 §3.10）', async () => {
    const ROUTES_FILE = 'apps/web/src/app/routes.ts'
    const dynamicImport = (path: string): string => `export async function pages() {\n  return import('${path}')\n}\n`
    expect(await rulesFor(dynamicImport('../features/members/index.ts'), ROUTES_FILE)).not.toContain('boundaries/dependencies')
    const members: [string, string][] = [
      // 路由表：静态引用、动态引用内部文件
      [`import { MembersPage } from '../features/members/index.ts'\n\nexport const page = MembersPage\n`, ROUTES_FILE],
      [dynamicImport('../features/members/members-page.tsx'), ROUTES_FILE],
      // 应用层的其他文件、功能模块、入口的再导出
      [dynamicImport('../features/members/index.ts'), WEB_FILE],
      [`import type { MembersPage } from '../members/index.ts'\n\nexport type Page = typeof MembersPage\n`, WEB_FEATURE_FILE],
      [`export { MembersPage } from '../../features/members/index.ts'\n`, PLATFORM_ENTRY],
    ]
    for (const [code, file] of members) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('成员页（features/members）按需加载')
    }
    const importConfirm = (path: string): string => `import { ConfirmDialog } from '${path}'\n\nexport const dialog = ConfirmDialog\n`
    for (const file of ['apps/web/src/features/admin/users-page.tsx', 'apps/web/src/features/members/members-page.tsx'])
      expect(await rulesFor(importConfirm('../confirmation/index.ts'), file), file).not.toContain('boundaries/dependencies')
    const confirmation: [string, string][] = [
      [importConfirm('../confirmation/index.ts'), WEB_FEATURE_FILE],
      [importConfirm('../confirmation/index.ts'), 'apps/web/src/features/spaces/space-page.tsx'],
      [importConfirm('../features/confirmation/index.ts'), WEB_FILE],
      [importConfirm('../../features/confirmation/index.ts'), PLATFORM_ENTRY],
    ]
    for (const [code, file] of confirmation) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('确认的弹窗（features/confirmation，带 Radix Dialog）只由按需加载的功能')
    }
    // 确认的弹窗自己内部的引用不受限（M2-P2 审查 B8）
    expect(await rulesFor('export { ConfirmDialog } from \'./confirm-dialog.tsx\'\n', 'apps/web/src/features/confirmation/index.ts')).not.toContain('boundaries/dependencies')
  })

  it('回收站页与搜索结果页按需加载（M2-P4 设计 §3.7）：只有路由表能动态 import() 它们的公开入口；回收站页可以用确认的弹窗', async () => {
    const ROUTES_FILE = 'apps/web/src/app/routes.ts'
    const dynamicImport = (path: string): string => `export async function pages() {\n  return import('${path}')\n}\n`
    for (const feature of ['trash', 'search'])
      expect(await rulesFor(dynamicImport(`../features/${feature}/index.ts`), ROUTES_FILE), feature).not.toContain('boundaries/dependencies')

    const lazyPages: [string, string, string][] = [
      // 路由表：静态引用、动态引用内部文件
      ['trash', `import { TrashPage } from '../features/trash/index.ts'\n\nexport const page = TrashPage\n`, ROUTES_FILE],
      ['trash', dynamicImport('../features/trash/trash-page.tsx'), ROUTES_FILE],
      // 应用层的其他文件、功能模块、入口的再导出
      ['trash', dynamicImport('../features/trash/index.ts'), WEB_FILE],
      ['trash', `import type { TrashPage } from '../trash/index.ts'\n\nexport type Page = typeof TrashPage\n`, WEB_FEATURE_FILE],
      ['trash', `export { TrashPage } from '../../features/trash/index.ts'\n`, PLATFORM_ENTRY],
      ['search', `import { SearchPage } from '../features/search/index.ts'\n\nexport const page = SearchPage\n`, ROUTES_FILE],
      ['search', dynamicImport('../features/search/search-page.tsx'), ROUTES_FILE],
      ['search', dynamicImport('../features/search/index.ts'), WEB_FILE],
      ['search', `import type { SearchPage } from '../search/index.ts'\n\nexport type Page = typeof SearchPage\n`, WEB_FEATURE_FILE],
      ['search', `export { SearchPage } from '../../features/search/index.ts'\n`, PLATFORM_ENTRY],
    ]
    const names: Readonly<Record<string, string>> = { trash: '回收站页（features/trash）按需加载', search: '搜索结果页（features/search）按需加载' }
    for (const [feature, code, file] of lazyPages) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain(names[feature] ?? '')
    }

    // 回收站页按需加载，所以它可以带确认的弹窗（永久删除要确认）；搜索结果页不带弹窗，引用了照样拦下
    const importConfirm = (path: string): string => `import { ConfirmDialog } from '${path}'\n\nexport const dialog = ConfirmDialog\n`
    const importDialog = (path: string): string => `import { DialogContent } from '${path}'\n\nexport const content = DialogContent\n`
    expect(await rulesFor(importConfirm('../confirmation/index.ts'), 'apps/web/src/features/trash/trash-page.tsx')).not.toContain('boundaries/dependencies')
    expect(await rulesFor(importDialog('../../shared/ui/dialog.tsx'), 'apps/web/src/features/trash/trash-page.tsx')).not.toContain('boundaries/dependencies')
    const denied = await lint(importConfirm('../confirmation/index.ts'), 'apps/web/src/features/search/search-page.tsx')
    expect(denied.rules).toContain('boundaries/dependencies')
    expect(denied.messages.join('\n')).toContain('确认的弹窗（features/confirmation，带 Radix Dialog）只由按需加载的功能')
  })

  it('弹窗的文件（shared/ui/dialog.tsx）与按关键词选一项（features/colleagues）只由按需加载的功能引用（M2-P2 审查 B8）', async () => {
    const importDialog = (path: string): string => `import { DialogContent } from '${path}'\n\nexport const content = DialogContent\n`
    for (const file of ['apps/web/src/features/admin/users-page.tsx', 'apps/web/src/features/members/members-page.tsx', 'apps/web/src/features/confirmation/confirm-dialog.tsx'])
      expect(await rulesFor(importDialog('../../shared/ui/dialog.tsx'), file), file).not.toContain('boundaries/dependencies')
    const dialog: [string, string][] = [
      // 首屏的功能（包括同样按需加载、却不带弹窗的同事选择）、应用层、入口
      [importDialog('../../shared/ui/dialog.tsx'), WEB_FEATURE_FILE],
      [importDialog('../../shared/ui/dialog.tsx'), 'apps/web/src/features/spaces/space-page.tsx'],
      [importDialog('../../shared/ui/dialog.tsx'), 'apps/web/src/features/colleagues/keyword-picker.tsx'],
      [importDialog('../shared/ui/dialog.tsx'), WEB_FILE],
      [`export type { DialogContent } from '../../shared/ui/dialog.tsx'\n`, PLATFORM_ENTRY],
    ]
    for (const [code, file] of dialog) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('弹窗（shared/ui/dialog.tsx，带 Radix Dialog）只由按需加载的功能')
    }
    // 共享层的其他组件照常引用
    expect(await rulesFor('import { Button } from \'../../shared/ui/index.ts\'\n\nexport const button = Button\n', 'apps/web/src/features/spaces/space-page.tsx')).not.toContain('boundaries/dependencies')

    const importPicker = (path: string): string => `import { ColleaguePicker } from '${path}'\n\nexport const picker = ColleaguePicker\n`
    for (const file of ['apps/web/src/features/admin/transfer-page.tsx', 'apps/web/src/features/members/members-page.tsx'])
      expect(await rulesFor(importPicker('../colleagues/index.ts'), file), file).not.toContain('boundaries/dependencies')
    // 同事选择自己内部的引用不受限
    expect(await rulesFor(importPicker('./colleague-picker.tsx'), 'apps/web/src/features/colleagues/index.ts')).not.toContain('boundaries/dependencies')
    const colleagues: [string, string][] = [
      [importPicker('../colleagues/index.ts'), WEB_FEATURE_FILE],
      [importPicker('../colleagues/index.ts'), 'apps/web/src/features/spaces/space-page.tsx'],
      [importPicker('../colleagues/index.ts'), 'apps/web/src/features/confirmation/confirm-dialog.tsx'],
      [`import type { KeywordPickerTexts } from '../features/colleagues/index.ts'\n\nexport type Texts = KeywordPickerTexts\n`, WEB_FILE],
      [`export { ColleaguePicker } from '../../features/colleagues/index.ts'\n`, PLATFORM_ENTRY],
    ]
    for (const [code, file] of colleagues) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('boundaries/dependencies')
      expect(report.messages.join('\n'), file).toContain('按关键词选一项（features/colleagues）只由按需加载的功能')
    }
  })

  it('首屏的限制只管平台页面：编辑器页（它的入口与 sheet-editor）是另一个包，可以引用弹窗、确认的弹窗与同事选择（M2-P2 复验）', async () => {
    const imports = [
      'import { DialogContent } from \'../../shared/ui/dialog.tsx\'\n\nexport const content = DialogContent\n',
      'import { ConfirmDialog } from \'../confirmation/index.ts\'\n\nexport const dialog = ConfirmDialog\n',
      'import { ColleaguePicker } from \'../colleagues/index.ts\'\n\nexport const picker = ColleaguePicker\n',
    ]
    for (const code of imports)
      expect(await rulesFor(code, 'apps/web/src/features/sheet-editor/editor-page.ts'), code).not.toContain('boundaries/dependencies')
    expect((await lintAtProbe(imports[0] ?? '', PROBE_FILES.editorEntry)).rules).not.toContain('boundaries/dependencies')
  })

  it('弹窗类的 Radix 原语只在 shared/ui/dialog.tsx 里引入：命名导入、改名、命名空间导入、export *、动态导入与 @radix-ui/react-dialog 都拦下（M2-P2 复验）', async () => {
    expect(await rulesFor('import { Dialog as DialogPrimitive } from \'radix-ui\'\n\nexport const root = DialogPrimitive.Root\n', 'apps/web/src/shared/ui/dialog.tsx')).not.toContain('no-restricted-syntax')
    // 其他原语照常按名字引入
    expect(await rulesFor('import { Slot } from \'radix-ui\'\n\nexport const slot = Slot\n', 'apps/web/src/features/spaces/space-page.tsx')).not.toContain('no-restricted-syntax')
    const codes = [
      'import { Dialog } from \'radix-ui\'\n\nexport const root = Dialog.Root\n',
      'import { AlertDialog as Alert } from \'radix-ui\'\n\nexport const root = Alert.Root\n',
      'import * as Radix from \'radix-ui\'\n\nexport const root = Radix.Slot\n',
      'export * from \'radix-ui\'\n',
      'export async function load() {\n  return import(\'radix-ui\')\n}\n',
      'import { Root } from \'@radix-ui/react-dialog\'\n\nexport const root = Root\n',
    ]
    for (const code of codes) {
      const report = await lint(code, 'apps/web/src/features/spaces/space-page.tsx')
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(RADIX_DIALOG_MESSAGE)
    }
  })

  it('弹窗类的 Radix 原语的限制对 web 的每类文件都生效：功能、应用层、平台页面的入口、共享层、编辑器适配层与内部 API 各有自己的配置块，都带上这组限制（M2-P2 复验）', async () => {
    const code = 'import { Dialog } from \'radix-ui\'\n\nexport const root = Dialog.Root\n'
    for (const file of ['apps/web/src/features/spaces/space-page.tsx', WEB_FILE, PLATFORM_ENTRY, WEB_SHARED_FILE, 'apps/web/src/editor/index.ts', 'apps/web/src/editor/internal-api/registry.ts']) {
      const report = await lint(code, file)
      expect(report.rules, file).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), file).toContain(RADIX_DIALOG_MESSAGE)
    }
  })

  it('SDK 的 DOM 标记（data-u-comp）只在 internal-api 里写：编辑器、平台代码、入口与弹窗的文件里的字符串、模板、JSX 属性与 dataset.uComp 都失败；internal-api 与测试代码不受限（P3 审查 A8）', async () => {
    const DOM_MARKER_MESSAGE = 'SDK 的 DOM 标记（data-u-comp）只在 apps/web/src/editor/internal-api/ 里写并登记'
    const codes = [
      'export const selector = \'[data-u-comp="formula-bar"]\'\n',
      'export const selector = `[data-u-comp="formula-bar"]`\n',
      `export const selector = \`[data-u-comp="\${String(1)}"]\`\n`,
      'export function comp(element: HTMLElement): string | undefined {\n  return element.dataset.uComp\n}\n',
      'export function comp(element: HTMLElement): string | null {\n  return element.getAttribute(\'data-u-comp\')\n}\n',
    ]
    const jsx = 'export function Fake() {\n  return <div data-u-comp="formula-bar" />\n}\n'
    const files = ['apps/web/src/editor/sheet-editor.ts', 'apps/web/src/editor/read-only/formula-bar.ts', WEB_FEATURE_FILE, WEB_SHARED_FILE, WEB_FILE, PLATFORM_ENTRY, 'apps/web/src/shared/ui/dialog.tsx']
    for (const file of files) {
      for (const code of file.endsWith('.tsx') ? [...codes, jsx] : codes) {
        const report = await lint(code, file)
        expect(report.rules, `${file}\n${code}`).toContain('no-restricted-syntax')
        expect(report.messages.join('\n'), `${file}\n${code}`).toContain(DOM_MARKER_MESSAGE)
      }
    }
    // internal-api（逐项登记的出口）与测试代码（按 SDK 的结构造元素）不受限
    for (const file of ['apps/web/src/editor/internal-api/dom-markers.ts', 'apps/web/src/editor/read-only/formula-bar.test.ts', WEB_TEST_FILE]) {
      for (const code of codes)
        expect((await lint(code, file)).messages.join('\n'), `${file}\n${code}`).not.toContain(DOM_MARKER_MESSAGE)
    }
    // 只是含有相近字样的普通字符串不算
    expect((await lint('export const word = \'uComposer data-u-component-x\'\n', WEB_FEATURE_FILE)).messages.join('\n')).not.toContain(DOM_MARKER_MESSAGE)
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

  it('documents 的仓储只在 documents 模块里用：公开入口转出它只为 app 层的程序接口，别的模块、app 层的其他文件引用都失败（M2-P6 复核 A 的 S3）', async () => {
    const REPOSITORY_MESSAGE = 'documents 的仓储（DocumentsRepository）只在 documents 模块里使用'
    expect(await rulesFor('export { DocumentsRepository } from \'../modules/documents/index.ts\'\n', 'apps/api/src/app/index.ts')).not.toContain('no-restricted-imports')
    expect(await rulesFor('import { DocumentsRepository } from \'./documents.repository.ts\'\n\nexport const repository = DocumentsRepository\n', 'apps/api/src/modules/documents/document-search.service.ts')).not.toContain('no-restricted-imports')
    const importRepository = 'import { DocumentsRepository } from \'../documents/index.ts\'\n\nexport const repository = DocumentsRepository\n'
    const violations: [string, string][] = [
      [importRepository, 'apps/api/src/modules/workspace/space-directory.service.ts'],
      [importRepository, 'apps/api/src/modules/admin/admin-transfer.service.ts'],
      [importRepository, 'apps/api/src/modules/jobs/trash-purge.job.ts'],
      ['import { DocumentsRepository } from \'../modules/documents/index.ts\'\n\nexport const repository = DocumentsRepository\n', 'apps/api/src/app/app.module.ts'],
      ['export { DocumentsRepository } from \'../documents/index.ts\'\n', 'apps/api/src/modules/spaces/index.ts'],
    ]
    for (const [code, file] of violations) {
      const report = await lint(code, file)
      expect(report.rules, `${file}：${code}`).toContain('no-restricted-imports')
      expect(report.messages.join('\n'), `${file}：${code}`).toContain(REPOSITORY_MESSAGE)
    }
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

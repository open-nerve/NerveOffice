// lint 规则的自测（编辑器适配层的内部 API，P4 设计 §3.6.9）：内部符号只经 internal-api 引用并登记、取注入器只在 internal-api 里、
// 引用 Univer 的各种写法（类型里的 import()、import.meta.glob、三斜杠、node_modules 里的路径、深层路径、动态导入）。
// 编辑器的另一半（谁能引用编辑器、SDK 的 DOM 标记、值引用的白名单、E2E 探针、内部 API 的出口）在 lint-rules-editor-public.test.ts：
// 编辑器里的每段代码都要按 Univer 的类型做类型检查，是最贵的一块，分成两个文件并行（M2-P6 第 6 片复核 M1）。
// 共用的准备与时限见 lint-harness.test-support.ts
import { describe, expect, it } from 'vitest'
import {
  API_SERVICE,
  CONTRACTS_FILE,
  EDITOR_FILE,
  INTERNAL_API_FILE,
  INTERNAL_MESSAGE,
  LINT_TIMEOUT,
  prepareLint,
  restrictedImports,
  WEB_FILE,
} from './lint-harness.test-support.ts'

const { lint, rulesFor, configFor } = prepareLint({ warmUp: [WEB_FILE, API_SERVICE, CONTRACTS_FILE] })

const GUARD_FILE = 'apps/web/src/editor/read-only/read-only-guard.ts'

describe('US-M1-11 lint 规则的自测：内部 API 只经 internal-api 引用（P4 设计 §3.6.9）', () => {
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

  describe('只读加固用到的内部符号（M2-P3 设计 §3.6）在 internal-api 之外引用会失败：只读守卫所在的位置也一样，命名空间导入与再导出同样拦下', () => {
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

    it.each([EDITOR_FILE, GUARD_FILE])('%s', async (file) => {
      for (const code of cases) {
        const report = await lint(code, file)
        expect(report.rules, code).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), code).toContain(INTERNAL_MESSAGE)
      }
    })

    it('包里的其他导出照常引用（插件与公开的类型）', async () => {
      expect(await rulesFor('import { UniverSheetsPlugin } from \'@univerjs/sheets\'\n\nexport const p = UniverSheetsPlugin\n', EDITOR_FILE)).not.toContain('no-restricted-imports')
    })
  })

  describe('只读守卫设图片不可编辑的服务（M2-P3 S3 之后的修复）在 internal-api 之外引用会失败；决定不用的表格图片服务同样受限；插件照常引用', () => {
    const cases = [
      'import { IDrawingManagerService } from \'@univerjs/drawing\'\n\nexport const s = IDrawingManagerService\n',
      'import type { IDrawingManagerService } from \'@univerjs/drawing\'\n\nexport type S = IDrawingManagerService\n',
      'export { IDrawingManagerService as Drawings } from \'@univerjs/drawing\'\n',
      'import * as drawing from \'@univerjs/drawing\'\n\nexport const d = drawing\n',
      'import { ISheetDrawingService } from \'@univerjs/sheets-drawing\'\n\nexport const s = ISheetDrawingService\n',
    ]

    it.each([EDITOR_FILE, GUARD_FILE])('%s', async (file) => {
      for (const code of cases) {
        const report = await lint(code, file)
        expect(report.rules, code).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), code).toContain(INTERNAL_MESSAGE)
      }
    })

    it('插件照常引用；internal-api 里照常引用', async () => {
      const plugins = 'import { UniverDrawingPlugin } from \'@univerjs/drawing\'\nimport { UniverSheetsDrawingPlugin } from \'@univerjs/sheets-drawing\'\n\nexport const p = [UniverDrawingPlugin, UniverSheetsDrawingPlugin]\n'
      expect(await rulesFor(plugins, 'apps/web/src/editor/profile/sheet-profile.ts')).not.toContain('no-restricted-imports')
      expect(await rulesFor('import { IDrawingManagerService } from \'@univerjs/drawing\'\n\nexport const s = IDrawingManagerService\n', INTERNAL_API_FILE)).not.toContain('no-restricted-imports')
    })
  })

  describe('只读守卫放开编辑栏、拦下冻结线用到的内部符号（P3 审查 A1、B2）在 internal-api 之外引用会失败；这几个包的插件照常引用', () => {
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

    it.each([EDITOR_FILE, 'apps/web/src/editor/read-only/formula-bar.ts'])('%s', async (file) => {
      for (const code of cases) {
        const report = await lint(code, file)
        expect(report.rules, code).toContain('no-restricted-imports')
        expect(report.messages.join('\n'), code).toContain(INTERNAL_MESSAGE)
      }
    })

    it('插件照常引用；internal-api 里照常引用', async () => {
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
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：取注入器只在 internal-api 里', () => {
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
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：引用 Univer 的写法', () => {
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

  describe('按 node_modules 里的路径引用依赖会失败：静态导入、再导出与动态导入都算，编辑器与 internal-api 也一样（审查 B4）', () => {
    const NODE_MODULES_MESSAGE = '按包名引用依赖，不要写 node_modules 里的路径'
    const source = '../../../node_modules/@univerjs/engine-formula/lib/es/index.js'

    // 每条只检查一段：按 node_modules 里的路径引用时，类型检查要解析 Univer 包里的文件，一段就要半秒到一秒（本机单独跑最慢 1.1 秒）
    const forms: Readonly<Record<string, string>> = { 静态导入: `import * as formula from '${source}'\n\nexport const f = formula\n`, 再导出: `export * from '${source}'\n` }
    it.each([EDITOR_FILE, INTERNAL_API_FILE, WEB_FILE, API_SERVICE, CONTRACTS_FILE].flatMap(file => Object.entries(forms).map(([form, code]) => [form, file, code] as const)))('%s：%s', async (_form, file, code) => {
      const report = await lint(code, file)
      expect(report.rules).toContain('no-restricted-imports')
      expect(report.messages.join('\n')).toContain(NODE_MODULES_MESSAGE)
    })

    it('动态导入；名字里带 node_modules 字样的普通模块不算', async () => {
      for (const file of [EDITOR_FILE, WEB_FILE]) {
        const report = await lint(`export async function load(): Promise<unknown> {\n  return import('${source}')\n}\n`, file)
        expect(report.rules, file).toContain('no-restricted-syntax')
        expect(report.messages.join('\n'), file).toContain(NODE_MODULES_MESSAGE)
      }
      expect(await rulesFor('import { probe } from \'./my-node_modules-notes.ts\'\n\nexport const p = probe\n', WEB_FILE)).not.toContain('no-restricted-imports')
    })
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

  it('internal-api 里不用动态 import()：同目录的文件、绕路的相对路径、别的包都报错，登记表的扫描只认静态的导入导出（M2-P6 第二次复验 S1）；静态引用与 internal-api 之外的动态引入照常', async () => {
    const MESSAGE = '内部 API（editor/internal-api/）里不用动态 import()'
    const load = (source: string): string => `export async function load(): Promise<unknown> {\n  return import('${source}')\n}\n`
    // 复验者的变异三：injector.ts 动态引入同目录的新文件
    for (const source of ['./helper.ts', '../internal-api/dom-markers.ts', 'zod']) {
      const report = await lint(load(source), 'apps/web/src/editor/internal-api/injector.ts')
      expect(report.rules, source).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), source).toContain(MESSAGE)
    }
    expect(await rulesFor('export { injectorOf } from \'./injector.ts\'\n', INTERNAL_API_FILE)).not.toContain('no-restricted-syntax')
    // internal-api 之外不受这一条限制（编辑器动态引入探针）
    expect((await lint(load('./testing/e2e-probe.ts'), EDITOR_FILE)).messages.join('\n')).not.toContain(MESSAGE)
  })
}, LINT_TIMEOUT)

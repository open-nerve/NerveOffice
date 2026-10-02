// lint 规则的自测（编辑器适配层对外的边界）：谁能引用编辑器（P4 设计 §3.1）、SDK 的 DOM 标记只在 internal-api 里写、
// @univerjs/* 值引用的白名单、E2E 探针只能动态引入、内部 API 只经两个出口。另一半（内部符号、取注入器、引用 Univer 的写法）在
// lint-rules-editor-internal.test.ts。共用的准备与时限见 lint-harness.test-support.ts
import type { RestrictedImports } from './lint-harness.test-support.ts'
import { describe, expect, it } from 'vitest'
import {
  EDITOR_FILE,
  INTERNAL_API_FILE,
  INTERNAL_MESSAGE,
  LINT_TIMEOUT,
  PLATFORM_ENTRY,
  prepareLint,
  PROBE_FILES,
  restrictedImports,
  WEB_FEATURE_FILE,
  WEB_FILE,
  WEB_SHARED_FILE,
  WEB_TEST_FILE,
} from './lint-harness.test-support.ts'

const { lint, rulesFor, lintAtProbe, configFor } = prepareLint({ warmUp: [WEB_FILE], probes: true })

const GUARD_FILE = 'apps/web/src/editor/read-only/read-only-guard.ts'

describe('US-M1-11 lint 规则的自测：谁能引用编辑器（P4 设计 §3.1）', () => {
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
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：SDK 的 DOM 标记（data-u-comp）只在 internal-api 里写（P3 审查 A8）', () => {
  const DOM_MARKER_MESSAGE = 'SDK 的 DOM 标记（data-u-comp）只在 apps/web/src/editor/internal-api/ 里写并登记'
  const codes = [
    'export const selector = \'[data-u-comp="formula-bar"]\'\n',
    'export const selector = `[data-u-comp="formula-bar"]`\n',
    `export const selector = \`[data-u-comp="\${String(1)}"]\`\n`,
    'export function comp(element: HTMLElement): string | undefined {\n  return element.dataset.uComp\n}\n',
    'export function comp(element: HTMLElement): string | null {\n  return element.getAttribute(\'data-u-comp\')\n}\n',
  ]
  const jsx = 'export function Fake() {\n  return <div data-u-comp="formula-bar" />\n}\n'

  it.each(['apps/web/src/editor/sheet-editor.ts', 'apps/web/src/editor/read-only/formula-bar.ts', WEB_FEATURE_FILE, WEB_SHARED_FILE, WEB_FILE, PLATFORM_ENTRY, 'apps/web/src/shared/ui/dialog.tsx'])('编辑器、平台代码、入口与弹窗的文件里的字符串、模板、JSX 属性与 dataset.uComp 都失败：%s', async (file) => {
    for (const code of file.endsWith('.tsx') ? [...codes, jsx] : codes) {
      const report = await lint(code, file)
      expect(report.rules, code).toContain('no-restricted-syntax')
      expect(report.messages.join('\n'), code).toContain(DOM_MARKER_MESSAGE)
    }
  })

  // internal-api（逐项登记的出口）与测试代码（按 SDK 的结构造元素）不受限
  it.each(['apps/web/src/editor/internal-api/dom-markers.ts', 'apps/web/src/editor/read-only/formula-bar.test.ts', WEB_TEST_FILE])('internal-api 与测试代码不受限：%s', async (file) => {
    for (const code of codes)
      expect((await lint(code, file)).messages.join('\n'), code).not.toContain(DOM_MARKER_MESSAGE)
  })

  it('只是含有相近字样的普通字符串不算', async () => {
    expect((await lint('export const word = \'uComposer data-u-component-x\'\n', WEB_FEATURE_FILE)).messages.join('\n')).not.toContain(DOM_MARKER_MESSAGE)
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：对 @univerjs/* 的值引用只允许白名单里的公开符号（M2-P6 复核 F4）', () => {
  const PUBLIC_VALUE_MESSAGE = '对 @univerjs/* 的值引用只允许白名单（eslint.config.ts 的 UNIVER_PUBLIC_VALUES）里的公开符号'
  /** 编辑器里 internal-api 与测试代码之外的几类文件：编辑器的组装、只读守卫、测试构建的探针、公式 Worker */
  const OUTSIDE_INTERNAL_API = [EDITOR_FILE, GUARD_FILE, 'apps/web/src/editor/testing/e2e-probe.ts', 'apps/web/src/editor/workers/formula.worker.ts']

  it('白名单里的通过：插件类、Univer 与 FUniver、枚举、mergeLocales、主题、语言包的默认导出；副作用导入（Facade、样式）不受限', async () => {
    const code = [
      'import { CommandType, LifecycleStages, LocaleType, LogLevel, mergeLocales, Univer } from \'@univerjs/core\'',
      'import { FUniver } from \'@univerjs/core/facade\'',
      'import { DeviceInputEventType, UniverRenderEnginePlugin } from \'@univerjs/engine-render\'',
      'import { UniverRemoteSheetsFormulaPlugin, UniverSheetsFormulaPlugin } from \'@univerjs/sheets-formula\'',
      'import SheetsZhCN from \'@univerjs/sheets/locale/zh-CN\'',
      'import { defaultTheme } from \'@univerjs/themes\'',
      'import { KeyCode, UniverUIPlugin } from \'@univerjs/ui\'',
      'import \'@univerjs/sheets/facade\'',
      'import \'@univerjs/sheets-filter/facade\'',
      'import \'@univerjs/design/lib/index.css\'',
      '',
      'export const used = [CommandType, LifecycleStages, LocaleType, LogLevel, mergeLocales, Univer, FUniver, DeviceInputEventType, UniverRenderEnginePlugin, UniverRemoteSheetsFormulaPlugin, UniverSheetsFormulaPlugin, SheetsZhCN, defaultTheme, KeyCode, UniverUIPlugin]',
      '',
    ].join('\n')
    for (const file of OUTSIDE_INTERNAL_API)
      expect(await rulesFor(code, file), file).not.toContain('no-restricted-imports')
  })

  // 没登记的内部符号报错：命名导入、改名、默认导入、命名空间导入、再导出与 export * 都算，没列出的包与包里没列出的出口也算
  it.each([
    // 审查者的变异：sheets 导出的权限检查控制器不在登记的清单里，原来只报了导入顺序
    ['命名导入', 'import { SheetPermissionCheckController } from \'@univerjs/sheets\'\n\nexport const c = SheetPermissionCheckController\n'],
    ['改名', 'import { ICommandService as Commands } from \'@univerjs/core\'\n\nexport const c = Commands\n'],
    ['ui 包里的服务', 'import { ILayoutService } from \'@univerjs/ui\'\n\nexport const s = ILayoutService\n'],
    ['默认导入', 'import Sheets from \'@univerjs/sheets\'\n\nexport const s = Sheets\n'],
    ['命名空间导入', 'import * as filter from \'@univerjs/sheets-filter\'\n\nexport const f = filter\n'],
    ['再导出', 'export { SheetPermissionCheckController } from \'@univerjs/sheets\'\n'],
    ['export *', 'export * from \'@univerjs/sheets-filter\'\n'],
    ['包里没列出的出口', 'import { FRange } from \'@univerjs/sheets/facade\'\n\nexport const r = FRange\n'],
    ['没列出的包', 'import { UniverSheetsTablePlugin } from \'@univerjs/sheets-table\'\n\nexport const p = UniverSheetsTablePlugin\n'],
    ['语言包的命名导出', 'import { zhCN } from \'@univerjs/sheets/locale/zh-CN\'\n\nexport const l = zhCN\n'],
  ])('没登记的值引用报错：%s', async (_kind, code) => {
    for (const file of OUTSIDE_INTERNAL_API) {
      const report = await lint(code, file)
      expect(report.rules, file).toContain('no-restricted-imports')
      expect(report.messages.join('\n'), file).toContain(PUBLIC_VALUE_MESSAGE)
    }
  })

  it('登记过的内部符号的值引用：清单与白名单各报一条', async () => {
    const registered = await lint('import { IPermissionService } from \'@univerjs/core\'\n\nexport const s = IPermissionService\n', EDITOR_FILE)
    expect(registered.messages.join('\n')).toContain(INTERNAL_MESSAGE)
    expect(registered.messages.join('\n')).toContain(PUBLIC_VALUE_MESSAGE)
  })

  it.each(OUTSIDE_INTERNAL_API)('类型引用通过（没登记的内部符号的类型、没列出的出口的类型、export type）：%s', async (file) => {
    const types = [
      'import type { SheetPermissionCheckController } from \'@univerjs/sheets\'\n\nexport type C = SheetPermissionCheckController\n',
      'import type { IShortcutItem } from \'@univerjs/ui\'\n\nexport type S = IShortcutItem\n',
      'import type { FRange } from \'@univerjs/sheets/facade\'\n\nexport type R = FRange\n',
      // 命名空间的类型导入：包里有登记过的内部符号时（例如 @univerjs/sheets）仍由清单拦下，见下面
      'import type * as Filter from \'@univerjs/sheets-filter\'\n\nexport type F = Filter.FilterModel\n',
      'export type { ICommandInfo } from \'@univerjs/core\'\n',
    ]
    for (const code of types)
      expect(await rulesFor(code, file), code).not.toContain('no-restricted-imports')
  })

  it('登记过的内部符号的类型仍由清单拦下', async () => {
    for (const code of ['import type { IUndoRedoService } from \'@univerjs/core\'\n\nexport type U = IUndoRedoService\n', 'import type * as Sheets from \'@univerjs/sheets\'\n\nexport type W = Sheets.SheetInterceptorService\n']) {
      const registeredType = await lint(code, EDITOR_FILE)
      expect(registeredType.messages.join('\n'), code).toContain(INTERNAL_MESSAGE)
      expect(registeredType.messages.join('\n'), code).not.toContain(PUBLIC_VALUE_MESSAGE)
    }
  })

  it('internal-api 里不受限；测试代码不受白名单限制（登记过的内部符号仍由清单拦下）', async () => {
    const unregistered = 'import { SheetPermissionCheckController } from \'@univerjs/sheets\'\nimport { ICommandService } from \'@univerjs/core\'\n\nexport const used = [SheetPermissionCheckController, ICommandService]\n'
    for (const file of [INTERNAL_API_FILE, 'apps/web/src/editor/internal-api/ui.ts'])
      expect(await rulesFor(unregistered, file), file).not.toContain('no-restricted-imports')
    const testFile = 'apps/web/src/editor/read-only/freeze-handles.test.ts'
    expect(await rulesFor('import { createInterceptorKey, InterceptorManager } from \'@univerjs/core\'\n\nexport const used = [createInterceptorKey, InterceptorManager]\n', testFile)).not.toContain('no-restricted-imports')
    expect((await lint('import { IPermissionService } from \'@univerjs/core\'\n\nexport const s = IPermissionService\n', testFile)).messages.join('\n')).toContain(INTERNAL_MESSAGE)
  })

  it('编辑器里 internal-api 与测试代码之外的每个文件都带着白名单；internal-api 与测试代码没有', async () => {
    const allowed = (paths: RestrictedImports['paths']): string[] => (paths ?? []).filter(path => 'allowImportNames' in path).map(path => path.name)
    for (const file of [...OUTSIDE_INTERNAL_API, 'apps/web/src/editor/index.ts', 'apps/web/src/editor/profile/sheet-profile.ts', 'apps/web/src/editor/profile/locale.ts']) {
      const names = allowed(restrictedImports(await configFor(file)).paths)
      expect(names, file).toEqual(expect.arrayContaining(['@univerjs/core', '@univerjs/core/facade', '@univerjs/sheets', '@univerjs/ui']))
    }
    for (const file of [INTERNAL_API_FILE, 'apps/web/src/editor/read-only/read-only-guard.test.ts', 'apps/web/src/editor/testing/e2e-probe.test.ts'])
      expect(allowed(restrictedImports(await configFor(file)).paths), file).toEqual([])
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：编辑器的 E2E 探针（editor/testing/**）只能动态引入（M2-P6 复核 F5）', () => {
  const PROBE_MESSAGE = '编辑器的 E2E 探针（editor/testing/**）只在测试构建里，只能经动态 import() 引入'
  const RULE = 'ts/no-restricted-imports'

  it('静态导入、import type、副作用导入、再导出与 export * 都报错：编辑器的组装、公开入口、只读守卫与 internal-api 都一样', async () => {
    const cases: (readonly [string, string])[] = [
      [EDITOR_FILE, 'import { installEditorProbe } from \'./testing/e2e-probe.ts\'\n\nexport const install = installEditorProbe\n'],
      [EDITOR_FILE, 'import type { EditorProbe } from \'./testing/e2e-probe.ts\'\n\nexport type P = EditorProbe\n'],
      [EDITOR_FILE, 'import \'./testing/probe-facades.ts\'\n\nexport const a = 1\n'],
      ['apps/web/src/editor/index.ts', 'export { installEditorProbe } from \'./testing/e2e-probe.ts\'\n'],
      ['apps/web/src/editor/index.ts', 'export * from \'./testing/e2e-probe.ts\'\n'],
      [GUARD_FILE, 'import \'../testing/probe-facades.ts\'\n\nexport const a = 1\n'],
      [INTERNAL_API_FILE, 'export { installEditorProbe } from \'../testing/e2e-probe.ts\'\n'],
      // 大小写不同（不区分大小写的文件系统上照样找得到）
      [EDITOR_FILE, 'import \'./Testing/probe-facades.ts\'\n\nexport const a = 1\n'],
    ]
    for (const [file, code] of cases) {
      const report = await lint(code, file)
      expect(report.rules, `${file}\n${code}`).toContain(RULE)
      expect(report.messages.join('\n'), `${file}\n${code}`).toContain(PROBE_MESSAGE)
    }
  })

  it('动态 import() 通过；testing/ 里的文件之间照常静态引用；测试代码不受限；同一份限制里仍拦着测试与测试辅助', async () => {
    const load = 'export async function load(): Promise<unknown> {\n  return import(\'./testing/e2e-probe.ts\')\n}\n'
    expect(await rulesFor(load, EDITOR_FILE)).not.toContain(RULE)
    expect(await rulesFor('import \'./probe-facades.ts\'\n\nexport const a = 1\n', 'apps/web/src/editor/testing/e2e-probe.ts')).not.toContain(RULE)
    expect(await rulesFor('import { installEditorProbe } from \'./testing/e2e-probe.ts\'\n\nexport const install = installEditorProbe\n', 'apps/web/src/editor/sheet-editor.test.ts')).not.toContain(RULE)
    // 这一块覆盖了 nerve/test-code-only-in-tests 的同名规则：测试辅助照样拦下
    const report = await lint('import { UNIT } from \'./change-tracking/formula-sequences.test-support.ts\'\n\nexport const unit = UNIT\n', EDITOR_FILE)
    expect(report.rules).toContain(RULE)
    expect(report.messages.join('\n')).toContain('测试与测试辅助')
    // 别的目录里叫 testing 的包名不算（只认路径里的 testing 这一段）
    expect(await rulesFor('import { render } from \'@testing-library/react\'\n\nexport const r = render\n', EDITOR_FILE)).not.toContain(RULE)
  })
}, LINT_TIMEOUT)

describe('US-M1-11 lint 规则的自测：内部 API 只经两个出口引用：internal-api/index.ts 与 ui.ts（M2-P6 复验 N4）', () => {
  const EXITS_MESSAGE = '内部 API 只经两个出口引用：internal-api/index.ts 与 ui.ts'
  const RULE = 'import-x/no-restricted-paths'

  it('internal-api 之外引用里面别的文件报错：静态导入、import type、再导出与动态 import() 都算，路径换个写法也一样，测试代码也不例外', async () => {
    const cases: (readonly [string, string])[] = [
      // 复验者的变异：只读守卫绕过出口，直接引用 formula-protocol.ts
      [GUARD_FILE, 'import { FORMULA_PROTOCOL } from \'../internal-api/formula-protocol.ts\'\n\nexport const p = FORMULA_PROTOCOL\n'],
      [GUARD_FILE, 'import type { FORMULA_PROTOCOL } from \'../internal-api/formula-protocol.ts\'\n\nexport type P = typeof FORMULA_PROTOCOL\n'],
      [EDITOR_FILE, 'export { injectorOf } from \'./internal-api/injector.ts\'\n'],
      [EDITOR_FILE, 'export async function load(): Promise<unknown> {\n  return import(\'./internal-api/dom-markers.ts\')\n}\n'],
      [GUARD_FILE, 'import { FORMULA_PROTOCOL } from \'../internal-api/./formula-protocol.ts\'\n\nexport const p = FORMULA_PROTOCOL\n'],
      [GUARD_FILE, 'import { FORMULA_PROTOCOL } from \'../read-only/../internal-api/formula-protocol.ts\'\n\nexport const p = FORMULA_PROTOCOL\n'],
      [GUARD_FILE, 'import { INTERNAL_API_REGISTRY } from \'../internal-api/registry.ts\'\n\nexport const r = INTERNAL_API_REGISTRY\n'],
      ['apps/web/src/editor/read-only/read-only-guard.test.ts', 'import { FORMULA_PROTOCOL } from \'../internal-api/formula-protocol.ts\'\n\nexport const p = FORMULA_PROTOCOL\n'],
    ]
    for (const [file, code] of cases) {
      const report = await lint(code, file)
      expect(report.rules, `${file}\n${code}`).toContain(RULE)
      expect(report.messages.join('\n'), `${file}\n${code}`).toContain(EXITS_MESSAGE)
    }
  })

  it('两个出口照常引用；internal-api 里的文件之间照常引用', async () => {
    const exits = [
      'import { FORMULA_PROTOCOL } from \'../internal-api/index.ts\'\n\nexport const p = FORMULA_PROTOCOL\n',
      'import { IEditorService } from \'../internal-api/ui.ts\'\n\nexport const s = IEditorService\n',
    ]
    for (const code of exits)
      expect(await rulesFor(code, GUARD_FILE), code).not.toContain(RULE)
    expect(await rulesFor('export { FORMULA_PROTOCOL } from \'./formula-protocol.ts\'\n', INTERNAL_API_FILE)).not.toContain(RULE)
  })
}, LINT_TIMEOUT)

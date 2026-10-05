import { describe, expect, it } from 'vitest'
import cellLinksSource from './cell-links.ts?raw'
import domMarkersSource from './dom-markers.ts?raw'
import formulaProtocolSource from './formula-protocol.ts?raw'
import * as internalApi from './index.ts'
import source from './index.ts?raw'
import injectorSource from './injector.ts?raw'
import { INTERNAL_API_REGISTRY } from './registry.ts'
import registrySource from './registry.ts?raw'
import resourceLoadGuardSource from './resource-load-guard.ts?raw'
import * as uiApi from './ui.ts'
import uiSource from './ui.ts?raw'

/** 出口只写再导出（export { … } from、export type { … } from），从源码里取出导出的名字与来源；有别的写法就报出来 */
function reExports(text: string): { names: string[], sources: string[], unexpected: string[] } {
  const names: string[] = []
  const sources: string[] = []
  const unexpected: string[] = []
  const statements = text.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('//'))
  for (const line of statements) {
    const match = /^export (?:type )?\{([^}]+)\} from '([^']+)'$/.exec(line.trim())
    if (match === null) {
      unexpected.push(line)
      continue
    }
    sources.push(match[2] ?? '')
    for (const specifier of (match[1] ?? '').split(',')) {
      const name = specifier.trim().split(/\s+as\s+/).at(-1)
      if (name !== undefined && name !== '')
        names.push(name)
    }
  }
  return { names, sources, unexpected }
}

/**
 * 界面的包（包本身与它的子路径，例如 @univerjs/sheets-ui/facade）：公式 Worker 引用 index.ts，这些包从那里（或从它走得到的文件里）
 * 引用会整包打进 Worker
 */
const UI_PACKAGE = /^@univerjs\/(?:[\w-]+-ui|ui|design|engine-render)(?:\/|$)/

// ---- 扫描 internal-api 里每个文件对 @univerjs/* 的引用（M2-P6 复验 N4）----
// 出口直接再导出的符号由"导出与登记一一对应"管着；出口之外的文件（封装的实现）引用的 SDK 符号，要列在它所实现的登记项的 sdk 里。
// 扫描的范围是 internal-api 目录下的全部文件（测试与测试辅助除外），三处合起来保证：
// - 文件的清单 SOURCES 写在这里（web 的测试拿不到 node:fs，lint 又不许 import.meta.glob），它与目录里的文件逐个对得上由 tools 侧的
//   测试核对（tools/src/lint/internal-api-sources.test.ts 递归列出目录，多了少了都失败；子目录里的文件同样列出）；
// - 文件之间的引用只认静态的导入导出语句，路径只能写成 ./<文件名>（同目录）：子目录、../ 绕路等别的相对路径报为认不出的写法；
//   动态 import() 由 lint 在 internal-api 里禁止（nerve/editor-internal-api，扫描认不出它引入了哪个文件、用了哪些名字）；
// - 从两个出口出发、顺着同目录的引用走到的每个文件都要在清单里，清单里也不能有走不到的文件（登记表本身除外）。internal-api 之外
//   只能经两个出口引用（lint 的 nerve/editor-internal-api-exits），所以走得到的就是会进产物的全部

/** internal-api 里的源文件（测试与测试辅助除外）：文件名 → 源码。与目录里的文件一致（tools/src/lint/internal-api-sources.test.ts 核对） */
const SOURCES: Readonly<Record<string, string>> = {
  'index.ts': source,
  'ui.ts': uiSource,
  'cell-links.ts': cellLinksSource,
  'dom-markers.ts': domMarkersSource,
  'formula-protocol.ts': formulaProtocolSource,
  'injector.ts': injectorSource,
  'registry.ts': registrySource,
  'resource-load-guard.ts': resourceLoadGuardSource,
}
/** 两个出口 */
const EXITS: readonly string[] = ['index.ts', 'ui.ts']
/** 登记表本身：只被测试引用，不从出口导出 */
const REGISTRY_FILE = 'registry.ts'

/** 一处对 Univer 的包的引用：包名与导入名 */
interface SdkReference {
  readonly from: string
  readonly name: string
}

/** 引用同目录的一个文件：从它再导出的名字（只是导入时为空） */
interface LocalReference {
  readonly file: string
  readonly reExported: readonly string[]
}

interface Scanned {
  readonly sdk: readonly SdkReference[]
  /** 从 SDK 直接再导出时用的名字（出口里的这些就是登记项本身） */
  readonly sdkReExported: readonly string[]
  readonly local: readonly LocalReference[]
  /**
   * 认不出的写法：对 SDK 与同目录文件的默认导入、命名空间导入、export *、副作用导入；./<文件名> 之外的相对路径（子目录、../ 绕路，
   * 认不出是哪个文件）；以及提到 Univer 的包或相对路径、而没认出的导入导出语句
   */
  readonly unexpected: readonly string[]
}

/** import 与 export … from 的语句（格式化之后每条从行首开始；花括号里的名字可以跨行） */
const FROM_STATEMENT = /^(import|export)\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+'([^']+)'/gm
/** 副作用导入 */
const SIDE_EFFECT_IMPORT = /^import\s+'([^']+)'/gm
/** 提到 Univer 的包或相对路径的导入导出语句的第一行（与上面两种比对，找出没认出的写法） */
const MODULE_STATEMENT_LINE = /^(?:import|export)\b[^\n]*'(?:@univerjs\/|\.)[^\n]*$/gm
const SDK_SOURCE = /^@univerjs\//
/** 同目录的文件：只认 ./<文件名> */
const LOCAL_SOURCE = /^\.\/([^/]+)$/
/** 相对路径：不是 ./<文件名> 的（./sub/x.ts、../internal-api/x.ts 等）认不出是哪个文件，报出来 */
const RELATIVE_SOURCE = /^\./

/** 花括号里的名字：导入名与导出时用的名字（as 之后的），去掉行内的 type；不是花括号时返回 undefined */
function specifiersOf(clause: string): { readonly name: string, readonly alias: string }[] | undefined {
  const braces = /^\{([^}]*)\}$/.exec(clause.trim())
  if (braces === null)
    return undefined
  return (braces[1] ?? '').split(',').map(part => part.trim()).filter(part => part !== '').map((part) => {
    const [name = '', alias] = part.replace(/^type\s+/, '').split(/\s+as\s+/)
    return { name, alias: alias ?? name }
  })
}

function scan(text: string): Scanned {
  const sdk: SdkReference[] = []
  const sdkReExported: string[] = []
  const local: LocalReference[] = []
  const unexpected: string[] = []
  const recognized = new Set<number>()
  for (const match of text.matchAll(FROM_STATEMENT)) {
    recognized.add(match.index)
    const [statement, keyword = '', clause = '', from = ''] = match
    const specifiers = specifiersOf(clause)
    const localFile = LOCAL_SOURCE.exec(from)?.[1]
    if (localFile === undefined && RELATIVE_SOURCE.test(from)) {
      unexpected.push(statement)
      continue
    }
    if (!SDK_SOURCE.test(from) && localFile === undefined)
      continue
    if (specifiers === undefined) {
      unexpected.push(statement)
    }
    else if (localFile === undefined) {
      sdk.push(...specifiers.map(({ name }) => ({ from, name })))
      if (keyword === 'export')
        sdkReExported.push(...specifiers.map(({ alias }) => alias))
    }
    else {
      local.push({ file: localFile, reExported: keyword === 'export' ? specifiers.map(({ alias }) => alias) : [] })
    }
  }
  for (const match of text.matchAll(SIDE_EFFECT_IMPORT)) {
    recognized.add(match.index)
    if (SDK_SOURCE.test(match[1] ?? '') || RELATIVE_SOURCE.test(match[1] ?? ''))
      unexpected.push(match[0])
  }
  for (const match of text.matchAll(MODULE_STATEMENT_LINE)) {
    if (!recognized.has(match.index))
      unexpected.push(match[0])
  }
  return { sdk, sdkReExported, local, unexpected }
}

type ScannedFiles = Readonly<Record<string, Scanned>>

/** 从 start 出发、顺着同目录的引用走到的文件（含 start）；引用到清单之外的文件记进 missing */
function reachableFrom(scanned: ScannedFiles, start: readonly string[]): { readonly files: ReadonlySet<string>, readonly missing: readonly string[] } {
  const files = new Set(start)
  const missing: string[] = []
  const queue = [...start]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const reference of scanned[file]?.local ?? []) {
      if (!(reference.file in scanned)) {
        missing.push(`${file} → ${reference.file}`)
      }
      else if (!files.has(reference.file)) {
        files.add(reference.file)
        queue.push(reference.file)
      }
    }
  }
  return { files, missing }
}

/** 清单里从出口走不到的文件（登记表本身除外） */
function unreachableFiles(scanned: ScannedFiles): string[] {
  const { files } = reachableFrom(scanned, EXITS)
  return Object.keys(scanned).filter(file => !files.has(file) && file !== REGISTRY_FILE)
}

/** 一个文件实现的登记项：出口从它再导出的名字，加上引用它的（出口之外的）文件实现的登记项 */
function entriesOf(scanned: ScannedFiles, file: string, visiting: ReadonlySet<string> = new Set()): Set<string> {
  const entries = new Set<string>()
  for (const [other, { local }] of Object.entries(scanned)) {
    for (const reference of local.filter(item => item.file === file)) {
      if (EXITS.includes(other))
        reference.reExported.forEach(name => entries.add(name))
      else if (!visiting.has(other))
        entriesOf(scanned, other, new Set([...visiting, file])).forEach(name => entries.add(name))
    }
  }
  return entries
}

/** 出口之外的文件（封装的实现） */
function implementations(scanned: ScannedFiles): [string, Scanned][] {
  return Object.entries(scanned).filter(([file]) => !EXITS.includes(file))
}

/** 出口之外的文件对 SDK 的引用里，没列在它所实现的登记项的 sdk 里的 */
function unregisteredReferences(scanned: ScannedFiles): string[] {
  return implementations(scanned).flatMap(([file, { sdk }]) => {
    const entries = entriesOf(scanned, file)
    const declared = (reference: SdkReference): boolean => INTERNAL_API_REGISTRY.some(entry => entries.has(entry.name) && (entry.sdk?.[reference.from] ?? []).includes(reference.name))
    return sdk.filter(reference => !declared(reference)).map(reference => `${file}：${reference.from} 的 ${reference.name}（实现的登记项：${[...entries].join('、') || '无'}）`)
  })
}

/** 登记项的 sdk 里列了、实现它的文件里却没有引用的（过时的登记） */
function staleDeclarations(scanned: ScannedFiles): string[] {
  const usedBy = (entry: string, reference: SdkReference): boolean => implementations(scanned).some(([file, { sdk }]) => entriesOf(scanned, file).has(entry)
    && sdk.some(item => item.from === reference.from && item.name === reference.name))
  return INTERNAL_API_REGISTRY.flatMap(entry => Object.entries(entry.sdk ?? {}).flatMap(([from, names]) => names
    .filter(name => !usedBy(entry.name, { from, name }))
    .map(name => `${entry.name}：${from} 的 ${name}`)))
}

/**
 * 从 start 走得到的文件对界面的包的引用，值与类型都算（M2-P6 第二次复验 G3 的决定：保持这么严，提示语写准）。单看 Worker 的体积，
 * 整条的 import type 不进产物、可以放开；不放开的理由：界面的包（值与类型）只经 ui.ts 这一侧引用，与两个出口的分工一致（index.ts
 * 自己同样不许 export type 界面的包）；而且"类型不进产物"只对整条的 import type 成立，只写了行内 type 的导入（import { type X }）
 * 在 verbatimModuleSyntax 下留下空的导入，照样整包打进 Worker（1.0.1 实测：公式 Worker 677.4 → 921.0 KiB，超出预算；lint 的
 * ts/no-import-type-side-effects 拦着这种写法）。放开就要按写法区分，还要依赖那条 lint；Worker 这一侧现在也用不着界面的类型
 */
function uiReferencesFrom(scanned: ScannedFiles, start: readonly string[]): string[] {
  return [...reachableFrom(scanned, start).files].flatMap(file => (scanned[file]?.sdk ?? [])
    .filter(reference => UI_PACKAGE.test(reference.from))
    .map(reference => `${file}：${reference.from} 的 ${reference.name}`))
}

const SCANNED: ScannedFiles = Object.fromEntries(Object.entries(SOURCES).map(([file, text]) => [file, scan(text)]))

describe('内部 API 登记表', () => {
  const registered = INTERNAL_API_REGISTRY.map(entry => entry.name)
  const main = reExports(source)
  const ui = reExports(uiSource)

  it('两个出口都只写再导出', () => {
    expect([...main.unexpected, ...ui.unexpected]).toEqual([])
    expect(main.names.length).toBeGreaterThan(0)
    expect(ui.names.length).toBeGreaterThan(0)
  })

  it('导出的每一项都已登记，登记的每一项都还在导出；两个出口不重复', () => {
    expect([...main.names, ...ui.names].sort()).toEqual([...registered].sort())
  })

  it('运行时能拿到的导出都在登记表里（类型只在源码里看得到）', () => {
    expect([...Object.keys(internalApi), ...Object.keys(uiApi)].filter(name => !registered.includes(name))).toEqual([])
  })

  it('index.ts 不从界面的包再导出（公式 Worker 引用它）；界面的包只在 ui.ts', () => {
    expect(main.sources.filter(from => UI_PACKAGE.test(from))).toEqual([])
    expect(ui.sources.filter(from => !UI_PACKAGE.test(from))).toEqual([])
  })

  it('每一项写明来源、用途、证据与回归用例，名字不重复', () => {
    const incomplete = INTERNAL_API_REGISTRY.filter(entry => [entry.origin, entry.purpose, entry.evidence, entry.regression].some(text => text.trim() === ''))
    expect(incomplete.map(entry => entry.name)).toEqual([])
    expect(new Set(registered).size).toBe(registered.length)
  })
})

describe('内部 API 登记表：扫描 internal-api 里每个文件对 @univerjs/* 的引用（M2-P6 复验 N4）', () => {
  it('文件的清单是全的：从两个出口顺着同目录的引用走到的文件都在清单里，清单里没有走不到的文件（登记表本身除外）', () => {
    expect(reachableFrom(SCANNED, EXITS).missing, '这些文件不在 SOURCES 里：加进去，它们对 SDK 的引用才会被扫描').toEqual([])
    expect(unreachableFiles(SCANNED), '这些文件从出口走不到：删掉，或者经出口导出').toEqual([])
  })

  it('对 @univerjs/* 与同目录文件的引用都写成按名字的导入导出，同目录的文件写成 ./<文件名>（默认导入、命名空间导入、export *、副作用导入认不出引用了什么，子目录与 ../ 绕路认不出是哪个文件）', () => {
    expect(Object.entries(SCANNED).flatMap(([file, { unexpected }]) => unexpected.map(statement => `${file}：${statement}`))).toEqual([])
  })

  it('出口之外的文件对 SDK 的每一处引用（值与类型）都列在它所实现的登记项的 sdk 里；列出的都还在用', () => {
    expect(unregisteredReferences(SCANNED), '没登记的内部符号：列进实现它的那一项的 sdk（写明证据与回归），或者不用').toEqual([])
    expect(staleDeclarations(SCANNED), '过时的登记：实现这一项的文件已经不引用它').toEqual([])
  })

  it('出口直接再导出的登记项不写 sdk（出口里的再导出就是它自己）', () => {
    const direct = new Set(EXITS.flatMap(exit => SCANNED[exit]?.sdkReExported ?? []))
    expect(direct.size).toBeGreaterThan(0)
    expect(INTERNAL_API_REGISTRY.filter(entry => direct.has(entry.name) && entry.sdk !== undefined).map(entry => entry.name)).toEqual([])
  })

  it('公式 Worker 引用的 index.ts 走得到的文件都不引用界面的包（包本身与子路径）：值引用会整包打进 Worker，只用类型也不行（界面的包只经 ui.ts 这一侧引用）', () => {
    expect(reachableFrom(SCANNED, ['index.ts']).files.has('formula-protocol.ts')).toBe(true)
    expect(uiReferencesFrom(SCANNED, ['index.ts']), '这些文件从 index.ts（公式 Worker 也引用）走得到，却引用了界面的包：值引用会整包打进 Worker；import type 不进产物，同样不许——界面的包只经 ui.ts 这一侧引用，挪到只从 ui.ts 走得到的文件里').toEqual([])
  })

  it('自测本身：认得出跨行的导入、改名的再导出与行内的 type；默认导入、命名空间导入、export *、副作用导入、./<文件名> 之外的相对路径与认不出的写法都报出来', () => {
    const scanned = scan([
      '// 注释里的 import { X } from \'@univerjs/core\' 不算',
      'import type { Injector } from \'@univerjs/core\'',
      'import {',
      '  IFunctionService,',
      '  type BaseFunction,',
      '} from \'@univerjs/engine-formula\'',
      'export { SetRangeValuesMutation as Mutation } from \'@univerjs/sheets\'',
      'export { FORMULA_PROTOCOL } from \'./formula-protocol.ts\'',
      'import { injectorOf } from \'./injector.ts\'',
      'import Sheets from \'@univerjs/sheets\'',
      'import * as Ui from \'@univerjs/ui\'',
      'export * from \'@univerjs/docs\'',
      'export * from \'./dom-markers.ts\'',
      // ./<文件名> 之外的相对路径：子目录、../ 绕回本目录、只有 ./
      'export { subHelper } from \'./sub/helper.ts\'',
      'import { helper } from \'../internal-api/helper.ts\'',
      'export { other } from \'./\'',
      'import \'@univerjs/sheets/facade\'',
      'import \'../outside.ts\'',
      'export const x = 1; import { Y } from \'@univerjs/core\'',
      'export const z = 1; import { helper } from \'./helper.ts\'',
      'export const used = [injectorOf]',
      '',
    ].join('\n'))
    expect(scanned.sdk).toEqual([
      { from: '@univerjs/core', name: 'Injector' },
      { from: '@univerjs/engine-formula', name: 'IFunctionService' },
      { from: '@univerjs/engine-formula', name: 'BaseFunction' },
      { from: '@univerjs/sheets', name: 'SetRangeValuesMutation' },
    ])
    expect(scanned.sdkReExported).toEqual(['Mutation'])
    expect(scanned.local).toEqual([{ file: 'formula-protocol.ts', reExported: ['FORMULA_PROTOCOL'] }, { file: 'injector.ts', reExported: [] }])
    expect(scanned.unexpected).toEqual([
      'import Sheets from \'@univerjs/sheets\'',
      'import * as Ui from \'@univerjs/ui\'',
      'export * from \'@univerjs/docs\'',
      'export * from \'./dom-markers.ts\'',
      'export { subHelper } from \'./sub/helper.ts\'',
      'import { helper } from \'../internal-api/helper.ts\'',
      'export { other } from \'./\'',
      'import \'@univerjs/sheets/facade\'',
      'import \'../outside.ts\'',
      'export const x = 1; import { Y } from \'@univerjs/core\'',
      'export const z = 1; import { helper } from \'./helper.ts\'',
    ])
  })

  it('自测本身：界面的包认得出包本身与子路径（/facade、/lib/index.css 等），别的包不算；公式 Worker 走得到的文件引用它们（只用类型也算）都报出来', () => {
    const uiPackages = ['@univerjs/ui', '@univerjs/sheets-ui', '@univerjs/design', '@univerjs/engine-render', '@univerjs/ui/facade', '@univerjs/sheets-ui/facade', '@univerjs/docs-ui/lib/index.css']
    expect(uiPackages.filter(from => !UI_PACKAGE.test(from))).toEqual([])
    const otherPackages = ['@univerjs/core', '@univerjs/core/facade', '@univerjs/sheets', '@univerjs/sheets/facade', '@univerjs/engine-formula', '@univerjs/sheets-uix', '@univerjs/ui-kit', '@univerjs/uikit']
    expect(otherPackages.filter(from => UI_PACKAGE.test(from))).toEqual([])
    // 变异（M2-P6 第二次复验 G2）：formula-protocol.ts 从界面的包的 /facade 引用一个值（原来只认包本身，子路径漏掉，靠门禁 budgets 兜住）
    const withUiFacade: ScannedFiles = { ...SCANNED, 'formula-protocol.ts': scan(`${formulaProtocolSource}\nimport { transformComponentKey } from '@univerjs/sheets-ui/facade'\n`) }
    expect(uiReferencesFrom(withUiFacade, ['index.ts'])).toEqual(['formula-protocol.ts：@univerjs/sheets-ui/facade 的 transformComponentKey'])
    // 只用类型同样报出（G3 的决定，理由见 uiReferencesFrom）；只从 ui.ts 走得到的文件不管
    const withUiType: ScannedFiles = { ...SCANNED, 'injector.ts': scan(`${injectorSource}\nimport type { IShortcutService } from '@univerjs/ui'\n`) }
    expect(uiReferencesFrom(withUiType, ['index.ts'])).toEqual(['injector.ts：@univerjs/ui 的 IShortcutService'])
    expect(uiReferencesFrom(SCANNED, ['ui.ts'])).not.toEqual([])
  })

  it('自测本身（M2-P6 第二次复验 S1：复验者存活的变异）：子目录里的文件经 index.ts 再导出、同目录的新文件经 ../internal-api/ 绕路引用，都报为认不出的写法', () => {
    // 变异一：子目录里的 sub/helper.ts 引用没登记的内部符号，index.ts 从它再导出
    const viaSubdirectory = scan(`${source}\nexport { subHelper } from './sub/helper.ts'\n`)
    expect(viaSubdirectory.unexpected).toEqual(['export { subHelper } from \'./sub/helper.ts\''])
    // 变异二：injector.ts 经 ../internal-api/ 绕路引用同目录的新文件：就算新文件进了清单，也认不出这条引用的是它，所以不顺着走
    const roundabout = scan(`${injectorSource}\nimport { helper } from '../internal-api/helper.ts'\n`)
    expect(roundabout.unexpected).toEqual(['import { helper } from \'../internal-api/helper.ts\''])
    expect(roundabout.local).toEqual([])
    // 新文件本身不在 SOURCES 里：由 tools/src/lint/internal-api-sources.test.ts 递归列出目录报出（这里拿不到 node:fs）。
    // 变异三（injector.ts 里 import('./helper.ts')）：扫描不认动态 import()，由 lint 在 internal-api 里禁止（nerve/editor-internal-api）
  })

  it('自测本身：封装的文件引用了没列出的符号、经同目录的文件间接引用、列了不再引用的、清单漏了的与走不到的文件，都报出来', () => {
    // 复验者的变异：formula-protocol.ts 引用没登记的内部符号
    const withUnregistered: ScannedFiles = { ...SCANNED, 'formula-protocol.ts': scan(`${formulaProtocolSource}\nimport { SheetPermissionCheckController } from '@univerjs/sheets'\n`) }
    expect(unregisteredReferences(withUnregistered)).toEqual(['formula-protocol.ts：@univerjs/sheets 的 SheetPermissionCheckController（实现的登记项：FORMULA_PROTOCOL）'])
    // 经同目录的文件间接引用：injector.ts 引用一个新文件，新文件引用 SDK（算在 injectorOf 上）；新文件不在清单里时报出来
    const withHelper = { ...SCANNED, 'injector.ts': scan(`${injectorSource}\nimport { helper } from './helper.ts'\n`) }
    expect(reachableFrom(withHelper, EXITS).missing).toEqual(['injector.ts → helper.ts'])
    const withListedHelper: ScannedFiles = { ...withHelper, 'helper.ts': scan('import { ICommandService } from \'@univerjs/core\'\n\nexport const helper = ICommandService\n') }
    expect(unregisteredReferences(withListedHelper)).toEqual(['helper.ts：@univerjs/core 的 ICommandService（实现的登记项：injectorOf）'])
    // 清单里有、出口走不到的文件
    expect(unreachableFiles({ ...SCANNED, 'orphan.ts': scan('import { ICommandService } from \'@univerjs/core\'\n\nexport const orphan = ICommandService\n') })).toEqual(['orphan.ts'])
    // injector.ts 不再引用 Univer 的类型：injectorOf 的 sdk 里那一项过时了
    expect(staleDeclarations({ ...SCANNED, 'injector.ts': scan(injectorSource.replace('Injector, Univer', 'Injector')) })).toEqual(['injectorOf：@univerjs/core 的 Univer'])
  })
})

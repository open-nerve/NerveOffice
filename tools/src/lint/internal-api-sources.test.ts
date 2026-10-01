// 内部 API 登记表扫描的文件是全的（M2-P6 第二次复验 S1）。apps/web/src/editor/internal-api/registry.test.ts 扫描 internal-api 里每个文件
// 对 @univerjs/* 的引用，可 web 的测试拿不到 node:fs（lint 又不许 import.meta.glob），扫描的文件清单 SOURCES 只能手写：新文件漏写了，
// 那份测试自己看不出来（复验者的变异：子目录里的文件、经 ../ 绕路或动态 import() 引用的同目录新文件，都因为不在清单里而存活）。
// 这里递归列出 internal-api 下的文件（测试与测试辅助除外：它们只被测试引用，不进产物），与 SOURCES 逐个比对，多了少了都失败；
// SOURCES 的每一项还要是按 ?raw 引入的同名文件的源码（键与引入的路径一致），扫描的才是这个文件
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readText, REPO_ROOT } from '../shared/repo.ts'

const INTERNAL_API_DIR = 'apps/web/src/editor/internal-api'
const REGISTRY_TEST = `${INTERNAL_API_DIR}/registry.test.ts`
/** 测试与测试辅助（与 eslint.config.ts 的 TEST_CODE 同一口径） */
const TEST_CODE = /\.test(?:-support)?\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** dir 下的文件（递归；相对 dir、用 / 分隔、排好序），测试与测试辅助除外。目录之外的都算文件（符号链接也列出来） */
function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory() && !TEST_CODE.test(entry.name))
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

/** 按 ?raw 引入同目录文件的源码：import <变量> from './<文件>?raw' */
const RAW_IMPORT = /^import (\w+) from '\.\/([^'?]+)\?raw'$/gm
/** SOURCES 的对象字面量：从 const SOURCES 那一行到行首的右花括号 */
const SOURCES_BLOCK = /^const SOURCES\b.*= \{\n([\s\S]*?)^\}$/m
/** 对象字面量里的一项：'<文件>': <变量>, */
const SOURCES_ENTRY = /^ {2}'([^']+)': (\w+),$/

interface ListedSources {
  /** 清单里的每一项：文件名、给出源码的变量、这个变量按 ?raw 引入的文件（不是按 ?raw 引入的变量为 undefined） */
  readonly entries: readonly { readonly file: string, readonly variable: string, readonly rawOf: string | undefined }[]
  /** 对象字面量里认不出的行（SOURCES 只写 '<文件>': <变量>, 这一种写法：展开、计算出的键都认不出扫描的是哪个文件）；空行与注释不算 */
  readonly unrecognized: readonly string[]
}

/** 从 registry.test.ts 的源码里取出 SOURCES；找不到 const SOURCES = { … } 时抛错（改了写法要同步这里） */
function listedSources(text: string): ListedSources {
  const block = SOURCES_BLOCK.exec(text)
  if (block === null)
    throw new Error(`${REGISTRY_TEST} 里找不到 const SOURCES = { … }：改了它的写法，同步这里的解析`)
  const raw = new Map([...text.matchAll(RAW_IMPORT)].map(([, variable = '', file = '']) => [variable, file]))
  const entries: { file: string, variable: string, rawOf: string | undefined }[] = []
  const unrecognized: string[] = []
  for (const line of (block[1] ?? '').split('\n').filter(item => item.trim() !== '' && !item.trim().startsWith('//'))) {
    const [, file, variable] = SOURCES_ENTRY.exec(line) ?? []
    if (file === undefined || variable === undefined)
      unrecognized.push(line)
    else
      entries.push({ file, variable, rawOf: raw.get(variable) })
  }
  return { entries, unrecognized }
}

/** SOURCES 里键与源码对不上的项：给出源码的变量不是按 ?raw 引入这个文件的 */
function mismatchedEntries(listed: ListedSources): string[] {
  return listed.entries.filter(entry => entry.rawOf !== entry.file).map(entry => `'${entry.file}': ${entry.variable}（${entry.rawOf === undefined ? '不是按 ?raw 引入的源码' : `引入的是 ${entry.rawOf}`}）`)
}

let scratch: string | undefined

afterEach(() => {
  if (scratch !== undefined)
    rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('内部 API 登记表扫描的文件是全的：registry.test.ts 的 SOURCES 与 internal-api 下的文件一一对应（M2-P6 第二次复验 S1）', () => {
  const listed = listedSources(readText(REGISTRY_TEST))

  it('SOURCES 只写"文件名：按 ?raw 引入的这个文件的源码"', () => {
    expect(listed.unrecognized, `${REGISTRY_TEST} 的 SOURCES 里认不出的写法：每一项写成 '<文件>': <变量>,`).toEqual([])
    expect(mismatchedEntries(listed), '这些项的源码不是这个文件的：扫描的是别的文件').toEqual([])
  })

  it('internal-api 下的每个文件（递归，测试与测试辅助除外）都在 SOURCES 里，SOURCES 里的每个文件都还在', () => {
    const files = sourceFilesUnder(join(REPO_ROOT, INTERNAL_API_DIR))
    const names = listed.entries.map(entry => entry.file)
    // 列出的确实是这个目录：两个出口与登记表都在
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'ui.ts', 'registry.ts']))
    expect(files.filter(file => !names.includes(file)), `这些文件不在 ${REGISTRY_TEST} 的 SOURCES 里：按 ?raw 引入、加进 SOURCES，它们对 SDK 的引用才会被扫描（internal-api 不建子目录：引用只认 ./<文件名>）`).toEqual([])
    expect(names.filter(name => !files.includes(name)), 'SOURCES 里的这些文件不在 internal-api 下：删掉').toEqual([])
  })

  it('自测本身：递归列出子目录里的文件，跳过测试与测试辅助', () => {
    scratch = mkdtempSync(join(tmpdir(), 'nerve-internal-api-'))
    mkdirSync(join(scratch, 'sub', 'deeper'), { recursive: true })
    for (const file of ['index.ts', 'registry.test.ts', 'helper.test-support.ts', 'notes.md', 'sub/helper.ts', 'sub/deeper/more.tsx', 'sub/helper.test.ts'])
      writeFileSync(join(scratch, file), '')
    expect(sourceFilesUnder(scratch)).toEqual(['index.ts', 'notes.md', 'sub/deeper/more.tsx', 'sub/helper.ts'])
  })

  it('自测本身：取出 SOURCES 的每一项与它按 ?raw 引入的文件；源码不是这个文件的、认不出的写法都报出来，找不到 SOURCES 时抛错', () => {
    const text = [
      'import injectorSource from \'./injector.ts?raw\'',
      'import source from \'./index.ts?raw\'',
      'import { INTERNAL_API_REGISTRY } from \'./registry.ts\'',
      'const OTHER = {}',
      '',
      '/** 说明 */',
      'const SOURCES: Readonly<Record<string, string>> = {',
      '  \'index.ts\': source,',
      '  \'injector.ts\': injectorSource,',
      '  // 键与源码对不上：扫描的是 injector.ts',
      '  \'helper.ts\': injectorSource,',
      '  \'registry.ts\': INTERNAL_API_REGISTRY,',
      '  ...OTHER,',
      '  [\'computed\']: source,',
      '}',
      'const EXITS = [\'index.ts\']',
      '',
    ].join('\n')
    const parsed = listedSources(text)
    expect(parsed.entries.map(entry => entry.file)).toEqual(['index.ts', 'injector.ts', 'helper.ts', 'registry.ts'])
    expect(mismatchedEntries(parsed)).toEqual(['\'helper.ts\': injectorSource（引入的是 injector.ts）', '\'registry.ts\': INTERNAL_API_REGISTRY（不是按 ?raw 引入的源码）'])
    expect(parsed.unrecognized).toEqual(['  ...OTHER,', '  [\'computed\']: source,'])
    expect(() => listedSources('const FILES = {\n}\n')).toThrow('找不到 const SOURCES')
  })
})

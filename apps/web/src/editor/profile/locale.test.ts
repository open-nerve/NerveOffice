import type { ILanguagePack, LanguageValue } from '@univerjs/core'
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN'
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN'
import { describe, expect, it } from 'vitest'
import { overrideLanguagePack, READ_ONLY_PERMISSION_TEXTS, SHEET_ZH_CN } from './locale.ts'

/** 按"a.b.c"取语言包里的值 */
function valueAt(pack: ILanguagePack, path: string): LanguageValue | undefined {
  let current: LanguageValue | undefined = pack
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current))
      return undefined
    current = (current)[key]
  }
  return current
}

/** 语言包的全部叶子：路径与文字 */
function leaves(pack: ILanguagePack, prefix = ''): [string, LanguageValue][] {
  return Object.entries(pack).flatMap(([key, value]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? leaves(value, path) : [[path, value] as [string, LanguageValue]]
  })
}

/** 权限检查拦下操作时的提示所在的几组（各包 locale/zh-CN 的 permission.dialog） */
const DIALOG_GROUPS = ['sheets', 'sheets-ui', 'sheets-drawing-ui', 'sheets-conditional-formatting-ui', 'sheets-data-validation-ui']

/** 拦下操作的提示：几组 permission.dialog 里的 …Err 与 alertContent，加上筛选按钮的 filterErr（sheets-filter-ui 的 permission 下） */
function isBlockedText(path: string): boolean {
  return DIALOG_GROUPS.some(group => path.startsWith(`${group}.permission.dialog.`)) ? /Err$|alertContent$/.test(path) : path === 'sheets-filter-ui.permission.filterErr'
}

describe('只读时权限检查的提示（M2-P3 S3 之后的修复）：平台不用 SDK 的保护，这些提示只在只读时出现', () => {
  const overridden = leaves(READ_ONLY_PERMISSION_TEXTS)

  it('合并之后这些路径是新的说法', () => {
    expect(overridden.length).toBe(24)
    for (const [path, text] of overridden)
      expect(valueAt(SHEET_ZH_CN, path), path).toBe(text)
    expect(valueAt(SHEET_ZH_CN, 'sheets-ui.permission.dialog.editErr')).toBe('这份文档只能查看，不能修改。')
    expect(valueAt(SHEET_ZH_CN, 'sheets.permission.dialog.operatorSheetErr')).toBe('这份文档只能查看，不能调整工作表。')
    expect(valueAt(SHEET_ZH_CN, 'sheets-ui.permission.dialog.copyErr')).toBe('不能复制这里的内容。')
    // 筛选按钮的提示（P3 审查 B8）：原文是"你没有权限使用筛选。"
    expect(valueAt(SHEET_ZH_CN, 'sheets-filter-ui.permission.filterErr')).toBe('这份文档只能查看，不能使用筛选。')
  })

  it('拦下操作的提示（…Err 与 alertContent、筛选按钮的提示）都换成了只读的说法：不再提保护、不让人联系创建者、不说"没有权限"', () => {
    const errors = leaves(SHEET_ZH_CN).filter(([path]) => isBlockedText(path))
    expect(errors.map(([path]) => path).sort()).toEqual(overridden.map(([path]) => path).sort())
    expect(errors.filter(([, text]) => /保护|创建者|没有权限/.test(String(text)))).toEqual([])
  })

  it('其他文字不动：只改覆盖的路径，别的叶子与原来的语言包相同', () => {
    const changed = new Set(overridden.map(([path]) => path))
    const original = { ...SheetsZhCN, ...SheetsUIZhCN } as ILanguagePack
    const untouched = leaves(original).filter(([path]) => !changed.has(path))
    expect(untouched.length).toBeGreaterThan(100)
    for (const [path, text] of untouched)
      expect(valueAt(SHEET_ZH_CN, path), path).toEqual(text)
    expect(valueAt(SHEET_ZH_CN, 'sheets-ui.permission.dialog.alert')).toBe('提示')
  })
})

describe('语言包的深合并', () => {
  const base: ILanguagePack = { a: { b: { c: '原来', d: '不动' }, e: '也不动' }, f: '顶层' }

  it('只替换给出的叶子，不改传入的对象', () => {
    const merged = overrideLanguagePack(base, { a: { b: { c: '新的' } } })
    expect(merged).toEqual({ a: { b: { c: '新的', d: '不动' }, e: '也不动' }, f: '顶层' })
    expect(valueAt(base, 'a.b.c')).toBe('原来')
  })

  it('路径不存在或类型不对：报错（写错了键名，或者 SDK 升级后改了名）', () => {
    expect(() => overrideLanguagePack(base, { a: { x: '新的' } })).toThrow('a.x')
    expect(() => overrideLanguagePack(base, { f: { g: '新的' } })).toThrow('f')
  })
})

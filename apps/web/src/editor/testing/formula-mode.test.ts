// 测试构建的公式模式开关（formula-mode.ts）：地址的查询串里怎么选，不认识的写法不悄悄退回 Worker 模式
import type { FormulaMode } from '../profile/sheet-profile.ts'
import type { SelftestFormulaMode } from './selftest-report.ts'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { formulaModeFromSearch } from './formula-mode.ts'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES, formulaModeOfValue, selftestEditorUrl } from './selftest-report.ts'

describe('公式模式的开关（M3-P4 设计 §3.14）', () => {
  it('formula=main 是主线程模式；formula=worker 或者不带是 Worker 模式', () => {
    expect(FORMULA_MODE_PARAM).toBe('formula')
    expect(formulaModeFromSearch('?formula=main')).toBe('main-thread')
    expect(formulaModeFromSearch('?selftest=formula-timing&formula=main&next=x')).toBe('main-thread')
    expect(formulaModeFromSearch('?formula=worker')).toBe('worker')
    expect(formulaModeFromSearch('')).toBe('worker')
    expect(formulaModeFromSearch('?edit=new')).toBe('worker')
  })

  it('不认识的写法抛错（编辑器加载失败、看得到），不悄悄地按 Worker 模式跑主线程的用例', () => {
    expect(() => formulaModeFromSearch('?formula=main-thread')).toThrow('地址里的 formula=main-thread 不认识：只能是 worker 或 main')
    expect(() => formulaModeFromSearch('?formula=')).toThrow('不认识')
  })

  it('页面自检的写法与编辑器的模式一一对应（selftest-report.ts 不引用任何模块，另写了一份）', () => {
    expectTypeOf<SelftestFormulaMode>().toEqualTypeOf<FormulaMode>()
    for (const mode of Object.keys(FORMULA_MODE_VALUES) as SelftestFormulaMode[]) {
      expect(formulaModeFromSearch(`?${FORMULA_MODE_PARAM}=${FORMULA_MODE_VALUES[mode]}`)).toBe(mode)
      expect(formulaModeOfValue(FORMULA_MODE_VALUES[mode])).toBe(mode)
    }
    expect(formulaModeOfValue(null)).toBeUndefined()
    expect(formulaModeOfValue('main-thread')).toBeNull()
  })

  it('入口页拼的编辑器页地址：给了模式才带 formula，编辑器读出的就是这个模式', () => {
    const main = new URL(selftestEditorUrl('http://127.0.0.1:4100', 'doc-1', 'formula-timing', 'http://127.0.0.1:4200/report?step=3', 'main-thread'))
    expect(main.searchParams.get(FORMULA_MODE_PARAM)).toBe('main')
    expect(formulaModeFromSearch(main.search)).toBe('main-thread')
    const plain = new URL(selftestEditorUrl('http://127.0.0.1:4100', 'doc-1', 'formula-timing', 'http://127.0.0.1:4200/report?step=3'))
    expect(plain.searchParams.has(FORMULA_MODE_PARAM)).toBe(false)
    expect(formulaModeFromSearch(plain.search)).toBe('worker')
  })
})

// 测试构建的公式模式开关（M3-P4 设计 §3.14，US-M3-03 的两种模式）：编辑器页的地址带 formula=main 时，编辑器以主线程模式创建
// （同一份档案的变体，profile/sheet-profile.ts 的 FormulaExecution：不注册 RPC、三处 notExecuteFormula 为假、让出间隔 20——
// M0 推荐、M4 要用的退路），带 formula=worker 或者不带时照常用公式 Worker。
// 只在测试构建里：createSheetEditor 在 import.meta.env.MODE === 'e2e' 的分支里动态引入它，生产构建里那个分支与这个分块都被去掉，
// 门禁 artifacts 按模块来源核对（src/editor/testing/ 只属于测试构建）。生产构建里没有开关，只有 Worker 模式。
// 同一页里每次重建编辑器（进入、退出编辑，"有更新"）都读同一个地址，模式不变。参数的名字与取值在 ./selftest-report.ts
// （页面自检的入口页拼编辑器页的地址要用，那个文件不引用任何模块）
import type { FormulaMode } from '../profile/sheet-profile.ts'
import { FORMULA_MODE_PARAM, FORMULA_MODE_VALUES } from './selftest-report.ts'

/** 地址的查询串里选的公式模式；不认识的取值抛错（编辑器加载失败，用例看得到），不悄悄地退回 Worker 模式、把主线程的用例测成 Worker 的 */
export function formulaModeFromSearch(search: string): FormulaMode {
  const value = new URLSearchParams(search).get(FORMULA_MODE_PARAM)
  if (value === null || value === FORMULA_MODE_VALUES.worker)
    return 'worker'
  if (value === FORMULA_MODE_VALUES['main-thread'])
    return 'main-thread'
  throw new Error(`地址里的 ${FORMULA_MODE_PARAM}=${value} 不认识：只能是 ${Object.values(FORMULA_MODE_VALUES).join(' 或 ')}`)
}

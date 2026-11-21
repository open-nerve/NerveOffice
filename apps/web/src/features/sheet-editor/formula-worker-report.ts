// 可恢复诊断只挑选有限事实；不引用带 Zod 的 schema，保持编辑器分块的 CSP 初始化顺序。
// 页面上报的档案由表格的扩展传入（编辑模式的选项里的，M6-P1 S8 spec §2.6）
import type { FormulaWorkerFailure, FormulaWorkerReport } from '@nerve-office/contracts'
import type { PageClientFormat } from '../../shared/api/client-format.ts'
import type { OpenCheckContext } from '../document-editor/index.ts'
import { FORMULA_WORKER_FAILURE_KINDS, OPEN_CHECK_ACCESS, OPEN_CHECK_TRIGGERS } from '@nerve-office/contracts'

export function formulaWorkerReportOf(failure: FormulaWorkerFailure, context: OpenCheckContext, format: PageClientFormat): FormulaWorkerReport | undefined {
  // 与服务端修订的 PostgreSQL integer 上限一致；不为常量引入含 Zod 的 content 模块。
  if (!FORMULA_WORKER_FAILURE_KINDS.includes(failure) || !Number.isSafeInteger(context.revision) || context.revision < 1 || context.revision > 2_147_483_647
    || !OPEN_CHECK_ACCESS.includes(context.access) || !OPEN_CHECK_TRIGGERS.includes(context.trigger)) {
    return undefined
  }
  return { kind: 'formula-worker', failure, revision: context.revision, access: context.access, trigger: context.trigger, ...format }
}

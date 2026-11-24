import type { FormulaWorkerFailure } from '@nerve-office/contracts'
import type { OpenCheckContext } from '../document-editor/index.ts'
import { FORMULA_WORKER_FAILURE_KINDS, formulaWorkerReportSchema } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { clientFormatOf } from '../../shared/api/client-format.ts'
import { formulaWorkerReportOf } from './formula-worker-report.ts'

const CONTEXT = { revision: 7, access: 'edit', trigger: 'formula-recovery' } as const
const SHEET_FORMAT = clientFormatOf('sheet')

describe('US-M4-13 Worker 报告只挑选有限事实', () => {
  it('每种故障均与服务端结构一致，额外上下文不进入报告', () => {
    const input = { ...CONTEXT, message: '机密正文', snapshot: '机密正文', stack: '机密正文', workerUrl: '机密正文' }
    for (const failure of FORMULA_WORKER_FAILURE_KINDS) {
      const report = formulaWorkerReportOf(failure, input, SHEET_FORMAT)
      expect(report).toEqual({ kind: 'formula-worker', failure, ...CONTEXT, ...SHEET_FORMAT })
      expect(formulaWorkerReportSchema.parse(report)).toEqual(report)
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('非法修订 %s 不上报', (revision) => {
    expect(formulaWorkerReportOf('create', { ...CONTEXT, revision }, SHEET_FORMAT)).toBeUndefined()
  })

  it('未知枚举不带到网络，包括无类型来源传入的异常对象', () => {
    expect(formulaWorkerReportOf('机密正文' as FormulaWorkerFailure, CONTEXT, SHEET_FORMAT)).toBeUndefined()
    expect(formulaWorkerReportOf({ message: '机密正文' } as unknown as FormulaWorkerFailure, CONTEXT, SHEET_FORMAT)).toBeUndefined()
    expect(formulaWorkerReportOf('create', { ...CONTEXT, access: 'write' } as unknown as OpenCheckContext, SHEET_FORMAT)).toBeUndefined()
    expect(formulaWorkerReportOf('create', { ...CONTEXT, trigger: 'save' } as unknown as OpenCheckContext, SHEET_FORMAT)).toBeUndefined()
  })
})

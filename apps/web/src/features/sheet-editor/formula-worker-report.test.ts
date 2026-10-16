import type { FormulaWorkerFailure } from '@nerve-office/contracts'
import type { OpenCheckContext } from './open-check-report.ts'
import { FORMULA_WORKER_FAILURE_KINDS, formulaWorkerReportSchema } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { PAGE_CLIENT_FORMAT } from '../../shared/api/client-format.ts'
import { formulaWorkerReportOf } from './formula-worker-report.ts'

const CONTEXT = { revision: 7, access: 'edit', trigger: 'formula-recovery' } as const

describe('US-M4-13 Worker 报告只挑选有限事实', () => {
  it('每种故障均与服务端结构一致，额外上下文不进入报告', () => {
    const input = { ...CONTEXT, message: '机密正文', snapshot: '机密正文', stack: '机密正文', workerUrl: '机密正文' }
    for (const failure of FORMULA_WORKER_FAILURE_KINDS) {
      const report = formulaWorkerReportOf(failure, input)
      expect(report).toEqual({ kind: 'formula-worker', failure, ...CONTEXT, ...PAGE_CLIENT_FORMAT })
      expect(formulaWorkerReportSchema.parse(report)).toEqual(report)
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('非法修订 %s 不上报', (revision) => {
    expect(formulaWorkerReportOf('create', { ...CONTEXT, revision })).toBeUndefined()
  })

  it('未知枚举不带到网络，包括无类型来源传入的异常对象', () => {
    expect(formulaWorkerReportOf('机密正文' as FormulaWorkerFailure, CONTEXT)).toBeUndefined()
    expect(formulaWorkerReportOf({ message: '机密正文' } as unknown as FormulaWorkerFailure, CONTEXT)).toBeUndefined()
    expect(formulaWorkerReportOf('create', { ...CONTEXT, access: 'write' } as unknown as OpenCheckContext)).toBeUndefined()
    expect(formulaWorkerReportOf('create', { ...CONTEXT, trigger: 'save' } as unknown as OpenCheckContext)).toBeUndefined()
  })
})

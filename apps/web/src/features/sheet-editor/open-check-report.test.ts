// 打开自检失败的上报的请求体（M3-P4 设计 §3.13）：与服务端的严格解析同一份写法——这里给出的请求体都过得了 contracts 的
// openCheckReportSchema（服务端用它解析）；不合写法的项先筛掉，免得整份被拒
import type { OpenCheckFailure } from '@nerve-office/contracts'
import type { OpenCheck } from '../../editor/index.ts'
import { OPEN_CHECK_FAILURES_MAX, openCheckReportSchema } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { PAGE_CLIENT_FORMAT } from './client-format.ts'
import { openCheckReportOf } from './open-check-report.ts'

const CONTEXT = { revision: 7, access: 'edit', trigger: 'enter' } as const

function failed(...failures: [OpenCheckFailure, ...OpenCheckFailure[]]): OpenCheck {
  return { ok: false, failures }
}

describe('打开自检的上报：请求体', () => {
  it('通过了：不报', () => {
    expect(openCheckReportOf({ ok: true }, CONTEXT)).toBeUndefined()
  })

  it('失败：修订号、打开方式与起因，失败清单原样（种类、资源名，抛错的带构造器名），本页的构建与格式；过得了服务端的严格解析', () => {
    const failures: [OpenCheckFailure, ...OpenCheckFailure[]] = [
      { kind: 'profile-missing-hook', resource: 'SHEET_NOTE_PLUGIN' },
      { kind: 'parse-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'SyntaxError' },
      { kind: 'resource-emptied', resource: 'SHEET_FILTER_PLUGIN' },
    ]
    const report = openCheckReportOf(failed(...failures), CONTEXT)
    expect(report).toEqual({ revision: 7, access: 'edit', trigger: 'enter', failures, ...PAGE_CLIENT_FORMAT })
    expect(openCheckReportSchema.safeParse(report).success).toBe(true)
  })

  it('不合写法的筛掉：资源名不合 SDK 的写法的那一项不报；构造器名不合写法、或者种类不是抛错的，去掉构造器名', () => {
    const report = openCheckReportOf(failed(
      { kind: 'profile-unexpected-hook', resource: 'sheet-filter' },
      { kind: 'load-threw', resource: 'SHEET_DATA_VALIDATION_PLUGIN', error: 'Type Error: x' },
      { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN', error: 'TypeError' },
      { kind: 'serialize-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'e$1' },
    ), CONTEXT)
    expect(report?.failures).toEqual([
      { kind: 'load-threw', resource: 'SHEET_DATA_VALIDATION_PLUGIN' },
      { kind: 'resource-missing', resource: 'SHEET_NOTE_PLUGIN' },
      { kind: 'serialize-threw', resource: 'SHEET_FILTER_PLUGIN', error: 'e$1' },
    ])
    expect(openCheckReportSchema.safeParse(report).success).toBe(true)
  })

  it('至多报 OPEN_CHECK_FAILURES_MAX 项（排在前面的）', () => {
    const many = Array.from({ length: OPEN_CHECK_FAILURES_MAX + 3 }, (_, index): OpenCheckFailure => ({ kind: 'profile-unexpected-hook', resource: `SHEET_EXTRA${index}_PLUGIN` }))
    const report = openCheckReportOf(failed(many[0] as OpenCheckFailure, ...many.slice(1)), CONTEXT)
    expect(report?.failures).toEqual(many.slice(0, OPEN_CHECK_FAILURES_MAX))
    expect(openCheckReportSchema.safeParse(report).success).toBe(true)
  })

  it('筛完没有可报的、修订号不是正整数：不报（服务端会整份拒绝）', () => {
    expect(openCheckReportOf(failed({ kind: 'profile-unexpected-hook', resource: 'not a resource' }), CONTEXT)).toBeUndefined()
    for (const revision of [0, -1, 1.5, Number.NaN])
      expect(openCheckReportOf(failed({ kind: 'resource-emptied', resource: 'SHEET_NOTE_PLUGIN' }), { ...CONTEXT, revision }), String(revision)).toBeUndefined()
  })
})

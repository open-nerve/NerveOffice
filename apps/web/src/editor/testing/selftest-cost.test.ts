// 捕获成本与性能基线的复核（selftest-cost.ts，M4-P1 设计 §3.6 第 10、12 项）的次数：按地址里的运行次数，各有上限；不带时（Playwright 的校准）最少
import { describe, expect, it } from 'vitest'
import { captureCounts, perfCounts } from './selftest-cost.ts'

describe('捕获成本与性能基线的次数', () => {
  it('捕获成本：预热 2 次，测 runs 次、最多 10 次（M0 的口径）；不带 runs 时测 1 次', () => {
    expect([captureCounts(undefined), captureCounts(3), captureCounts(40)]).toEqual([{ warmups: 2, measured: 1 }, { warmups: 2, measured: 3 }, { warmups: 2, measured: 10 }])
  })

  it('公式：增量最多 5 次、全量最多 3 次（M0 V10）；不带 runs 时各 1 次', () => {
    expect([perfCounts(undefined), perfCounts(2), perfCounts(40)]).toEqual([{ incremental: 1, full: 1 }, { incremental: 2, full: 2 }, { incremental: 5, full: 3 }])
  })
})

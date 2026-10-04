// 实测的统计与结果的格式（measure-stats.ts）：百分位的取法、按方向分组的分布、Markdown 的表、内存的增长斜率。
import type { SwitchTiming } from '../../../apps/web/src/editor/testing/switch-timing.ts'
import type { MemoryReading, SwitchRun } from './measure-stats.ts'
import { describe, expect, it } from 'vitest'
import { distribution, memoryTable, memoryTrend, percentile, slope, switchGroups, switchTable, triple } from './measure-stats.ts'

describe('分布', () => {
  it('百分位按最近秩法：第 ceil(p × n) 个；十几个样本时 p95 是最大值', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    expect(percentile(sorted, 0.5)).toBe(6)
    expect(percentile(sorted, 0.95)).toBe(12)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], 0.95)).toBe(20)
    expect(percentile([7], 0.5)).toBe(7)
    expect(() => percentile([], 0.5)).toThrow('没有样本')
  })

  it('一组样本的最小值、p50、p95、最大值与平均值（不要求排好序）；没有样本时是 null', () => {
    expect(distribution([30, 10, 20, 40])).toEqual({ n: 4, min: 10, p50: 20, p95: 40, max: 40, mean: 25 })
    expect(distribution([])).toBeNull()
  })

  it('表里写成"p50 / p95 / 最大值"（毫秒取整），没有时是"—"', () => {
    expect(triple(distribution([400.4, 420.6, 455.5]))).toBe('421 / 456 / 456')
    expect(triple(null)).toBe('—')
  })
})

function timing(direction: SwitchTiming['direction'], ready: number, acquire?: number): SwitchTiming {
  return {
    direction,
    feedback: 10,
    header: ready,
    creating: 30,
    mountStart: 31,
    syncEnd: 40,
    rendered: ready - 20,
    ready,
    steady: ready + 3000,
    requests: acquire === undefined ? [] : [{ role: 'acquire', label: 'POST /api/documents/d1/edit-lease 201', start: 1, end: 1 + acquire }],
  }
}

const RUN: SwitchRun = {
  format: 'nerve-office.switch-measure.v1',
  browser: { project: 'webkit', version: '26.6' },
  document: { id: 'medium', title: '只读样本', bytes: 17_624, scale: '5 张表' },
  startedAt: '2026-10-04T05:00:00.000Z',
  finishedAt: '2026-10-04T05:03:00.000Z',
  load: { before: [2.1, 3, 4], after: [2.5, 3, 4] },
  samples: [
    { direction: 'open', round: 1, timing: timing('open', 900) },
    { direction: 'enter', round: 1, timing: timing('enter', 450, 20) },
    { direction: 'enter', round: 2, timing: timing('enter', 410, 18) },
    { direction: 'exit', round: 1, timing: timing('exit', 380) },
  ],
}

describe('按方向分组', () => {
  it('每个方向一组，每一段一个分布（缺的段是 null）', () => {
    const groups = switchGroups(RUN)
    expect(groups.map(group => [group.browser, group.document, group.direction])).toEqual([['webkit', 'medium', 'open'], ['webkit', 'medium', 'enter'], ['webkit', 'medium', 'exit']])
    const enter = groups[1]
    expect(enter?.durations.ready).toEqual({ n: 2, min: 410, p50: 410, p95: 450, max: 450, mean: 430 })
    expect(enter?.durations.acquire).toMatchObject({ n: 2, p50: 18, max: 20 })
    expect(groups[2]?.durations.acquire).toBeNull()
  })

  it('Markdown 的表：每行一组，每列一段的 p50 / p95 / 最大值', () => {
    expect(switchTable(switchGroups(RUN), ['ready', 'acquire'], { ready: '可以操作' })).toBe([
      '| 浏览器 | 文档 | 方向 | n | 可以操作 | acquire |',
      '| --- | --- | --- | --- | --- | --- |',
      '| webkit | medium | 打开 | 1 | 900 / 900 / 900 | — |',
      '| webkit | medium | 进入编辑 | 2 | 410 / 450 / 450 | 18 / 20 / 20 |',
      '| webkit | medium | 退出编辑 | 1 | 380 / 380 / 380 | — |',
    ].join('\n'))
  })
})

describe('内存的增长', () => {
  it('最小二乘的斜率：直线上是它的斜率，水平是 0，少于两个点是 0', () => {
    expect(slope([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }])).toBe(2)
    expect(slope([{ x: 1, y: 4 }, { x: 2, y: 4 }])).toBe(0)
    expect(slope([{ x: 1, y: 4 }])).toBe(0)
  })

  function reading(round: number, usedHeap: number, nodes = 1_000): MemoryReading {
    return { round, usedHeap, totalHeap: usedHeap + 1_048_576, documents: 3, nodes, listeners: 600, workers: 1 }
  }

  it('第 2 次之后（含）的增长：堆按 KiB/次，DOM 节点与事件监听按个/次；第 0、1 次（打开、第一次的预热）不算', () => {
    const readings = [reading(0, 10 * 1_048_576), reading(1, 20 * 1_048_576), reading(2, 21 * 1_048_576, 1_000), reading(3, 21 * 1_048_576 + 102_400, 1_002), reading(4, 21 * 1_048_576 + 204_800, 1_004)]
    expect(memoryTrend(readings)).toEqual({ from: 2, heapKiBPerRound: 100, nodesPerRound: 2, listenersPerRound: 0, heapKiBTotal: 200 })
  })

  it('读数的表：堆以 MiB 计', () => {
    expect(memoryTable([reading(0, 25 * 1_048_576)])).toBe([
      '| 次 | 已用堆（MiB） | 堆总量（MiB） | 文档 | DOM 节点 | 事件监听 | Worker |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 0 | 25.0 | 26.0 | 3 | 1000 | 600 | 1 |',
    ].join('\n'))
  })
})

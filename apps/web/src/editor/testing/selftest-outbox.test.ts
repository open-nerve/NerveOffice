// 生产发件箱的复核（selftest-outbox.ts，M4-P1 设计 §3.6 第 11 项）的次数：各段两档负载，各测 runs 次、最多 10 次；不带 runs 时只有 1 MiB 一次
import { describe, expect, it } from 'vitest'
import { pipelineRounds } from './selftest-outbox.ts'

describe('磁盘上的管道各段的次数', () => {
  it('runs 40：约 1 MiB 与约 5 MiB 两档、各 10 次；runs 3：各 3 次；不带 runs（校准）：只有 1 MiB 一次', () => {
    expect([pipelineRounds(40), pipelineRounds(3)].map(rounds => [rounds.sizes.map(size => size.id), rounds.measured])).toEqual([[['1m', '5m'], 10], [['1m', '5m'], 3]])
    expect(pipelineRounds(undefined)).toEqual({ sizes: [{ id: '1m', bytes: 1024 * 1024 }], measured: 1 })
  })
})

// 生产发件箱的复核（selftest-outbox.ts，M4-P1 设计 §3.6 第 9 项的生产部分、第 11 项）：各段的次数（两档负载，各测 runs 次、最多 10 次；
// 不带 runs 时只有 1 MiB 一次），OPFS 镜像没写成的那几次的归纳
import { describe, expect, it } from 'vitest'
import { mirrorOthers, pipelineRounds } from './selftest-outbox.ts'

describe('磁盘上的管道各段的次数', () => {
  it('runs 40：约 1 MiB 与约 5 MiB 两档、各 10 次；runs 3：各 3 次；不带 runs（校准）：只有 1 MiB 一次', () => {
    expect([pipelineRounds(40), pipelineRounds(3)].map(rounds => [rounds.sizes.map(size => size.id), rounds.measured])).toEqual([[['1m', '5m'], 10], [['1m', '5m'], 3]])
    expect(pipelineRounds(undefined)).toEqual({ sizes: [{ id: '1m', bytes: 1024 * 1024 }], measured: 1 })
  })
})

describe('OPFS 镜像没写成的那几次', () => {
  it('都写成了：null；别的结果按出现的先后各记几次（没写成的写入没有镜像的结果，记作 none）', () => {
    expect(mirrorOthers(['mirrored', 'mirrored'])).toBeNull()
    expect(mirrorOthers([])).toBeNull()
    expect(mirrorOthers(['not-mirrored:unsupported', 'not-mirrored:unsupported'])).toBe('not-mirrored:unsupported×2')
    expect(mirrorOthers(['mirrored', 'not-mirrored:busy', null, 'not-mirrored:busy', 'not-mirrored:failed:UnknownError'])).toBe('not-mirrored:busy×2、none×1、not-mirrored:failed:UnknownError×1')
  })
})

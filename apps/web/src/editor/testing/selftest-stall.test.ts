// Worker 停顿的复核（selftest-stall.ts，M4-P1 设计 §3.6 第 9 项）的编排：各档的次数、每组的大小、两个条件成对、先后轮流；场景的预算
import { describe, expect, it } from 'vitest'
import { productionStallBudgetMs, productionStallSchedule, STALL_BLOCK_SIZE, STALL_LEVELS, stallBudgetMs, stallSchedule } from './selftest-stall.ts'

/** 固定的"随机"：依次给出 values 里的数 */
function sequence(...values: number[]): () => number {
  let index = 0
  return () => {
    const value = values[index % values.length] ?? 0
    index += 1
    return value
  }
}

describe('Worker 停顿的编排（stallSchedule）', () => {
  it('runs 40（真实 Safari 与本机的实测）：1–1.5 秒那一档每个条件 40 次，0.2 秒 20 次、3 秒 10 次、10 秒 5 次；一组最多 10 次', () => {
    const blocks = stallSchedule(40, Math.random)
    const count = (keepAlive: boolean, level: string): number => blocks.filter(block => block.keepAlive === keepAlive && block.level.id === level).reduce((total, block) => total + block.idles.length, 0)
    for (const keepAlive of [false, true])
      expect(STALL_LEVELS.map(level => count(keepAlive, level.id))).toEqual([20, 40, 10, 5])
    expect(blocks.every(block => block.idles.length >= 1 && block.idles.length <= STALL_BLOCK_SIZE)).toBe(true)
    expect(blocks).toHaveLength(2 * (2 + 4 + 1 + 1))
  })

  it('两个条件成对：同一串空闲、一前一后；先后每一组轮流（不总是同一个条件先）', () => {
    const blocks = stallSchedule(40, Math.random)
    const pairs = Array.from({ length: blocks.length / 2 }, (_, index) => [blocks[2 * index], blocks[2 * index + 1]] as const)
    for (const [first, second] of pairs) {
      expect(first?.idles).toBe(second?.idles)
      expect(first?.level).toBe(second?.level)
      expect(first?.keepAlive).not.toBe(second?.keepAlive)
    }
    const firsts = pairs.map(([first]) => first?.keepAlive)
    expect(firsts).toContain(true)
    expect(firsts).toContain(false)
  })

  it('各档轮流：第一轮四档都有，之后只剩次数多的那几档', () => {
    const levels = stallSchedule(40, Math.random).filter((_, index) => index % 2 === 0).map(block => block.level.id)
    expect(levels).toEqual(['0.2s', '1-1.5s', '3s', '10s', '0.2s', '1-1.5s', '1-1.5s', '1-1.5s'])
  })

  it('空闲取值：1–1.5 秒那一档按 random 在区间里均匀取（取整），别的档固定', () => {
    const blocks = stallSchedule(2, sequence(0, 0.5, 0.999))
    const middle = blocks.find(block => block.level.id === '1-1.5s')
    expect(middle?.idles).toEqual([1000, 1250])
    expect(blocks.find(block => block.level.id === '10s')?.idles).toEqual([10_000])
    expect(blocks.find(block => block.level.id === '0.2s')?.idles).toEqual([200])
  })

  it('不带 runs（Playwright 的校准）：只有 0.2 秒与 1–1.5 秒两档、每个条件各一次——只核对探针本身', () => {
    const blocks = stallSchedule(undefined, () => 0)
    expect(blocks.map(block => [block.keepAlive, block.level.id, block.idles])).toEqual([[false, '0.2s', [200]], [true, '0.2s', [200]], [true, '1-1.5s', [1000]], [false, '1-1.5s', [1000]]])
  })

  it('场景的预算：至少是全部空闲之和（按最长的取），次数越多越长；runs 40 时不到 20 分钟', () => {
    const idle = stallSchedule(40, () => 1).reduce((total, block) => total + block.idles.reduce((sum, value) => sum + value, 0), 0)
    expect(stallBudgetMs(40)).toBeGreaterThan(idle)
    expect(stallBudgetMs(40)).toBeLessThan(20 * 60_000)
    expect(stallBudgetMs(undefined)).toBeLessThan(stallBudgetMs(10))
    expect(stallBudgetMs(10)).toBeLessThan(stallBudgetMs(40))
  })
})

describe('生产的发件箱 Worker 的编排（productionStallSchedule，第 9 项的生产部分）', () => {
  it('runs 40：只有开着空定时器的一个条件、只有 ≥ 1 秒的三档——1–1.5 秒 40 次、3 秒 10 次、10 秒 5 次；一组最多 10 次、各档轮流', () => {
    const blocks = productionStallSchedule(40, Math.random)
    expect(blocks.every(block => block.keepAlive)).toBe(true)
    const count = (level: string): number => blocks.filter(block => block.level.id === level).reduce((total, block) => total + block.idles.length, 0)
    expect(['0.2s', '1-1.5s', '3s', '10s'].map(count)).toEqual([0, 40, 10, 5])
    expect(blocks.map(block => block.level.id)).toEqual(['1-1.5s', '3s', '10s', '1-1.5s', '1-1.5s', '1-1.5s'])
    expect(blocks.every(block => block.idles.length <= STALL_BLOCK_SIZE)).toBe(true)
  })

  it('不带 runs（Playwright 的校准）：1–1.5 秒一次；预算随次数变长', () => {
    expect(productionStallSchedule(undefined, () => 0).map(block => [block.keepAlive, block.level.id, block.idles])).toEqual([[true, '1-1.5s', [1000]]])
    expect(productionStallBudgetMs(undefined)).toBeLessThan(productionStallBudgetMs(40))
    expect(productionStallBudgetMs(40)).toBeLessThan(stallBudgetMs(40))
  })
})

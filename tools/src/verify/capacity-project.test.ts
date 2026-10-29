import { expect, it } from 'vitest'
import { CAPACITY_FILE, ORDINARY_FILE, runCapacityFixture } from './capacity-project.test-support.ts'

it.each(['none', 'ordinary', 'capacity'] as const)('正式集成入口先收完普通组再执行容量组，两组错误均传出（%s）', (failure) => {
  const result = runCapacityFixture(failure)
  expect(result.scheduled.map(test => test.file).sort()).toEqual([CAPACITY_FILE, ORDINARY_FILE].sort())
  const ordinary = result.scheduled.find(test => test.file === ORDINARY_FILE)!
  const capacity = result.scheduled.find(test => test.file === CAPACITY_FILE)!
  expect(ordinary.project).toBe('integration')
  expect(capacity.project).toBe('integration-capacity')
  // 同组偶然先后跑完也不代表调度隔离；用实际 Vitest 解析的分组证明不会允许并行。
  expect(capacity.groupOrder).toBeGreaterThan(ordinary.groupOrder)
  expect(result.events).toEqual(['ordinary-test', 'ordinary-teardown-start', 'ordinary-teardown-finished', 'capacity-start'])
  expect(result.status).toBe(failure === 'none' ? 0 : 1)
  expect(result.tests.map(test => `${test.title}:${test.status}`).sort()).toEqual([
    `capacity:${failure === 'capacity' ? 'failed' : 'passed'}`,
    `ordinary:${failure === 'ordinary' ? 'failed' : 'passed'}`,
  ])
}, 15_000)

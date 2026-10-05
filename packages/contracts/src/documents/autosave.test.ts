import { describe, expect, it } from 'vitest'
import {
  AUTOSAVE_CAPTURE_MAX_MS,
  AUTOSAVE_CAPTURE_QUIET_MS,
  AUTOSAVE_CAPTURE_SPACING_FACTOR,
  AUTOSAVE_RETRY_AFTER_MAX_MS,
  AUTOSAVE_RETRY_INITIAL_MS,
  AUTOSAVE_RETRY_MAX_MS,
  AUTOSAVE_UPLOAD_MAX_MS,
  AUTOSAVE_UPLOAD_QUIET_MS,
} from './autosave.ts'

/** 浏览器计时器的上限（毫秒）：setTimeout 的延迟超过它会溢出、立即触发 */
const TIMER_DELAY_MAX_MS = 2 ** 31 - 1

describe('自动保存的节奏（00 号计划书 §7.2、§7.3，M3-P4 设计 §3.1）', () => {
  it('捕获停 1 秒、最长 3 秒；上传停 2 秒、最长 15 秒；退避 2 秒起、上限 60 秒，Retry-After 至多按 5 分钟；大文档的间隔是捕获耗时的 10 倍', () => {
    expect([AUTOSAVE_CAPTURE_QUIET_MS, AUTOSAVE_CAPTURE_MAX_MS, AUTOSAVE_UPLOAD_QUIET_MS, AUTOSAVE_UPLOAD_MAX_MS]).toEqual([1000, 3000, 2000, 15_000])
    expect([AUTOSAVE_RETRY_INITIAL_MS, AUTOSAVE_RETRY_MAX_MS, AUTOSAVE_RETRY_AFTER_MAX_MS, AUTOSAVE_CAPTURE_SPACING_FACTOR]).toEqual([2000, 60_000, 300_000, 10])
  })

  it('Retry-After 的上限不短于退避的上限（服务端要求的更长的等待照样按它），也在浏览器计时器的上限之内（复验 C2）', () => {
    expect(AUTOSAVE_RETRY_AFTER_MAX_MS).toBeGreaterThanOrEqual(AUTOSAVE_RETRY_MAX_MS)
    expect(AUTOSAVE_RETRY_AFTER_MAX_MS).toBeLessThan(TIMER_DELAY_MAX_MS)
  })

  it('两级的先后：静默短于各自的上限；上传的静默不短于捕获的（停顿之后先有捕获、再上传），上传的上限不短于捕获的（上传的是最近一次捕获）', () => {
    expect(AUTOSAVE_CAPTURE_QUIET_MS).toBeLessThan(AUTOSAVE_CAPTURE_MAX_MS)
    expect(AUTOSAVE_UPLOAD_QUIET_MS).toBeLessThan(AUTOSAVE_UPLOAD_MAX_MS)
    expect(AUTOSAVE_UPLOAD_QUIET_MS).toBeGreaterThanOrEqual(AUTOSAVE_CAPTURE_QUIET_MS)
    expect(AUTOSAVE_UPLOAD_MAX_MS).toBeGreaterThanOrEqual(AUTOSAVE_CAPTURE_MAX_MS)
  })

  it('退避：起点不长于上限', () => {
    expect(AUTOSAVE_RETRY_INITIAL_MS).toBeLessThanOrEqual(AUTOSAVE_RETRY_MAX_MS)
  })

  it('都是正的整数毫秒', () => {
    for (const value of [AUTOSAVE_CAPTURE_QUIET_MS, AUTOSAVE_CAPTURE_MAX_MS, AUTOSAVE_UPLOAD_QUIET_MS, AUTOSAVE_UPLOAD_MAX_MS, AUTOSAVE_RETRY_INITIAL_MS, AUTOSAVE_RETRY_MAX_MS, AUTOSAVE_RETRY_AFTER_MAX_MS, AUTOSAVE_CAPTURE_SPACING_FACTOR])
      expect(Number.isInteger(value) && value > 0).toBe(true)
  })
})

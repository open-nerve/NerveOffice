// 子进程把自己的 oom_score_adj 调到最大（M3-P3 设计 §3.3 的子进程池，S5 的加固）：Linux 上写 /proc/self/oom_score_adj，
// 别的平台不写；写不了（/proc 只读、被沙箱拦下）就跳过、不抛出。真的子进程上的效果在 process-pool.test.ts（Linux 上核对写进去了）。
import { describe, expect, it, vi } from 'vitest'
import { CHILD_OOM_SCORE_ADJ, OOM_SCORE_ADJ_PATH, preferOomKill } from './process-task.ts'

describe('preferOomKill', () => {
  it('Linux：把自己的 oom_score_adj 写成 1000（最先被 OOM killer 挑中），写的是自己的（/proc/self），不碰别的进程', () => {
    const write = vi.fn()
    expect(preferOomKill('linux', write)).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('/proc/self/oom_score_adj', '1000')
    expect([OOM_SCORE_ADJ_PATH, CHILD_OOM_SCORE_ADJ]).toEqual(['/proc/self/oom_score_adj', 1000])
  })

  it.each([
    ['只读的 /proc', Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })],
    ['没有权限（沙箱）', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })],
    ['没有这个文件（不是 procfs）', Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })],
  ])('Linux 上写不了（%s）：跳过，不抛出，不影响检查', (_case, failure) => {
    const write = vi.fn(() => {
      throw failure
    })
    expect(preferOomKill('linux', write)).toBe(false)
    expect(write).toHaveBeenCalledOnce()
  })

  it.each(['darwin', 'win32', 'freebsd'] as const)('不是 Linux（%s）：什么也不写', (platform) => {
    const write = vi.fn()
    expect(preferOomKill(platform, write)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})

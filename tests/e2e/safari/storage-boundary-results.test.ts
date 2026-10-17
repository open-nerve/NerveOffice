import { describe, expect, it } from 'vitest'
import { storageBoundaryResultsValid } from './storage-boundary-results.ts'

const done = (value: unknown) => ({ outcome: 'completed', value })
function report() {
  return {
    startedAt: 100,
    finishedAt: 200,
    userAgent: 'Safari test fixture',
    secureContext: true,
    origin: 'http://127.0.0.1:50505',
    operation: 'write',
    persistedBefore: done(false),
    persist: done(false),
    persistedAfter: done(false),
    estimate: done({ usage: 0, quota: 1_000_000 }),
    estimateAfter: done({ usage: 100, quota: 1_000_000 }),
    opfs: { operation: 'write', stages: ['getDirectory', 'getFileHandle', 'createSyncAccessHandle', 'truncate', 'write', 'flush', 'read', 'close'], matched: true, bytes: 10, readBytes: 10, outcome: 'completed' },
    indexedDB: done({ outcome: 'completed', matched: true }),
    visibility: [{ at: 100, state: 'visible' }],
  }
}

describe('Safari 存储边界原始观测的完整性', () => {
  it('记录真实写/flush/读完与持久授权被拒绝，完整不等于永久保留', () => {
    expect(storageBoundaryResultsValid(report())).toBe(true)
  })
  it('根目录实际拒绝是可记录的结果，不冒充同步句柄可用', () => {
    expect(storageBoundaryResultsValid({ ...report(), opfs: { operation: 'write', stages: [], matched: null, bytes: null, outcome: 'error', error: { stage: 'getDirectory', name: 'UnknownError' } } })).toBe(true)
  })
  it('关闭重开后文件和 IndexedDB 都缺失仍是完整观测', () => {
    expect(storageBoundaryResultsValid({ ...report(), operation: 'read', opfs: { operation: 'read', stages: ['getDirectory'], matched: null, bytes: null, outcome: 'error', error: { stage: 'getFileHandle', name: 'NotFoundError' } }, indexedDB: done({ outcome: 'missing', upgradedThenAborted: true }) })).toBe(true)
  })
  it.each([
    { persist: undefined },
    { estimate: done({ quota: -1, usage: 0 }) },
    { persistedBefore: done('true') },
    { persist: { outcome: 'timeout' } },
    { opfs: { outcome: 'worker-error' } },
    { indexedDB: { outcome: 'timeout' } },
    { opfs: { ...report().opfs, cleanupFailed: true } },
    { opfs: { ...report().opfs, stages: ['getDirectory', 'getFileHandle', 'read', 'close'] } },
    { opfs: { ...report().opfs, operation: 'read' } },
  ])('缺项、错误类型、跳过实际步骤或超时不能记成已验证观测 %j', (change) => {
    expect(storageBoundaryResultsValid({ ...report(), ...change })).toBe(false)
  })
})

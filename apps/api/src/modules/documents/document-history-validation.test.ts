import type { HistoryMaterial } from './document-history.repository.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { sheetSnapshotFor, SNAPSHOT_MAX_RAW_BYTES, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { DocumentHistoryValidation } from './document-history-validation.ts'
import { inspectSnapshot } from './snapshot-inspection.ts'
import { SnapshotInspector } from './snapshot-inspector.ts'

const ID = '0199a2c4-0000-7000-8000-000000000001'
const RAW = Buffer.from(sheetSnapshotFor(ID))
const inspectors: SnapshotInspector[] = []

function setup() {
  const inspector = new SnapshotInspector({ processes: 1, queue: { maxWaiting: 2, maxWaitMs: 1000 }, timeoutMs: 10000, heapMb: 512 }, new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore()))
  inspectors.push(inspector)
  return { inspector, validation: new DocumentHistoryValidation(inspector) }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const inspector of inspectors.splice(0))
    await inspector.onApplicationShutdown()
})

function material(raw = RAW, patch: Partial<HistoryMaterial> = {}): HistoryMaterial {
  const snapshot = gzipSync(raw)
  return {
    id: ID,
    sourceDocumentId: ID,
    unitId: ID,
    revision: 1,
    title: '原历史',
    type: 'sheet',
    profile: 'sheet@1',
    formatVersion: 1,
    sdkVersion: UNIVER_SDK_VERSION,
    clientBuild: null,
    formulasPending: false,
    rawBytes: raw.length,
    storedBytes: snapshot.length,
    snapshot,
    snapshotHash: createHash('sha256').update(snapshot).digest(),
    contentHash: null,
    resourceNames: null,
    savedBy: ID,
    savedAt: new Date('2026-10-22T08:00:00Z'),
    createdAt: new Date('2026-10-22T08:00:00Z'),
    expiresAt: new Date('2026-10-22T08:00:00Z'),
    position: '',
    ...patch,
  }
}
function withCompressed(snapshot: Buffer): HistoryMaterial {
  return material(RAW, { snapshot, storedBytes: snapshot.length, snapshotHash: createHash('sha256').update(snapshot).digest() })
}
function signal() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('历史恢复的完整性检查', () => {
  it('旧空摘要与现代摘要都允许，原 gzip 字节不被重新序列化', async () => {
    const { validation } = setup()
    const legacy = material()
    const verified = await validation.validate(legacy, ID)
    expect(verified.record.snapshot).toEqual(legacy.snapshot)
    expect(verified).toMatchObject({ profile: 'sheet@1', formatVersion: 1 })
    const inspected = inspectSnapshot(RAW, 'sheet@1')
    if (!inspected.ok)
      throw new Error('测试的模板应合法')
    const modern = material(RAW, { contentHash: Buffer.from(inspected.contentHash), resourceNames: inspected.nonEmptyResources })
    expect((await validation.validate(modern, ID)).record.snapshot).toEqual(modern.snapshot)
  })

  const invalid: readonly [string, () => HistoryMaterial][] = [
    ['压缩摘要不一致', () => material(RAW, { snapshotHash: Buffer.alloc(32) })],
    ['原始长度不一致', () => material(RAW, { rawBytes: RAW.length + 1 })],
    ['压缩长度不一致', () => material(RAW, { storedBytes: 1 })],
    ['压缩体超过上限', () => withCompressed(Buffer.alloc(SNAPSHOT_MAX_RAW_BYTES + 1))],
    ['解压体超过上限', () => material(Buffer.alloc(SNAPSHOT_MAX_RAW_BYTES + 1))],
    ['截断 gzip', () => withCompressed(gzipSync(RAW).subarray(0, -1))],
    ['两个 gzip 成员', () => withCompressed(Buffer.concat([gzipSync(RAW), gzipSync(RAW)]))],
    ['尾随垃圾', () => withCompressed(Buffer.concat([gzipSync(RAW), Buffer.from('x')]))],
    ['非法 JSON', () => material(Buffer.from('{private broken JSON'))],
    ['非法表格结构', () => material(Buffer.from('{}'))],
    ['身份与历史信封不符', () => material(RAW, { unitId: 'different-unit' })],
    ['未知插件档案', () => material(RAW, { profile: 'sheet@999' })],
    ['未知平台格式', () => material(RAW, { formatVersion: 999 })],
    ['较新 SDK', () => material(RAW, { sdkVersion: '999.0.0' })],
    ['规范摘要不符', () => material(RAW, { contentHash: Buffer.alloc(32), resourceNames: [] })],
    ['资源集合不符', () => {
      const inspected = inspectSnapshot(RAW, 'sheet@1')
      if (!inspected.ok)
        throw new Error('测试模板不合法')
      return material(RAW, { contentHash: Buffer.from(inspected.contentHash), resourceNames: ['SHEET_MISSING_PLUGIN'] })
    }],
    ['半份旧信封', () => material(RAW, { contentHash: Buffer.alloc(32), resourceNames: null })],
  ]
  it.each(invalid)('%s：明确 422，不返回正文诊断', async (_name, build) => {
    const { validation } = setup()
    await expect(validation.validate(build(), ID)).rejects.toMatchObject({ code: 'HISTORY_UNUSABLE', status: 422, details: undefined })
  })

  it('检查池忙/超时保留 503，不把暂时失败说成历史损坏', async () => {
    const { validation, inspector } = setup()
    const busy = new AppError('SERVICE_UNAVAILABLE', undefined, { headers: { 'Retry-After': '3' } })
    vi.spyOn(inspector, 'inspect').mockRejectedValueOnce(busy)
    await expect(validation.validate(material(), ID)).rejects.toBe(busy)
  })
})

describe('历史恢复准入覆盖加载到写入完成', () => {
  it('同账户只许一份，全局只许两份，拒绝发生在加载正文回调之前，释放后能继续', async () => {
    const { validation } = setup()
    const release = signal()
    const enteredA = signal()
    const enteredB = signal()
    const first = validation.admit('a', async () => {
      enteredA.resolve()
      await release.promise
    })
    const second = validation.admit('b', async () => {
      enteredB.resolve()
      await release.promise
    })
    await Promise.all([enteredA.promise, enteredB.promise])
    const load = vi.fn(async () => 'loaded')
    try {
      await expect(validation.admit('a', load)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', headers: { 'Retry-After': '5' } })
      await expect(validation.admit('c', load)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(load).not.toHaveBeenCalled()
    }
    finally {
      release.resolve()
      await Promise.all([first, second])
    }
    expect(await validation.admit('c', load)).toBe('loaded')
    expect(await validation.admit('a', load)).toBe('loaded')
  })

  it('加载、验证或写事务异常都释放账户和全局名额', async () => {
    const { validation } = setup()
    for (const message of ['load', 'validate', 'write']) {
      await expect(validation.admit('a', async () => {
        throw new Error(message)
      })).rejects.toThrow(message)
      expect(await validation.admit('a', async () => 'ok')).toBe('ok')
    }
  })
})

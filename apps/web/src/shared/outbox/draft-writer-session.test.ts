import type { StoreProblem } from './draft-store.ts'
import type { CaptureToWrite } from './draft-writer.ts'
import { describe, expect, it, vi } from 'vitest'
import { createDraftMirror } from './draft-mirror.ts'
import { NOW, sampleMeta } from './draft-record.test-support.ts'
import { createDraftRecovery, pageReconciliation, reconcileAll } from './draft-recovery.ts'
import { fakeDraftStore } from './draft-store.test-support.ts'
import { createDraftWriter } from './draft-writer.ts'
import { fakeMirrorDirectory } from './mirror-directory.test-support.ts'

const META = sampleMeta()
const KEY = { userId: META.userId, documentId: META.documentId }
const WRITER = { writeEpoch: META.writeEpoch, writerId: META.writerId }
const CAPTURE: Omit<CaptureToWrite, 'draftSeq'> = {
  key: KEY,
  writer: WRITER,
  baseRevision: META.baseRevision,
  writtenBy: META.writtenBy,
  format: META.format,
  formulasPending: false,
  inFlight: null,
  bytes: new TextEncoder().encode('same body'),
  dedupe: true,
}

async function setup(written = true) {
  const fake = fakeDraftStore()
  const files = fakeMirrorDirectory()
  const mirror = createDraftMirror({ directory: files.directory, clock: { now: () => NOW } })
  let problem: StoreProblem | undefined
  const check = vi.fn(async () => problem ?? { kind: 'bound' as const })
  const store = { ...fake.store, checkSession: check }
  const writer = createDraftWriter({ store, directory: files.directory, mirror, recovery: createDraftRecovery({ store, mirror, now: () => NOW }), now: () => NOW })
  const handle = { version: META.keyVersion, key: await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']) }
  await writer.setKey(handle)
  if (written) {
    expect((await writer.register(KEY, WRITER, false)).kind).toBe('registered')
    expect((await writer.write({ ...CAPTURE, draftSeq: 1 })).kind).toBe('written')
  }
  return { fake, store, files, mirror, writer, check, refuse: (value: StoreProblem = { kind: 'session-invalid' }) => {
    problem = value
  } }
}

describe('宿主缓存与镜像也受会话资格保护', () => {
  it('首次登记失效时不创建镜像句柄或写入者', async () => {
    const t = await setup(false)
    const attach = vi.spyOn(t.mirror, 'attach')
    t.refuse()
    expect(await t.writer.register(KEY, WRITER, true)).toEqual({ kind: 'session-invalid' })
    expect(attach).not.toHaveBeenCalled()
    expect(t.fake.calls).not.toContain('registerWriter')
  })

  it('已有去重缓存也不能把旧会话的捕获报告为 unchanged，原件与水位不变', async () => {
    const t = await setup()
    const before = [t.fake.rawDraft(KEY), t.fake.rawWriter(KEY)]
    const writeMirror = vi.spyOn(t.mirror, 'write')
    t.refuse()
    expect(await t.writer.write({ ...CAPTURE, draftSeq: 2 })).toEqual({ kind: 'session-invalid', gzip: null })
    expect([t.fake.rawDraft(KEY), t.fake.rawWriter(KEY)]).toEqual(before)
    expect(writeMirror).not.toHaveBeenCalled()
  })

  for (const operation of ['read', 'observe', 'reconcile'] as const) {
    it(`${operation} 失效时不打开镜像，不回退到旧正文`, async () => {
      const t = await setup()
      const readMirror = vi.spyOn(t.mirror, 'read')
      const before = t.fake.calls.length
      t.refuse()
      expect(await t.writer[operation](KEY)).toEqual({ kind: 'session-invalid' })
      expect(readMirror).not.toHaveBeenCalled()
      expect(t.fake.calls.slice(before)).toEqual([])
    })
  }

  it('镜像目录和提示列表不能在失效后继续列出，不能伪装为空目录', async () => {
    const t = await setup()
    const listMirror = vi.spyOn(t.mirror, 'documents')
    const listNotices = vi.spyOn(t.store, 'listNotices')
    t.refuse()
    expect(await t.writer.mirroredDocuments(KEY.userId)).toEqual({ kind: 'session-invalid' })
    expect(await t.writer.notices(KEY.userId)).toEqual({ kind: 'session-invalid' })
    expect(listMirror).not.toHaveBeenCalled()
    expect(listNotices).not.toHaveBeenCalled()
  })

  it('原件观察失效后删除不碰主库或镜像；release 仍能放开旧句柄', async () => {
    const t = await setup()
    const observed = await t.writer.observe(KEY)
    if (observed.kind !== 'observed')
      throw new Error('应取得原件观察')
    const before = t.fake.rawDraft(KEY)
    const remove = vi.spyOn(t.files.directory, 'removeDocument')
    const detach = vi.spyOn(t.mirror, 'detach')
    t.refuse()
    expect(await t.writer.removeObserved(observed.observation)).toEqual({ kind: 'session-invalid' })
    expect(t.fake.rawDraft(KEY)).toEqual(before)
    expect(remove).not.toHaveBeenCalled()
    await t.writer.release(KEY)
    expect(detach).toHaveBeenCalledExactlyOnceWith(KEY)
  })

  it.each([
    { kind: 'quota' },
    { kind: 'unavailable', reason: 'blocked' },
    { kind: 'failed', error: { name: 'UnknownError', message: '连接中止' } },
  ] as const)('资格核对失败 %j 时没有目录回退或缓存成功', async (problem) => {
    const t = await setup()
    t.refuse(problem)
    expect(await t.writer.write({ ...CAPTURE, draftSeq: 2 })).toEqual({ ...problem, gzip: null })
    expect(await t.writer.mirroredDocuments(KEY.userId)).toEqual(problem)
  })
})

describe('平台比对来源也在镜像之前核对资格', () => {
  it.each([{ kind: 'session-invalid' }, { kind: 'quota' }, { kind: 'unavailable', reason: 'blocked' }] as const)('%j 不列目录、不读镜像、不假报为空', async (problem) => {
    const fake = fakeDraftStore()
    const files = fakeMirrorDirectory()
    const list = vi.spyOn(files.directory, 'listDocuments')
    const read = vi.spyOn(files.directory, 'readSlots')
    const store = { ...fake.store, checkSession: async () => problem }
    const source = pageReconciliation({ store, directory: files.directory, now: () => NOW })
    expect(await reconcileAll(source, KEY.userId)).toEqual(problem)
    expect(await source.reconcile(KEY)).toEqual(problem)
    expect(list).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(fake.calls).toEqual([])
  })
})

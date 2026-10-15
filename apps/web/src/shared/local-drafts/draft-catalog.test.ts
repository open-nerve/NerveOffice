import type { CreatedDocument, DocumentDraftFact } from '@nerve-office/contracts'
import type { DraftMeta } from '../outbox/draft-record.ts'
import type { DraftRecoveryFactory } from './draft-catalog.ts'
import type { DraftInventory } from './draft-inventory.ts'
import type { LostCopyOptions } from './lost-copy.ts'
import type { RecoveryReader } from './recovery-reader.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../api/index.ts'
import { gzipBytes, sealDraft } from '../outbox/draft-codec.ts'
import { DOCUMENT_ID, NOW, sampleMeta, sampleWriter, USER_ID } from '../outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../outbox/draft-store.test-support.ts'
import { createDraftWriter } from '../outbox/draft-writer.ts'
import { fakeLeaseClock } from '../outbox/fake-lease-clock.test-support.ts'
import { fakeMirrorDirectory } from '../outbox/mirror-directory.test-support.ts'
import { deferred } from '../outbox/outbox-lock.test-support.ts'
import { createDocumentRecovery } from './document-recovery.ts'
import { createDraftCatalog } from './draft-catalog.ts'

const OTHER_ID = '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2'
const KEY = { userId: USER_ID, documentId: DOCUMENT_ID }
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))

async function setup() {
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory()
  const handle = { version: 2, key: await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']) }
  const put = async (id: string, body = '原未同步内容', overrides: Partial<DraftMeta> = {}) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ body }))
    const meta = sampleMeta({ documentId: id, baseRevision: 7, inFlight: null, rawBytes: bytes.byteLength, ...overrides })
    const record = await sealDraft(handle, meta, await gzipBytes(bytes))
    store.putRaw('drafts', { userId: USER_ID, documentId: id }, record)
    store.putRaw('writers', { userId: USER_ID, documentId: id }, sampleWriter({ documentId: id }))
    return record
  }
  await put(DOCUMENT_ID)
  await put(OTHER_ID)
  let alive = true
  let activeReaders = 0
  let maxReaders = 0
  let count = 0
  const createdReaders: string[] = []
  const facts = new Map<string, DocumentDraftFact>([DOCUMENT_ID, OTHER_ID].map(id => [id, { status: 'accessible', id, title: `标题-${id}`, type: 'sheet', canEdit: true, revision: 7, revisionSource: null, occupied: false }]))
  const readFacts = vi.fn(async (ids: readonly string[]): Promise<ReadonlyMap<string, DocumentDraftFact>> => new Map(ids.flatMap((id) => {
    const fact = facts.get(id)
    return fact === undefined ? [] : [[id, fact] as const]
  })))
  const inventory = { load: vi.fn(async (): Promise<DraftInventory> => ({ kind: 'listed', entries: [DOCUMENT_ID, OTHER_ID].map(documentId => ({ documentId, updatedAt: NOW, mirrorOnly: false })), incomplete: false })), dispose: vi.fn() }
  const conflictCopy = vi.fn<LostCopyOptions['conflictCopy']>().mockResolvedValue({ id: 'copied', title: '副本', revision: 1 } as CreatedDocument)
  const make: DraftRecoveryFactory = ({ documentId, facts: currentFacts, title }) => createDocumentRecovery({
    key: { userId: USER_ID, documentId },
    pageFormat: sampleMeta().format,
    writtenBy: 'catalog-page',
    clock: fakeLeaseClock(NOW).clock,
    now: () => NOW,
    still: () => alive,
    facts: currentFacts,
    title,
    newId: () => `copy-${++count}`,
    conflictCopy,
    replay: vi.fn(),
    refreshCloud: async () => {},
    onSessionProblem: vi.fn(),
    reportError: vi.fn(),
    reader: () => {
      createdReaders.push(documentId)
      activeReaders += 1
      maxReaders = Math.max(maxReaders, activeReaders)
      const writer = createDraftWriter({ store: store.store, directory: files.directory, now: () => NOW })
      const ready = writer.setKey(handle)
      let closed = false
      const reader: RecoveryReader = {
        observe: async () => {
          await ready
          return writer.observe({ userId: USER_ID, documentId })
        },
        refreshKey: async () => writer.observe({ userId: USER_ID, documentId }),
        remove: writer.removeObserved,
        notices: async () => writer.notices(USER_ID),
        clearNotice: async at => writer.clearNotice({ userId: USER_ID, documentId }, at),
        dispose: () => {
          if (closed)
            return
          closed = true
          activeReaders -= 1
          writer.dispose()
        },
      }
      return reader
    },
  })
  const catalog = createDraftCatalog({ inventory, readFacts, makeRecovery: make, still: () => alive })
  cleanups.push(catalog.dispose)
  return { catalog, store, files, facts, readFacts, conflictCopy, put, inventory, readers: () => activeReaders, maxReaders: () => maxReaders, createdReaders, expire: () => {
    alive = false
  } }
}

describe('草稿目录复用共享恢复，逐份借用正文', () => {
  it('目录资格失效清空已完成副本标题与旧条目，不能把旧视图留给后来登录者', async () => {
    const h = await setup()
    await h.catalog.refresh()
    await h.catalog.copy(DOCUMENT_ID)
    expect(h.catalog.view().completedCopies).toHaveLength(1)
    h.inventory.load.mockResolvedValueOnce({ kind: 'unavailable', reason: 'session' })
    await h.catalog.refresh()
    expect(h.catalog.view()).toMatchObject({ problem: 'session', rows: [], completedCopies: [], uncertainCopies: [] })
    expect(h.inventory.dispose).toHaveBeenCalledOnce()
    expect(h.readers()).toBe(0)
  })

  it('发现串行且每份释放；目录视图无正文或密文，批量事实不额外逐条请求', async () => {
    const h = await setup()
    await h.catalog.refresh()
    expect(h.catalog.view()).toMatchObject({ busy: undefined, rows: [{ documentId: DOCUMENT_ID, title: `标题-${DOCUMENT_ID}`, recovery: { decision: { kind: 'restore' } } }, { documentId: OTHER_ID, recovery: { decision: { kind: 'restore' } } }] })
    expect(h.maxReaders()).toBe(1)
    expect(h.readers()).toBe(0)
    expect(h.readFacts).toHaveBeenCalledExactlyOnceWith([DOCUMENT_ID, OTHER_ID])
    expect(JSON.stringify(h.catalog.view())).not.toMatch(/原未同步内容|ciphertext|gzip|snapshot/)
  })

  it('不可读批量事实必须再次确认；恢复为可读时不使用旧事实删除', async () => {
    const h = await setup()
    h.readFacts.mockResolvedValueOnce(new Map([[DOCUMENT_ID, { status: 'unavailable', id: DOCUMENT_ID }], [OTHER_ID, h.facts.get(OTHER_ID)!]]))
    await h.catalog.refresh()
    expect(h.readFacts).toHaveBeenNthCalledWith(2, [DOCUMENT_ID])
    expect(h.store.rawDraft(KEY)).toBeDefined()
    expect(h.catalog.view().rows[0]?.recovery?.decision?.kind).toBe('restore')
  })

  it('网络未知不删除，并清除先前的标题和可恢复状态', async () => {
    const h = await setup()
    await h.catalog.refresh()
    h.readFacts.mockRejectedValue(new NetworkError())
    await h.catalog.refresh()
    expect(h.catalog.view()).toMatchObject({ problem: 'facts', rows: [{ title: undefined, recovery: { decision: { kind: 'preserve', reason: 'session' } } }, { title: undefined }] })
    expect(h.store.rawDraft(KEY)).toBeDefined()
  })

  it.each(['销毁', '会话改变'])('%s发生在批量查询中，迟到标题和正文不再进入视图', async (action) => {
    const h = await setup()
    const wait = deferred<ReadonlyMap<string, DocumentDraftFact>>()
    h.readFacts.mockImplementationOnce(async () => wait.promise)
    const pending = h.catalog.refresh()
    await vi.waitFor(() => expect(h.readFacts).toHaveBeenCalledOnce())
    if (action === '销毁')
      h.catalog.dispose()
    else
      h.expire()
    wait.resolve(h.facts)
    await pending
    expect(h.catalog.view().rows).toEqual([])
    expect(h.createdReaders).toEqual([])
  })

  it('确认弹窗等待期间同 seq 原件被换掉，旧确认不能删除新内容', async () => {
    const h = await setup()
    await h.catalog.refresh()
    const intent = await h.catalog.prepareDiscard(DOCUMENT_ID)
    expect(intent).toMatchObject({ documentId: DOCUMENT_ID, updatedAt: NOW })
    const replacement = await h.put(DOCUMENT_ID, '同序号的新内容')
    await h.catalog.refresh()
    expect(h.catalog.view().stale).toBe(true)
    if (intent === undefined)
      throw new Error('缺少确认意图')
    await h.catalog.discard(intent)
    expect(h.store.rawDraft(KEY)).toEqual(structuredClone(replacement))
    expect(h.catalog.view().rows[0]?.recovery?.cleanup?.kind).toBe('changed')
    expect(h.readers()).toBe(0)
  })

  it('取消确认不删，释放读者；旧确认也不能再次提交', async () => {
    const h = await setup()
    await h.catalog.refresh()
    const intent = await h.catalog.prepareDiscard(DOCUMENT_ID)
    if (intent === undefined)
      throw new Error('缺少确认意图')
    h.catalog.cancelDiscard(intent)
    await h.catalog.discard(intent)
    expect(h.store.rawDraft(KEY)).toBeDefined()
    expect(h.readers()).toBe(0)
  })

  it('未知副本阻止另一份解密，重试原请求/标题/gzip；别页的新原件保留', async () => {
    const h = await setup()
    await h.catalog.refresh()
    h.conflictCopy.mockRejectedValueOnce(new NetworkError())
    await h.catalog.copy(DOCUMENT_ID)
    const sent = h.conflictCopy.mock.calls[0]!
    const query = structuredClone(sent[1])
    const gzip = Array.from(sent[2])
    expect(h.catalog.view().copyPending).toBe(DOCUMENT_ID)
    const opened = h.createdReaders.length
    await h.catalog.copy(OTHER_ID)
    await h.catalog.refresh()
    expect(h.createdReaders).toHaveLength(opened)
    const next = await h.put(DOCUMENT_ID, '别页写入')
    h.facts.set(DOCUMENT_ID, { ...h.facts.get(DOCUMENT_ID)!, title: '之后改的标题' } as DocumentDraftFact)
    await h.catalog.copy(DOCUMENT_ID)
    expect(h.conflictCopy).toHaveBeenCalledTimes(2)
    expect(h.conflictCopy.mock.calls[1]?.[1]).toEqual(query)
    expect(Array.from(h.conflictCopy.mock.calls[1]![2])).toEqual(gzip)
    expect(h.store.rawDraft(KEY)).toEqual(structuredClone(next))
    expect(h.catalog.view().rows[0]?.recovery).toMatchObject({ copy: { kind: 'done', document: { id: 'copied' } }, cleanup: { kind: 'changed' } })
    expect(h.catalog.view().copyPending).toBeUndefined()
    await h.catalog.copy(DOCUMENT_ID)
    expect(h.conflictCopy).toHaveBeenCalledTimes(2)
    expect(h.store.rawDraft(KEY)).toEqual(structuredClone(next))
    await h.catalog.refresh()
    expect(h.catalog.view().completedCopies.map(document => document.id)).toEqual(['copied'])
  })

  it('镜像忙时主记录已删但镜像仍在，结果不能说全部清理完成', async () => {
    const h = await setup()
    await h.catalog.refresh()
    h.files.putFile(KEY, 0, new Uint8Array([1]))
    const release = h.files.holdElsewhere(KEY)
    cleanups.push(release)
    const intent = await h.catalog.prepareDiscard(DOCUMENT_ID)
    if (intent === undefined)
      throw new Error('缺少确认意图')
    await h.catalog.discard(intent)
    expect(h.store.rawDraft(KEY)).toBeUndefined()
    expect(h.files.file(KEY, 0)).toBeDefined()
    expect(h.catalog.view().rows[0]?.recovery?.cleanup).toEqual({ kind: 'removed', mirror: { kind: 'busy' } })
  })

  it('副本未知后已确定不可读：不重发副本，释放旧内容并走共享条件清理，仍说明旧请求未知', async () => {
    const h = await setup()
    await h.catalog.refresh()
    h.conflictCopy.mockRejectedValueOnce(new NetworkError())
    await h.catalog.copy(DOCUMENT_ID)
    h.facts.set(DOCUMENT_ID, { status: 'unavailable', id: DOCUMENT_ID })
    await h.catalog.copy(DOCUMENT_ID)
    expect(h.conflictCopy).toHaveBeenCalledOnce()
    expect(h.store.rawDraft(KEY)).toBeUndefined()
    expect(h.catalog.view().copyPending).toBeUndefined()
    expect(h.catalog.view().rows[0]).toMatchObject({ title: undefined, copyUncertain: true, recovery: { decision: { kind: 'remove', reason: 'unreadable' }, stage: 'finished' } })
    expect(h.readers()).toBe(0)
  })

  it('清理失败的重试仍使用旧观察；重试期间的新原件保持', async () => {
    const h = await setup()
    await h.catalog.refresh()
    const intent = await h.catalog.prepareDiscard(DOCUMENT_ID)
    if (intent === undefined)
      throw new Error('缺少确认意图')
    h.store.failNext('removeObserved', { kind: 'quota' })
    await h.catalog.discard(intent)
    expect(h.catalog.view().rows[0]?.recovery?.cleanup?.kind).toBe('quota')
    const replacement = await h.put(DOCUMENT_ID, '清理失败后新内容')
    await h.catalog.retryCleanup(DOCUMENT_ID)
    expect(h.store.rawDraft(KEY)).toEqual(structuredClone(replacement))
    expect(h.catalog.view().rows[0]?.recovery?.cleanup?.kind).toBe('changed')
    expect(h.readers()).toBe(0)
  })

  it('较新格式只保留；目录不能把放弃当作绕过方式', async () => {
    const h = await setup()
    h.store.putRaw('drafts', KEY, { ...(h.store.rawDraft(KEY) as object), recordVersion: 99 })
    await h.catalog.refresh()
    expect(h.catalog.view().rows[0]?.recovery?.decision).toEqual({ kind: 'preserve', reason: 'newer-format' })
    expect(await h.catalog.prepareDiscard(DOCUMENT_ID)).toBeUndefined()
    expect(h.store.rawDraft(KEY)).toBeDefined()
  })
})

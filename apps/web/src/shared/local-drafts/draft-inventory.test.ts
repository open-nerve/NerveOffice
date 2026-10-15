import type { MirrorDirectory } from '../outbox/mirror-directory.ts'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID, NOW, OTHER_USER_ID, sampleStoredDraft, sampleWriter, USER_ID } from '../outbox/draft-record.test-support.ts'
import { fakeDraftStore } from '../outbox/draft-store.test-support.ts'
import { fakeMirrorDirectory } from '../outbox/mirror-directory.test-support.ts'
import { encodeSlot } from '../outbox/mirror-slot.ts'
import { testSessionPermit } from '../outbox/session-fence.test-support.ts'
import { createDraftInventory } from './draft-inventory.ts'

const key = { userId: USER_ID, documentId: DOCUMENT_ID }
const other = { userId: USER_ID, documentId: '0199b0c4-7d3e-7a3b-9c4e-00000000d0c2' }

function setup(override: (directory: MirrorDirectory) => MirrorDirectory = value => value) {
  const store = fakeDraftStore()
  const files = fakeMirrorDirectory({ clock: () => NOW })
  let live = true
  const inventory = createDraftInventory({ permit: testSessionPermit(), still: () => live, store: store.store, directory: override(files.directory), now: () => NOW })
  return { store, files, inventory, expire: () => {
    live = false
  } }
}

describe('本人草稿目录（未解密元数据）', () => {
  it.each(['load', 'check'] as const)('%s 首次绑定因暂时读盘失败时，重试重新核对同一许可', async (method) => {
    const { store, inventory } = setup()
    store.failNext('bindSession', { kind: 'unavailable', reason: 'blocked' })
    expect(await inventory[method]()).toEqual(method === 'load' ? { kind: 'unavailable', reason: 'storage' } : 'storage')
    expect(await inventory[method]()).toEqual(method === 'load' ? { kind: 'listed', entries: [], incomplete: false } : 'active')
    expect(store.calls.filter(call => call === 'bindSession')).toHaveLength(2)
  })

  it('网络元数据回包后可单独核对原许可；被拒与暂时读盘失败区分', async () => {
    const { store, inventory } = setup()
    expect(inventory.check).toBeTypeOf('function')
    expect(await inventory.check()).toBe('active')
    store.failNext('checkSession', { kind: 'session-invalid' })
    expect(await inventory.check()).toBe('session')
    store.failNext('checkSession', { kind: 'unavailable', reason: 'blocked' })
    expect(await inventory.check()).toBe('storage')
    inventory.dispose()
    expect(await inventory.check()).toBe('session')
  })

  it('先把镜像中新版本写回，再列主库；不列另一个用户，不交正文/密文', async () => {
    const { store, files, inventory } = setup()
    store.putRaw('drafts', key, sampleStoredDraft({ draftSeq: 6, inFlight: null }))
    store.putRaw('writers', key, sampleWriter({ lastDraftSeq: 6 }))
    store.putRaw('drafts', { ...key, userId: OTHER_USER_ID }, sampleStoredDraft({ userId: OTHER_USER_ID }))
    const { header, content } = await encodeSlot(sampleStoredDraft({ updatedAt: NOW + 1 }), 1)
    files.putFile(key, 0, new Uint8Array([...header, ...content]))
    expect(await inventory.load()).toEqual({ kind: 'listed', entries: [{ documentId: DOCUMENT_ID, updatedAt: NOW + 1, mirrorOnly: false }], incomplete: false })
    expect(store.calls.indexOf('restoreDraft')).toBeLessThan(store.calls.indexOf('listDrafts'))
    inventory.dispose()
    expect(store.closed()).toBe(1)
  })

  it('非空的未知镜像保留，空槽位和别人的镜像不冒充草稿', async () => {
    const { files, inventory } = setup()
    files.putFile(key, 0, new Uint8Array([1, 2, 3]))
    files.putFile(other, 0, new Uint8Array())
    files.putFile({ ...other, userId: OTHER_USER_ID }, 0, new Uint8Array([9]))
    expect(await inventory.load()).toEqual({ kind: 'listed', entries: [{ documentId: DOCUMENT_ID, updatedAt: undefined, mirrorOnly: true }], incomplete: false })
  })

  it('镜像读取失败保留已知文档，主库失败也不能报空；不以缺失的时间冒充现在', async () => {
    const { files, store, inventory } = setup(directory => ({ ...directory, readSlots: async () => ({ kind: 'failed', error: new Error('读失败') }), slotFiles: async () => ({ kind: 'busy' }) }))
    files.putFile(key, 0, new Uint8Array([1]))
    store.failNext('listDrafts', { kind: 'unavailable', reason: 'denied' })
    expect(await inventory.load()).toEqual({ kind: 'listed', entries: [{ documentId: DOCUMENT_ID, updatedAt: undefined, mirrorOnly: true }], incomplete: true })
  })

  it('镜像目录无法列出时仍显示主库，明确目录不完整', async () => {
    const { store, inventory } = setup(directory => ({ ...directory, listDocuments: async () => ({ kind: 'failed', error: new Error('目录失败') }) }))
    store.putRaw('drafts', key, sampleStoredDraft())
    expect(await inventory.load()).toEqual({ kind: 'listed', entries: [{ documentId: DOCUMENT_ID, updatedAt: NOW, mirrorOnly: false }], incomplete: true })
  })

  it('没有许可不读存储；事务拒绝许可不返回旧用户条目', async () => {
    const { store, files, inventory } = setup()
    const missing = createDraftInventory({ permit: undefined, still: () => true, store: store.store, directory: files.directory })
    expect(await missing.load()).toEqual({ kind: 'unavailable', reason: 'session' })
    expect(store.calls).toEqual([])
    store.failNext('checkSession', { kind: 'session-invalid' })
    expect(await inventory.load()).toEqual({ kind: 'unavailable', reason: 'session' })
    expect(store.calls).not.toContain('listDrafts')
  })

  it.each(['换会话', '销毁'])('%s发生在列库期间时，迟到结果不能回到页面', async (action) => {
    const { store, inventory, expire } = setup()
    store.putRaw('drafts', key, sampleStoredDraft())
    const held = store.holdNext('listDrafts')
    const pending = inventory.load()
    await held.reached
    if (action === '销毁')
      inventory.dispose()
    else
      expire()
    held.release()
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'session' })
  })

  it('保留属于本人的丢失/过期提示，即使记录已经不在', async () => {
    const { store, inventory } = setup()
    store.putRaw('notices', key, { ...key, kind: 'lost', at: NOW })
    expect(await inventory.load()).toMatchObject({ kind: 'listed', entries: [{ documentId: DOCUMENT_ID, mirrorOnly: false }] })
  })
})

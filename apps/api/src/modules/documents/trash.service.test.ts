// TrashService 的规则（M2-P4 S3 的 spec）：谁能删、删除单元的粒度与"不重组"、恢复的回落、永久删除的连带、
// 取锁的顺序与审计。真实的 SQL（递归展开、整棵更新、外键的连带）由集成测试用真实数据库覆盖。
import type { FolderRow } from './folders.repository.ts'
import { Buffer } from 'node:buffer'
import { AUDIT_DETAILS_MAX_BYTES } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { ALICE, ALICE_SPACE, BOB, FakeStore, HTTP_ORIGIN, member, TEAM_SPACE } from './documents.test-support.ts'
import { TrashEntryPurger } from './trash-entry-purger.ts'
import { TrashService } from './trash.service.ts'

const MISSING = '0199a2c4-0000-7000-8000-0000000000fd'

function setup() {
  const store = new FakeStore()
  const { transactions, documents, folders, entries, tree, spaces, policy, audit, writeAccess } = store.deps
  const purger = new TrashEntryPurger(documents, folders, entries, audit)
  return { store, service: new TrashService(transactions, documents, folders, entries, tree, spaces, policy, audit, writeAccess, purger) }
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(() => undefined, (rejected: unknown) => rejected)
  if (!(error instanceof AppError))
    throw new Error(`期望抛出 AppError，实际是 ${String(error)}`)
  return error
}

/** 在某个空间里建一条 depth 层的链 */
function chain(store: FakeStore, spaceId: string, depth: number): FolderRow[] {
  const rows: FolderRow[] = []
  for (let level = 0; level < depth; level += 1)
    rows.push(store.addFolder({ spaceId, parentId: rows.at(-1)?.id ?? null, name: `第 ${level + 1} 层` }))
  return rows
}

describe('TrashService.deleteDocument', () => {
  it('删自己个人空间里的文档：建一条删除单元、代次加一、收回写入权、记审计；先取空间树的锁再取空间行', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const document = store.addDocument({ folderId: folder.id, title: '周报' })
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)

    const entry = [...store.trashEntries.values()][0]
    expect(entry).toMatchObject({ spaceId: ALICE_SPACE, kind: 'document', deletedBy: ALICE, originParentId: folder.id, title: '周报' })
    expect(store.entryOfDocument(document.id)).toBe(entry?.id)
    expect(store.writeEpochs.get(document.id)).toBe(1)
    expect(store.revocations).toEqual([{ kind: 'documents', documentIds: [document.id] }])
    expect(store.treeLocks).toEqual([[ALICE_SPACE]])
    expect(store.spaces.holdSpace).toHaveBeenCalledWith(ALICE_SPACE, expect.anything())
    expect(store.audits).toEqual([{
      action: 'documents.deleted',
      actor: { type: 'user', id: ALICE },
      target: { type: 'document', id: document.id },
      origin: HTTP_ORIGIN,
      details: { spaceId: ALICE_SPACE, folderId: folder.id, trashEntryId: entry?.id },
    }])
  })

  it('编辑者只能删自己创建的；空间管理员任意；查看者一概不能', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const mine = store.addDocument({ spaceId: TEAM_SPACE, createdBy: ALICE })
    const others = store.addDocument({ spaceId: TEAM_SPACE, createdBy: BOB })
    const denied = await errorOf(service.deleteDocument(member(ALICE), others.id, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '编辑者只能删除自己创建的文档'])
    await service.deleteDocument(member(ALICE), mine.id, HTTP_ORIGIN)
    expect(store.entryOfDocument(mine.id)).not.toBeNull()

    store.setMember(TEAM_SPACE, ALICE, 'admin')
    await service.deleteDocument(member(ALICE), others.id, HTTP_ORIGIN)
    expect(store.entryOfDocument(others.id)).not.toBeNull()

    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const own = store.addDocument({ spaceId: TEAM_SPACE, createdBy: BOB })
    // 查看者不是"只能删自己创建的"：他根本不能删，自己创建的也不能（M2-P5 S4 主会话的决定）
    const viewerDenied = await errorOf(service.deleteDocument(member(BOB), own.id, HTTP_ORIGIN))
    expect([viewerDenied.code, viewerDenied.message]).toEqual(['PERMISSION_DENIED', '没有删除这份文档的权限'])
  })

  it('归档的空间里不能删，说明空间已归档；回收站里的文档再删是 NOT_FOUND，与不存在一致', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const again = await errorOf(service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN))
    const missing = await errorOf(service.deleteDocument(member(ALICE), MISSING, HTTP_ORIGIN))
    expect([again.code, again.message]).toEqual([missing.code, missing.message])
    expect(again.code).toBe('NOT_FOUND')

    store.setMember(TEAM_SPACE, ALICE, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    const archived = store.addDocument({ spaceId: TEAM_SPACE })
    const denied = await errorOf(service.deleteDocument(member(ALICE), archived.id, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '空间已归档，只能查看'])
  })
})

describe('TrashService.deleteFolder', () => {
  it('整棵子树进同一个删除单元；只在被删的那个文件夹上记原位置；文档的代次都加一', async () => {
    const { store, service } = setup()
    const [top, middle] = chain(store, ALICE_SPACE, 2)
    const atTop = store.addDocument({ folderId: top?.id })
    const deep = store.addDocument({ folderId: middle?.id })
    await service.deleteFolder(member(ALICE), top?.id ?? '', HTTP_ORIGIN)

    const entry = [...store.trashEntries.values()][0]
    expect(entry).toMatchObject({ kind: 'folder', originParentId: null, title: '第 1 层' })
    expect([store.entryOfFolder(top?.id ?? ''), store.entryOfFolder(middle?.id ?? '')]).toEqual([entry?.id, entry?.id])
    expect([store.entryOfDocument(atTop.id), store.entryOfDocument(deep.id)]).toEqual([entry?.id, entry?.id])
    expect([store.writeEpochs.get(atTop.id), store.writeEpochs.get(deep.id)]).toEqual([1, 1])
    expect(store.audits).toEqual([{
      action: 'folders.deleted',
      actor: { type: 'user', id: ALICE },
      target: { type: 'folder', id: top?.id },
      origin: HTTP_ORIGIN,
      details: { spaceId: ALICE_SPACE, parentId: null, trashEntryId: entry?.id, folders: 2, documents: 2 },
    }])
  })

  it('子树里早先单独删过的东西留在原来的删除单元里，不并进这次的（spec §1）', async () => {
    const { store, service } = setup()
    const [top, middle] = chain(store, ALICE_SPACE, 2)
    const earlier = store.addDocument({ folderId: middle?.id })
    await service.deleteDocument(member(ALICE), earlier.id, HTTP_ORIGIN)
    const first = store.entryOfDocument(earlier.id)
    await service.deleteFolder(member(ALICE), top?.id ?? '', HTTP_ORIGIN)

    expect(store.trashEntries.size).toBe(2)
    expect(store.entryOfDocument(earlier.id)).toBe(first)
    expect(store.entryOfFolder(top?.id ?? '')).not.toBe(first)
    // 早先那份文档不再算进这次的份数，代次也不再加一
    expect(store.audits.at(-1)).toMatchObject({ action: 'folders.deleted', details: { documents: 0 } })
    expect(store.writeEpochs.get(earlier.id)).toBe(1)
  })

  it('编辑者删里面有别人文档的文件夹：403，什么也不改；空文件夹与只有自己文档的可以', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const withOthers = store.addFolder({ spaceId: TEAM_SPACE, name: '公共' })
    store.addDocument({ spaceId: TEAM_SPACE, folderId: withOthers.id, createdBy: BOB })
    // 单独的错误码（不是 PERMISSION_DENIED）：界面要说"换个人来删"，与"空间已归档"分得开（审查 B2）
    const denied = await errorOf(service.deleteFolder(member(ALICE), withOthers.id, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['FOLDER_HAS_OTHERS_DOCUMENTS', '文件夹里有别人创建的文档，只有空间管理员能删除'])
    expect(store.trashEntries.size).toBe(0)

    const empty = store.addFolder({ spaceId: TEAM_SPACE, name: '空的' })
    await service.deleteFolder(member(ALICE), empty.id, HTTP_ORIGIN)
    expect(store.entryOfFolder(empty.id)).not.toBeNull()
    // 空间管理员不受这一条限制
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    await service.deleteFolder(member(ALICE), withOthers.id, HTTP_ORIGIN)
    expect(store.entryOfFolder(withOthers.id)).not.toBeNull()
  })
})

describe('TrashService.restore', () => {
  it('原位置还在：回到原来的文件夹，代次不再加一，删除单元没了，记审计', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const document = store.addDocument({ folderId: folder.id, title: '周报' })
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''

    const restored = await service.restore(member(ALICE), entryId, HTTP_ORIGIN)
    expect(restored).toEqual({ id: document.id, kind: 'document', title: '周报', spaceId: ALICE_SPACE, folderId: folder.id, movedToRoot: false })
    expect(store.entryOfDocument(document.id)).toBeNull()
    expect(store.documents.get(document.id)?.folderId).toBe(folder.id)
    expect(store.writeEpochs.get(document.id)).toBe(1)
    expect(store.trashEntries.size).toBe(0)
    expect(store.audits.at(-1)).toMatchObject({
      action: 'documents.restored',
      target: { type: 'document', id: document.id },
      details: { spaceId: ALICE_SPACE, folderId: folder.id, movedToRoot: false, trashEntryId: entryId },
    })
  })

  it('原来的父文件夹也进了回收站：回到空间的根目录并带标志', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const document = store.addDocument({ folderId: folder.id })
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''
    await service.deleteFolder(member(ALICE), folder.id, HTTP_ORIGIN)

    const restored = await service.restore(member(ALICE), entryId, HTTP_ORIGIN)
    expect(restored).toMatchObject({ folderId: null, movedToRoot: true })
    expect(store.documents.get(document.id)?.folderId).toBeNull()
  })

  it('原来的父文件夹还在、却在别的空间里：数据不一致，按意外错误处理，什么也不恢复（不变量，M2-P6 复核 B 的 G-5）', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    const document = store.addDocument({ folderId: folder.id })
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''
    // 正常的流程造不出这种状态（父文件夹跨空间移动时，子树里回收站的行与删除单元一起搬走）：直接改内存里的行
    store.folders.set(folder.id, { ...folder, spaceId: TEAM_SPACE, requestId: 'moved' })

    await expect(service.restore(member(ALICE), entryId, HTTP_ORIGIN)).rejects.toThrow(`删除单元与它原来的父文件夹不在同一个空间里：${entryId}`)
    expect(store.entryOfDocument(document.id)).toBe(entryId)
    expect(store.documents.get(document.id)?.folderId).toBe(folder.id)
  })

  it('文件夹整单恢复：层数按新位置重算；原来就在根目录下时不算"位置变了"', async () => {
    const { store, service } = setup()
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    await service.deleteFolder(member(ALICE), middle?.id ?? '', HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''
    const restored = await service.restore(member(ALICE), entryId, HTTP_ORIGIN)
    expect(restored).toMatchObject({ id: middle?.id, kind: 'folder', folderId: top?.id, movedToRoot: false })
    expect(store.folders.get(leaf?.id ?? '')?.depth).toBe(3)

    // 根目录下的那一棵：原位置就是根目录，恢复之后 movedToRoot 仍然是假
    await service.deleteFolder(member(ALICE), top?.id ?? '', HTTP_ORIGIN)
    const rootEntry = [...store.trashEntries.keys()][0] ?? ''
    expect(await service.restore(member(ALICE), rootEntry, HTTP_ORIGIN)).toMatchObject({ folderId: null, movedToRoot: false })
    expect(store.folders.get(leaf?.id ?? '')?.depth).toBe(3)
  })

  it('留在回收站里、属于别的删除单元的子孙也跟着降层（审查 A2）', async () => {
    const { store, service } = setup()
    const [top, middle, leaf] = chain(store, ALICE_SPACE, 3)
    // 由深到浅逐个单独删：三棵各自成一个删除单元，leaf 与 middle 的父子关系与层数都没有变
    for (const folder of [leaf, middle, top])
      await service.deleteFolder(member(ALICE), folder?.id ?? '', HTTP_ORIGIN)
    const middleEntry = store.entryOfFolder(middle?.id ?? '') ?? ''
    const leafEntry = store.entryOfFolder(leaf?.id ?? '')

    // top 还在回收站里，所以 middle 回到空间的根目录：整棵子树一起降一层，leaf 也从第 3 层降到第 2 层
    expect(await service.restore(member(ALICE), middleEntry, HTTP_ORIGIN)).toMatchObject({ folderId: null, movedToRoot: true })
    expect(store.folders.get(middle?.id ?? '')).toMatchObject({ parentId: null, depth: 1 })
    expect(store.folders.get(leaf?.id ?? '')).toMatchObject({ parentId: middle?.id, depth: 2 })
    // leaf 仍然留在它自己的删除单元里（spec §3 的"顺序"）：只有层数跟着变
    expect(store.entryOfFolder(leaf?.id ?? '')).toBe(leafEntry)
  })

  it('恢复的权限：删除者本人与空间管理员可以，同空间的另一个编辑者不行；归档的空间谁都不行', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.setMember(TEAM_SPACE, BOB, 'editor')
    const document = store.addDocument({ spaceId: TEAM_SPACE, createdBy: ALICE })
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''

    const denied = await errorOf(service.restore(member(BOB), entryId, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '只有删除的人或空间管理员能恢复'])
    store.setMember(TEAM_SPACE, BOB, 'admin')
    store.space(TEAM_SPACE).status = 'archived'
    expect((await errorOf(service.restore(member(BOB), entryId, HTTP_ORIGIN))).message).toBe('空间已归档，只能查看')
    store.space(TEAM_SPACE).status = 'active'
    expect(await service.restore(member(BOB), entryId, HTTP_ORIGIN)).toMatchObject({ id: document.id })
  })

  it('删除单元不存在、看不到那个空间：同一个 NOT_FOUND', async () => {
    const { store, service } = setup()
    const document = store.addDocument({ spaceId: TEAM_SPACE })
    store.setMember(TEAM_SPACE, ALICE, 'admin')
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''
    const unseen = await errorOf(service.restore(member(BOB), entryId, HTTP_ORIGIN))
    const missing = await errorOf(service.restore(member(BOB), MISSING, HTTP_ORIGIN))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect(unseen.message).toBe(missing.message)
  })
})

describe('TrashService.purge', () => {
  it('删掉这一单里的全部行与单元本身；只有空间管理员能做，记审计', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const document = store.addDocument({ spaceId: TEAM_SPACE, folderId: folder.id, createdBy: ALICE })
    await service.deleteFolder(member(ALICE), folder.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''

    const denied = await errorOf(service.purge(member(ALICE), entryId, HTTP_ORIGIN))
    expect([denied.code, denied.message]).toEqual(['PERMISSION_DENIED', '只有空间管理员能永久删除'])

    store.setMember(TEAM_SPACE, ALICE, 'admin')
    await service.purge(member(ALICE), entryId, HTTP_ORIGIN)
    expect(store.folders.has(folder.id)).toBe(false)
    expect(store.documents.has(document.id)).toBe(false)
    expect(store.trashEntries.size).toBe(0)
    expect(store.audits.at(-1)).toMatchObject({ action: 'folders.purged', target: { type: 'folder', id: folder.id } })
    // 明细逐字段相等（不是 toMatchObject）：只有份数与删除单元，多出一个标题或名称都会失败（M2-P6 复核 M-1）
    expect(store.audits.at(-1)?.details).toEqual({ spaceId: TEAM_SPACE, trashEntryId: entryId, folders: 1, documents: 1, cascadedEntries: 0 })
  })

  it('连带：子树里属于别的删除单元的行（文档与整棵子文件夹）一起删掉，那些单元也一起清掉（spec §4）', async () => {
    const { store, service } = setup()
    const [top, middle] = chain(store, ALICE_SPACE, 2)
    const earlier = store.addDocument({ folderId: middle?.id })
    await service.deleteDocument(member(ALICE), earlier.id, HTTP_ORIGIN)
    const earlierEntry = store.entryOfDocument(earlier.id) ?? ''
    // 早先还单独删过一棵子文件夹：它整棵都不在这次的单元里，永久删除时要连带清掉
    const earlierFolder = store.addFolder({ spaceId: ALICE_SPACE, parentId: middle?.id ?? null, name: '早先删的' })
    const deeper = store.addFolder({ spaceId: ALICE_SPACE, parentId: earlierFolder.id, name: '它里面的' })
    const inside = store.addDocument({ folderId: deeper.id })
    await service.deleteFolder(member(ALICE), earlierFolder.id, HTTP_ORIGIN)
    const earlierFolderEntry = store.entryOfFolder(earlierFolder.id) ?? ''
    await service.deleteFolder(member(ALICE), top?.id ?? '', HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()].find(id => id !== earlierEntry && id !== earlierFolderEntry) ?? ''

    await service.purge(member(ALICE), entryId, HTTP_ORIGIN)
    expect([store.documents.has(earlier.id), store.documents.has(inside.id)]).toEqual([false, false])
    expect(store.folders.size).toBe(0)
    expect(store.trashEntries.size).toBe(0)
    // 连带的两个单元（那份文档的、那棵子文件夹的）都清掉了；明细只记份数，不记 id 列表（审查 A1）
    expect([earlierEntry, earlierFolderEntry].every(id => !store.trashEntries.has(id))).toBe(true)
    expect(store.audits.at(-1)).toMatchObject({ action: 'folders.purged', details: { folders: 4, documents: 2, cascadedEntries: 2 } })
  })

  it('连带上百个单元时，审计明细仍在字节上限内：只记份数（审查 A1）', async () => {
    const { store, service } = setup()
    const folder = store.addFolder({ spaceId: ALICE_SPACE, name: '资料' })
    for (let index = 0; index < 120; index += 1) {
      const document = store.addDocument({ folderId: folder.id, title: `第 ${index} 份` })
      await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    }
    await service.deleteFolder(member(ALICE), folder.id, HTTP_ORIGIN)
    const entryId = store.entryOfFolder(folder.id) ?? ''

    await service.purge(member(ALICE), entryId, HTTP_ORIGIN)
    expect(store.trashEntries.size).toBe(0)
    const details = store.audits.at(-1)?.details
    expect(details).toMatchObject({ folders: 1, documents: 120, cascadedEntries: 120 })
    // 明细是有界的：换成 id 列表的话，120 个 uuid 就已经超过上限，整条写入失败、那一单永远删不掉
    expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThanOrEqual(AUDIT_DETAILS_MAX_BYTES)
  })

  it('要删的都在回收站里（M2-P6 复核 A 的 S-3、B 的 B2）：回收站的文件夹下有正常状态的文档或文件夹，按数据不一致处理，什么也不删', async () => {
    const { store, service } = setup()
    const [top, middle] = chain(store, ALICE_SPACE, 2)
    await service.deleteFolder(member(ALICE), top?.id ?? '', HTTP_ORIGIN)
    const entryId = store.entryOfFolder(top?.id ?? '') ?? ''
    const audits = store.audits.length
    // 数据不一致：一份正常状态的文档挂在回收站里的子文件夹下（各条路径都不会这样写，这里直接摆出来）
    const stray = store.addDocument({ folderId: middle?.id ?? null, title: '正常的' })
    await expect(service.purge(member(ALICE), entryId, HTTP_ORIGIN)).rejects.toThrow(`永久删除的子树里有正常状态的行（文件夹 0 个、文档 1 份），什么也不删：${entryId}`)
    // 正常状态的子文件夹同样
    store.documents.delete(stray.id)
    const strayFolder = store.addFolder({ spaceId: ALICE_SPACE, parentId: middle?.id ?? null, name: '正常的' })
    await expect(service.purge(member(ALICE), entryId, HTTP_ORIGIN)).rejects.toThrow('（文件夹 1 个、文档 0 份）')

    // 核对在删任何一行之前：什么也没删，删除单元还在，没有记审计
    expect(store.repositories.documents.deleteMany).not.toHaveBeenCalled()
    expect(store.repositories.folders.deleteMany).not.toHaveBeenCalled()
    expect([top, middle, strayFolder].every(row => store.folders.has(row?.id ?? ''))).toBe(true)
    expect(store.trashEntries.has(entryId)).toBe(true)
    expect(store.audits).toHaveLength(audits)
  })

  it('恢复与永久删除之后，另一个请求看到删除单元已经不在：NOT_FOUND', async () => {
    const { store, service } = setup()
    const document = store.addDocument()
    await service.deleteDocument(member(ALICE), document.id, HTTP_ORIGIN)
    const entryId = [...store.trashEntries.keys()][0] ?? ''
    await service.restore(member(ALICE), entryId, HTTP_ORIGIN)
    expect((await errorOf(service.purge(member(ALICE), entryId, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
    expect((await errorOf(service.restore(member(ALICE), entryId, HTTP_ORIGIN))).code).toBe('NOT_FOUND')
  })
})

describe('TrashService.list', () => {
  it('按空间列出：带原位置、份数与本人能做的操作；看得到空间内容的人都看得到', async () => {
    const { store, service } = setup()
    store.setMember(TEAM_SPACE, ALICE, 'editor')
    store.setMember(TEAM_SPACE, BOB, 'viewer')
    const folder = store.addFolder({ spaceId: TEAM_SPACE, name: '资料' })
    const inside = store.addFolder({ spaceId: TEAM_SPACE, parentId: folder.id, name: '里面' })
    store.addDocument({ spaceId: TEAM_SPACE, folderId: inside.id, createdBy: ALICE })
    const loose = store.addDocument({ spaceId: TEAM_SPACE, folderId: folder.id, createdBy: ALICE, title: '周报' })
    await service.deleteDocument(member(ALICE), loose.id, HTTP_ORIGIN)
    await service.deleteFolder(member(ALICE), folder.id, HTTP_ORIGIN)

    const page = await service.list(member(ALICE), { spaceId: TEAM_SPACE })
    expect(page.nextCursor).toBeNull()
    expect(page.items.map(item => [item.kind, item.title, item.documentCount])).toEqual([['folder', '资料', 1], ['document', '周报', 1]])
    // 被删的文件夹的原位置是空间的根目录；那份文档的原位置随文件夹一起进了回收站，所以已经不在
    expect(page.items.map(item => item.origin)).toEqual([
      { parentId: null, parentName: null, available: true },
      { parentId: folder.id, parentName: null, available: false },
    ])
    expect(page.items.map(item => item.permissions)).toEqual([{ canRestore: true, canPurge: false }, { canRestore: true, canPurge: false }])

    // 查看者看得到列表，但什么也动不了
    const viewer = await service.list(member(BOB), { spaceId: TEAM_SPACE })
    expect(viewer.items.map(item => item.permissions)).toEqual([{ canRestore: false, canPurge: false }, { canRestore: false, canPurge: false }])
  })

  it('看不到的空间与不存在的空间：同一个 NOT_FOUND；游标不合法是 REQUEST_INVALID', async () => {
    const { service } = setup()
    const unseen = await errorOf(service.list(member(BOB), { spaceId: TEAM_SPACE }))
    const missing = await errorOf(service.list(member(BOB), { spaceId: MISSING }))
    expect([unseen.code, missing.code]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    expect((await errorOf(service.list(member(ALICE), { spaceId: ALICE_SPACE, cursor: '乱写的' }))).code).toBe('REQUEST_INVALID')
  })
})

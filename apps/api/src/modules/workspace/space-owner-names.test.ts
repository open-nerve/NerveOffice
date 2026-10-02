// 搜索结果与"与我共享"里个人空间的所有者（M2-P5 设计 §3.4(2)(4)）：documents 给出所有者的 id，这里经 users 一次批量补上人名。
// 个人空间存的名称可以伪造（规范 §2.4）："与我共享"里个人空间只给所有者、不给存的名称；搜索结果只做加法（名称照旧，另带所有者）。
import type { SearchHit, SharedHit } from '../documents/index.ts'
import type { User } from '../users/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { SearchDirectoryService } from './search-directory.service.ts'
import { SharedDirectoryService } from './shared-directory.service.ts'

const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const PERSONAL = '0199a2c4-0000-7000-8000-0000000000a1'
const TEAM = '0199a2c4-0000-7000-8000-0000000000c1'
const ACTOR = { userId: BEN, systemAdmin: false }
const SUMMARY = { title: '周报', type: 'sheet', createdAt: '2026-10-02T08:00:00.000Z', updatedAt: '2026-10-02T09:00:00.000Z' } as const

const AMY_ACCOUNT: User = { id: AMY, username: 'amy', displayName: '艾米', systemRole: 'member', status: 'disabled' }

function users(accounts: readonly User[] = [AMY_ACCOUNT]) {
  return { findByIds: vi.fn(async () => new Map(accounts.map(account => [account.id, account]))) }
}

const SEARCH_HITS: SearchHit[] = [
  { id: 'd1', ...SUMMARY, space: { id: PERSONAL, type: 'personal', name: '伪造的名称', ownerUserId: AMY }, folderId: null, folderPath: [], accessVia: 'grant' },
  { id: 'd2', ...SUMMARY, space: { id: TEAM, type: 'team', name: '市场部', ownerUserId: null }, folderId: null, folderPath: [], accessVia: 'space' },
]

const SHARED_HITS: SharedHit[] = [
  { id: 'd1', ...SUMMARY, space: { id: PERSONAL, type: 'personal', name: '伪造的名称', ownerUserId: AMY }, contentRole: 'editor' },
  { id: 'd2', ...SUMMARY, space: { id: TEAM, type: 'team', name: '市场部', ownerUserId: null }, contentRole: 'viewer' },
]

describe('搜索结果：个人空间另带所有者（人名），名称照旧给出', () => {
  it('所有者的人名一次批量取（停用的账户照样给人名）；团队空间没有所有者', async () => {
    const directory = users()
    const search = { search: vi.fn(async () => ({ items: SEARCH_HITS, nextCursor: 'next' })) }
    const service = new SearchDirectoryService(search as never, directory as never)
    expect(await service.search(ACTOR, { query: '周报' })).toEqual({
      items: [
        { id: 'd1', ...SUMMARY, space: { id: PERSONAL, type: 'personal', name: '伪造的名称', owner: { id: AMY, username: 'amy', displayName: '艾米' } }, folderId: null, folderPath: [], accessVia: 'grant' },
        { id: 'd2', ...SUMMARY, space: { id: TEAM, type: 'team', name: '市场部' }, folderId: null, folderPath: [], accessVia: 'space' },
      ],
      nextCursor: 'next',
    })
    expect(directory.findByIds).toHaveBeenCalledTimes(1)
    expect(directory.findByIds).toHaveBeenCalledWith([AMY])
  })

  it('所有者的账户取不到（数据不一致）：按意外错误处理', async () => {
    const search = { search: vi.fn(async () => ({ items: SEARCH_HITS, nextCursor: null })) }
    const service = new SearchDirectoryService(search as never, users([]) as never)
    await expect(service.search(ACTOR, { query: '周报' })).rejects.toThrow(`账户不存在：${AMY}`)
  })
})

describe('"与我共享"：个人空间只给所有者（人名），不给存的名称', () => {
  it('团队空间给名称；个人空间给所有者；内容权限原样', async () => {
    const directory = users()
    const shared = { list: vi.fn(async () => ({ items: SHARED_HITS, nextCursor: null })) }
    const service = new SharedDirectoryService(shared as never, directory as never)
    const response = await service.list(ACTOR, {})
    expect(response).toEqual({
      items: [
        { id: 'd1', ...SUMMARY, space: { id: PERSONAL, type: 'personal', owner: { id: AMY, username: 'amy', displayName: '艾米' } }, contentRole: 'editor' },
        { id: 'd2', ...SUMMARY, space: { id: TEAM, type: 'team', name: '市场部' }, contentRole: 'viewer' },
      ],
      nextCursor: null,
    })
    expect(JSON.stringify(response)).not.toContain('伪造的名称')
    expect(directory.findByIds).toHaveBeenCalledWith([AMY])
  })

  it('个人空间没有所有者（数据不一致）：按意外错误处理', async () => {
    const orphan: SharedHit = { id: 'd3', ...SUMMARY, space: { id: PERSONAL, type: 'personal', name: '没有所有者', ownerUserId: null }, contentRole: 'viewer' }
    const shared = { list: vi.fn(async () => ({ items: [orphan], nextCursor: null })) }
    const service = new SharedDirectoryService(shared as never, users() as never)
    await expect(service.list(ACTOR, {})).rejects.toThrow(`个人空间没有所有者：${PERSONAL}`)
  })
})

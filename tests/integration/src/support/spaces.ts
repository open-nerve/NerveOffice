// 测试数据：直接写库建团队空间、成员与空间的状态（M2-P2）。经接口的创建与成员管理另有用例；
// 权限矩阵与并发用例需要一开始就摆好的空间，用它。
import type { SpaceRole, SpaceStatus } from '@nerve-office/contracts'
import type { TestDatabase } from './database.ts'

export interface TeamSpaceOptions {
  readonly name: string
  /** 创建人：系统管理员的账户 id */
  readonly createdBy: string
  /** 成员：账户 id → 空间角色 */
  readonly members?: Readonly<Record<string, SpaceRole>>
  readonly visibleToAll?: boolean
  readonly status?: SpaceStatus
}

export async function createTeamSpace(database: TestDatabase, options: TeamSpaceOptions): Promise<string> {
  return database.query(async (client) => {
    const space = await client.query<{ id: string }>(
      'INSERT INTO spaces (type, name, created_by, visible_to_all, status) VALUES (\'team\', $1, $2, $3, $4) RETURNING id',
      [options.name, options.createdBy, options.visibleToAll ?? false, options.status ?? 'active'],
    )
    const id = space.rows[0]?.id
    if (id === undefined)
      throw new Error('建团队空间没有返回 id')
    for (const [userId, role] of Object.entries(options.members ?? {}))
      await client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [id, userId, role])
    return id
  })
}

/** 设置成员的角色；role 为 undefined 时移出 */
export async function setMember(database: TestDatabase, spaceId: string, userId: string, role: SpaceRole | undefined): Promise<void> {
  await database.query(async client => role === undefined
    ? client.query('DELETE FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId])
    : client.query(
        'INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role, updated_at = now()',
        [spaceId, userId, role],
      ))
}

/** 直接改空间的状态或全员可见 */
export async function setSpaceState(database: TestDatabase, spaceId: string, state: { readonly status?: SpaceStatus, readonly visibleToAll?: boolean }): Promise<void> {
  await database.query(async client => client.query(
    'UPDATE spaces SET status = coalesce($2, status), visible_to_all = coalesce($3, visible_to_all), updated_at = now() WHERE id = $1',
    [spaceId, state.status ?? null, state.visibleToAll ?? null],
  ))
}

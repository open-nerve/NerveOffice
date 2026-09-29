// 测试用：登录之后的页框与首页要的空间接口（M2-P2）。页框的左侧导航请求"我能看到的空间"，首页（我的空间）先请求个人空间的页头，
// 再按空间取文档列表。
import type { SessionResponse, SpaceView } from '@nerve-office/contracts'
import type { Handler } from './fake-api.test-support.ts'
import { json } from './fake-api.test-support.ts'

/** 这个人的个人空间（空间管理员，能新建） */
export function personalSpaceOf(session: SessionResponse): SpaceView {
  return {
    id: session.personalSpace.id,
    type: 'personal',
    name: session.personalSpace.name,
    status: 'active',
    visibleToAll: false,
    role: 'admin',
    permissions: { canCreateDocuments: true, canViewMembers: false, canManageMembers: false, canRename: false },
  }
}

/** 导航（只有个人空间，另可以带上团队空间）与个人空间的页头 */
export function spaceRoutes(session: SessionResponse, teams: readonly SpaceView[] = []): Record<string, Handler> {
  const personal = personalSpaceOf(session)
  return {
    'GET /api/spaces': () => json(200, { items: [personal, ...teams] }),
    [`GET /api/spaces/${personal.id}`]: () => json(200, personal),
  }
}

/** 个人空间的文档列表的请求（第一页，或者带着游标的下一页） */
export function documentsKey(session: SessionResponse, cursor?: string): string {
  const query = new URLSearchParams({ spaceId: session.personalSpace.id })
  if (cursor !== undefined)
    query.set('cursor', cursor)
  return `GET /api/documents?${query.toString()}`
}

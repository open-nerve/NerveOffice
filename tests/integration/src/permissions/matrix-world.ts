// 权限矩阵的固定世界（M2-P2 设计 §3.11，US-M2-14）：一套角色与一套目标，矩阵的每一格是"某个角色对某个目标做某个操作"。
// 各 Phase 往矩阵里加行（操作）与列（角色、目标）；预期写在各个矩阵的表格里，不调用生产代码的规则来算。
import type { DocumentAccessVia, DocumentDetail, ErrorCode, GrantRole } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { errorResponseSchema, SHEET_TEMPLATE, TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import pg from 'pg'
import { expect } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { comparableOf } from '../support/comparable-response.ts'
import { parseExact } from '../support/contracts.ts'
import { seedDocument } from '../support/documents.ts'
import { setGrants } from '../support/grants.ts'
import { login } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

/**
 * 角色：
 * - owner：个人空间的所有者（不是任何团队空间的成员）；
 * - spaceAdmin、editor、viewer：四个团队空间（普通、全员可见、归档、归档且全员可见）里的空间管理员、编辑者、查看者；
 * - outsider：与这些空间都没有关系的成员；
 * - systemAdmin：没有加入任何团队空间的系统管理员；
 * - grantViewer、grantEditor：只凭单独授权的人（M2-P5 S4）。与这些空间都没有关系（不是成员、不是所有者），
 *   但世界里**几乎每一份文档**上都有他们的单独授权（查看者、编辑者）：固定的、每一格另建的、回收站里的，
 *   包括他们看不到的空间（个人空间、团队空间、归档的空间）里的——授权给不给空间里的东西开口子、
 *   结构性的操作是不是只看空间角色，正是这两列要考的。全员可见的两个空间里他们另有"全员可见"给的查看者角色（取较高者）。
 *   唯一的例外是每个目标空间里一份不给他们授权的固定文档（MatrixWorld.ungrantedDocuments，M2-P5 审查 B 的 S2）。
 */
export const ACTORS = ['owner', 'spaceAdmin', 'editor', 'viewer', 'outsider', 'systemAdmin', 'grantViewer', 'grantEditor'] as const
export type ActorName = (typeof ACTORS)[number]

/** 两个只凭授权的人 */
export const GRANTEE_ACTORS = ['grantViewer', 'grantEditor'] as const satisfies readonly ActorName[]
export type GranteeName = (typeof GRANTEE_ACTORS)[number]

const GRANT_ROLE: Readonly<Record<GranteeName, GrantRole>> = { grantViewer: 'viewer', grantEditor: 'editor' }

/** 只凭授权的人在世界里每一份文档上的授权角色 */
export function grantRoleOf(name: GranteeName): GrantRole {
  return GRANT_ROLE[name]
}

/** 这一列在 Row 里的位置 */
export function columnOf(actor: ActorName): number {
  return ACTORS.indexOf(actor)
}

/**
 * 目标空间：个人空间（owner 的）、团队空间、全员可见的团队空间、归档的团队空间、归档且全员可见的团队空间、不存在的空间。
 * 归档且全员可见（M2-P6 复核 B 的 S-3）：两条规则叠在一起——不是成员的人经"全员可见"是查看者，归档又让所有人至多是查看者；
 * 这一列守着"归档不收回全员可见给的查看"（读、列出、搜索照常）与"全员可见不越过归档"（谁都不能改）
 */
export const TARGETS = ['personal', 'team', 'visible', 'archived', 'archivedVisible', 'missing'] as const
export type TargetName = (typeof TARGETS)[number]

/** 看得到目标空间里一份文档的途径（文档详情的 accessVia）；看不到时为 null */
export type Via = DocumentAccessVia | null
/** 一行途径，顺序同 ACTORS */
export type ViaRow = readonly [Via, Via, Via, Via, Via, Via, Via, Via]

/**
 * 各个角色凭什么看得到目标空间里的文档（M2-P5 设计 §3.4(1)）——逐格按世界的摆法写出，不调用被测的规则：
 * - space（有空间角色）：个人空间的所有者；团队空间与归档的空间的三个成员（归档不收回空间角色，只把它降到查看者）；
 *   全员可见的两个空间里的所有人——包括两个只凭授权的人："全员可见"已经给了他们查看者的空间角色，授权只抬高内容权限，
 *   有空间角色时途径就是 space；
 * - grant（没有空间角色、只有单独授权）：两个只凭授权的人在个人空间、团队空间、归档的空间里；
 * - null（两样都没有，看不到，按不存在回答）：外人与没有加入的系统管理员（全员可见的空间除外），以及不存在的空间里的一切。
 * 由它推出的几条：能不能读这份文档（不是 null）、有没有空间角色（space：空间页、按空间列出、文件夹、回收站只看它）、
 * 是不是只凭授权（grant：结构性的操作一律 403 并给自己的说明，详情与搜索结果不带文件夹）
 */
export const ACCESS_VIA: Readonly<Record<TargetName, ViaRow>> = {
  personal: ['space', null, null, null, null, null, 'grant', 'grant'],
  team: [null, 'space', 'space', 'space', null, null, 'grant', 'grant'],
  visible: ['space', 'space', 'space', 'space', 'space', 'space', 'space', 'space'],
  archived: [null, 'space', 'space', 'space', null, null, 'grant', 'grant'],
  archivedVisible: ['space', 'space', 'space', 'space', 'space', 'space', 'space', 'space'],
  missing: [null, null, null, null, null, null, null, null],
}

/** 这个角色看得到目标空间里的文档的途径（ACCESS_VIA 的一格） */
export function accessViaOf(actor: ActorName, target: TargetName): Via {
  const via = ACCESS_VIA[target][columnOf(actor)]
  if (via === undefined)
    throw new Error(`ACCESS_VIA 的 ${target} 一行少了 ${actor} 那一列`)
  return via
}

/** 目标空间是不是归档的：归档的空间里所有人至多是查看者，被拒绝时说明空间已归档 */
export function isArchived(target: TargetName): boolean {
  return target === 'archived' || target === 'archivedVisible'
}

/**
 * 固定文档的标题前缀：只有 documents、folderDocuments、ungrantedDocuments 与 trashedDocuments 这几批固定的文档带它，
 * 每一格另建的文档都不带。搜索的矩阵拿它当关键词，结果因此是确定的几份，不受别的格子建出来的文档影响。
 */
export const MATRIX_TITLE_PREFIX = '矩阵：'

const USERNAMES: Readonly<Record<ActorName, string>> = {
  owner: 'matrix-owner',
  spaceAdmin: 'matrix-space-admin',
  editor: 'matrix-editor',
  viewer: 'matrix-viewer',
  outsider: 'matrix-outsider',
  systemAdmin: 'matrix-system-admin',
  grantViewer: 'matrix-grant-viewer',
  grantEditor: 'matrix-grant-editor',
}

export interface MatrixActor {
  readonly id: string
  readonly session: LoggedIn
}

export interface MatrixDocument {
  readonly id: string
  readonly unitId: string
}

export interface MatrixFolder {
  readonly id: string
  /** 名称（搜索结果的文件夹路径据此核对）；不存在的文件夹是空字符串 */
  readonly name: string
}

/** 另建一份文档：创建人默认是这个空间的空间管理员（个人空间是所有者），位置默认是空间的根目录 */
export interface FreshDocumentOptions {
  readonly createdBy?: string | undefined
  readonly folderId?: string | undefined
}

/** 回收站里的一个删除单元。 */
export interface MatrixTrashEntry {
  readonly id: string
}

export interface MatrixWorld {
  readonly actors: Readonly<Record<ActorName, MatrixActor>>
  readonly spaces: Readonly<Record<TargetName, string>>
  /** 每个目标空间里的一份文档；不存在的空间对应一个不存在的文档 */
  readonly documents: Readonly<Record<TargetName, MatrixDocument>>
  /**
   * 每个目标空间根目录下的一个正常状态的文件夹（不存在的空间对应一个不存在的文件夹）：列出一层的格子据此核对
   * "恰好是这个空间里的那几个"，列表不会因为一个文件夹也没有而怎么查都对
   */
  readonly folders: Readonly<Record<TargetName, MatrixFolder>>
  /**
   * folders 里各放的一份文档（不存在的空间对应一个不存在的文档，M2-P6 复验 R-G5）：按空间列出根目录的格子据此核对
   * "子文件夹里的文档不混进根目录"，整个空间的列表据此核对"子文件夹里的也列出来"。
   * 标题带 MATRIX_TITLE_PREFIX（M2-P5 S4）：搜索的矩阵据此核对凭授权命中的结果不带文件夹与路径——
   * documents 那一批在根目录下，文件夹本来就是空的，挡不住"忘了去掉文件夹"
   */
  readonly folderDocuments: Readonly<Record<TargetName, MatrixDocument>>
  /**
   * 每个目标空间根目录下一份**不给**两个只凭授权的人授权的文档（不存在的空间对应一个不存在的文档；M2-P5 审查 B 的 S2）。
   * 世界里别的文档上都有他们的授权，列表类的格子（"与我共享"、搜索）分不出"授权那一半没有关联到这份文档"——
   * 例如可访问文档的 EXISTS 只按人、不按文档，这个人有任何一条授权就算（审查 B 的变异 B18，两个矩阵原来全部通过）。
   * 只凭授权的人在"与我共享"与搜索里都不该有它，有空间角色的人照常搜得到。标题带 MATRIX_TITLE_PREFIX，由这个空间的空间管理员创建
   */
  readonly ungrantedDocuments: Readonly<Record<TargetName, MatrixDocument>>
  /**
   * 跨空间操作（移动、复制）牵涉两个空间，矩阵的一行只放得下一个目标，所以另建一个
   * **八个人都是空间管理员**的团队空间当固定的那一端（M2-P4 S7；M2-P5 S4 起含两个只凭授权的人）：
   * - 它当目标时，"目标空间有新建权限"对谁都成立，那一行只考核源空间的规则；
   * - 它当来源时，"源空间是空间管理员"对谁都成立，那一行只考核目标空间的规则。
   * 只凭授权的人跨空间移动被拒，因此只能是因为他在来源空间只凭授权。
   */
  readonly crossSpace: string
  /** 每个目标空间里一份在回收站里的文档；不存在的空间对应一个不存在的文档 */
  readonly trashedDocuments: Readonly<Record<TargetName, MatrixDocument>>
  /** 每个目标空间里一个在回收站里的文件夹；不存在的空间对应一个不存在的文件夹 */
  readonly trashedFolders: Readonly<Record<TargetName, MatrixFolder>>
  /** 在目标空间里另建一份文档：会改文档的格子（例如保存）各用各的，互不影响（见 FreshDocumentOptions） */
  readonly freshDocument: (target: TargetName, options?: FreshDocumentOptions) => Promise<MatrixDocument>
  /** 在某个空间里另建一份文档（跨空间的行用它在 crossSpace 里建）；folderId 默认是根目录 */
  readonly documentIn: (spaceId: string, createdBy: string, folderId?: string) => Promise<MatrixDocument>
  /** 在目标空间里另建一个空文件夹：会改文件夹的格子（改名、移动、删除）各用各的 */
  readonly freshFolder: (target: TargetName) => Promise<MatrixFolder>
  /** 在某个空间里另建一个空文件夹（跨空间的行用它在 crossSpace 里建） */
  readonly folderIn: (spaceId: string, createdBy: string) => Promise<MatrixFolder>
  /** 在目标空间里另建一个文件夹，里面放一份 createdBy 创建的文档（"里面有别人创建的文档"那一行用） */
  readonly freshFolderHolding: (target: TargetName, createdBy: string) => Promise<MatrixFolder>
  /** 在目标空间的回收站里另放一个删除单元（一份文档）：恢复与永久删除的格子各用各的 */
  readonly freshTrashEntry: (target: TargetName, deletedBy: string) => Promise<MatrixTrashEntry>
  /** 另建一个不登录的账户：成员的格子（添加、调整、移出）各用各的人；member 为真时先把他加为目标空间的查看者 */
  readonly freshSubject: (target: TargetName, member: boolean) => Promise<string>
  /** 另建一个与目标同样状态、同样成员的空间：会改空间的格子（归档、全员可见）各用各的；个人空间与不存在的空间照原样 */
  readonly freshSpace: (target: TargetName) => Promise<string>
  /**
   * 目标空间此刻的事实，直接查库（不经生产代码）：列表类的格子拿它核对响应"恰好是这个目标里的那几条，别处的一条也没有"
   * （M2-P6 复核 B 的 S-1）。根目录下正常状态的文档、根目录下正常状态的文件夹、回收站里的删除单元
   */
  readonly rootDocumentIds: (target: TargetName) => Promise<string[]>
  /** 整个空间里（不分目录）正常状态的文档 */
  readonly activeDocumentIds: (target: TargetName) => Promise<string[]>
  readonly rootFolderIds: (target: TargetName) => Promise<string[]>
  readonly trashEntryIds: (target: TargetName) => Promise<string[]>
  /**
   * 这个人此刻有单独授权的、正常状态的文档（按 id 排序；给了 target 时只要那个空间里的），直接查库：
   * "与我共享"的格子拿它核对"恰好是这几条"。回收站里的即使有授权也不算
   */
  readonly grantedDocumentIds: (userId: string, target?: TargetName) => Promise<string[]>
  /** 关掉摆世界用的那个连接（见 seedingConnection）：afterAll 里在删库之前经 closeWorld 调用 */
  readonly close: () => Promise<void>
}

/** 模板换上 unitId、A1 写入 value 的快照（保存用） */
export function snapshotOf(unitId: string, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  const snapshot = { ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }
  return Buffer.from(JSON.stringify(snapshot), 'utf8')
}

/**
 * 直接写库建一个空间根目录下的文件夹（与经接口新建的一致：第 1 层、没有父文件夹、状态正常）。
 * 矩阵每一格都要一个新的文件夹，归档的空间里又建不出来（接口 403），所以统一走写库，与 seedDocument 同一个理由。
 */
async function seedFolder(database: TestDatabase, options: { spaceId: string, createdBy: string, name: string }): Promise<string> {
  return database.query(async (client) => {
    const result = await client.query<{ id: string }>(
      'INSERT INTO folders (space_id, parent_id, name, created_by, depth, request_id) VALUES ($1, NULL, $2, $3, 1, $4) RETURNING id',
      [options.spaceId, options.name, options.createdBy, randomUUID()],
    )
    const id = result.rows[0]?.id
    if (id === undefined)
      throw new Error('建文件夹没有返回 id')
    return id
  })
}

/**
 * 直接写库把一份文档或一个文件夹放进回收站：建一条删除单元，再把那一行改成 trashed 并指向它
 * （与 TrashService 删除之后的行一致：到期时间是删除时间加 TRASH_RETENTION_DAYS 天，两列必须一起写，CHECK 要求二者一致）。
 * 删除的完整语义（代次、级联、审计）由 documents/trash.test.ts 覆盖，这里只摆出权限判断读到的事实。
 */
async function seedTrashEntry(
  database: TestDatabase,
  options: { spaceId: string, kind: 'document' | 'folder', deletedBy: string, title: string, objectId: string },
): Promise<string> {
  return database.query(async (client) => {
    const entry = await client.query<{ id: string }>(
      `INSERT INTO trash_entries (space_id, kind, deleted_by, expires_at, origin_parent_id, title)
       VALUES ($1, $2, $3, now() + make_interval(days => $4::int), NULL, $5) RETURNING id`,
      [options.spaceId, options.kind, options.deletedBy, TRASH_RETENTION_DAYS, options.title],
    )
    const id = entry.rows[0]?.id
    if (id === undefined)
      throw new Error('建删除单元没有返回 id')
    const table = options.kind === 'document' ? 'documents' : 'folders'
    // 文档删除时写入代次加一（P2 交接单第 55 行）；文件夹没有代次
    const epoch = options.kind === 'document' ? ', write_epoch = write_epoch + 1' : ''
    await client.query(`UPDATE ${table} SET status = 'trashed', trash_entry_id = $2${epoch} WHERE id = $1`, [options.objectId, id])
    return id
  })
}

/** 摆世界的连接出错之后再用它（见 seedingConnection）：说明加上原来的错误（cause） */
export const SEEDING_CONNECTION_BROKEN = '摆世界的连接已经出错断开（例如删库之前没有 closeWorld），不能再用它摆东西'

/** 摆世界的连接上，回调还没做完时又调了 query（见 seedingConnection）：回调等它的话原来会互相等待、一直挂到超时，现在立即失败 */
export const SEEDING_QUERY_NESTED = '摆世界的连接上，回调还没做完时不能再调 query：它要排在这个回调之后，回调要是等它，两边就会互相等待、一直挂到超时（分不出回调会不会等它，一律不许）。在回调里用它拿到的连接（connection.query）'

/**
 * 摆世界、每一格另建东西用的一个连接（M2-P5 S4）：TestDatabase.query 每次新开一个连接（本机实测约 5 毫秒，一条语句约 0.3 毫秒），
 * 扩到八列之后每一格都要另建好几样东西，开连接的时间占了矩阵的大半。这里的语句都不开事务，在一个连接上逐个执行即可：
 * 并发的调用（摆世界时的 Promise.all）在这里排队，一个回调做完再交给下一个——pg 自己的排队已经弃用（pg 9 去掉）。
 * 测试文件结束时先关掉它（world.close），再删库：删库会断开还连着的连接。
 *
 * 回调还没做完时不能再调 query：它排在这个回调之后，回调要是等它，两边互相等待、一直挂到用例超时，看不出原因（M2-P5 审查 B 的 G2、复验 G5）。
 * 所以记下正在执行的回调（AsyncLocalStorage：回调里发起的异步操作都带着它，await 之后、回调里排下的定时器也一样），回调做完（成功或失败）时
 * 记为已结束（M2-P5 复验第二轮 G4）：回调还没做完时再调 query 立即失败、写明原因（SEEDING_QUERY_NESTED）——没有 await 的调用也一样，
 * 分不出回调会不会等它；回调做完之后才执行的调用（回调里排下的定时器、没有 await 的异步操作）与回调之外的调用（并发的调用）照常排队。
 *
 * 连接出错时 pg.Client 发出 'error'（删库的 FORCE 断开它时先是 57P01、再是"Connection terminated unexpectedly"），没有人接就是
 * 测试进程里未处理的错误（M2-P5 审查 B 的 G2）：文件里忘了在删库之前 closeWorld，或者 beforeAll 超时、world 还没赋值时就会这样。
 * 这里接住并记下第一个，之后的调用直接失败、带着它（cause），不再把语句发给断开的连接；关掉照常（断开的连接 end 立即结束）
 */
export async function seedingConnection(database: TestDatabase): Promise<{ readonly seed: TestDatabase, readonly close: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: database.url, connectionTimeoutMillis: 5_000 })
  let broken: Error | undefined
  client.on('error', (error: Error) => {
    broken ??= error
  })
  await client.connect()
  /**
   * 这个连接上执行过的回调：回调里（含它发起的异步操作，回调做完之后才执行的也一样）取得到它。
   * 标记跟着异步操作一直走，所以单看"取得到"分不出回调做完了没有：做完时记下（done），只认还没做完的
   */
  const inCallback = new AsyncLocalStorage<{ done: boolean }>()
  let previous: Promise<unknown> = Promise.resolve()
  const query = async <T>(fn: (connection: pg.Client) => Promise<T>): Promise<T> => {
    if (inCallback.getStore()?.done === false)
      throw new Error(SEEDING_QUERY_NESTED)
    const run = previous.then(async () => {
      if (broken !== undefined)
        throw new Error(SEEDING_CONNECTION_BROKEN, { cause: broken })
      const callback = { done: false }
      try {
        return await inCallback.run(callback, async () => fn(client))
      }
      finally {
        callback.done = true
      }
    })
    // 前一个失败不拦住后面的：失败由它自己的调用方收到
    previous = run.catch(() => undefined)
    return run
  }
  return { seed: { ...database, query }, close: async () => client.end() }
}

/** 摆好世界（每个矩阵文件的 beforeAll）。摆的过程中失败（例如前提的核对）时先关掉摆世界的连接，再把错误抛出去 */
export async function buildMatrixWorld(testDatabase: TestDatabase, app: TestApp): Promise<MatrixWorld> {
  const { seed, close } = await seedingConnection(testDatabase)
  try {
    return { ...(await populateWorld(seed, app)), close }
  }
  catch (error) {
    await close()
    throw error
  }
}

/**
 * afterAll 里在删库之前调用：关掉摆世界的连接。beforeAll 里摆世界失败时 world 还没有赋值（afterAll 照样执行），
 * 这时什么也不做，后面的关应用、删库照常
 */
export async function closeWorld(world: MatrixWorld | undefined): Promise<void> {
  await world?.close()
}

async function populateWorld(database: TestDatabase, app: TestApp): Promise<Omit<MatrixWorld, 'close'>> {
  const accounts = Object.fromEntries(await Promise.all(ACTORS.map(async name => [name, await createAccount(database, {
    username: USERNAMES[name],
    systemRole: name === 'systemAdmin' ? 'admin' : 'member',
  })] as const))) as Record<ActorName, Awaited<ReturnType<typeof createAccount>>>

  const members = { [accounts.spaceAdmin.id]: 'admin', [accounts.editor.id]: 'editor', [accounts.viewer.id]: 'viewer' } as const
  const createdBy = accounts.systemAdmin.id
  let sequence = 0
  const freshSpace = async (target: TargetName): Promise<string> => {
    sequence += 1
    const name = `矩阵：${target} ${sequence}`
    switch (target) {
      case 'personal':
        return accounts.owner.personalSpaceId
      case 'missing':
        return randomUUID()
      case 'team':
        return createTeamSpace(database, { name, createdBy, members })
      case 'visible':
        return createTeamSpace(database, { name, createdBy, members, visibleToAll: true })
      case 'archived':
        return createTeamSpace(database, { name, createdBy, members, status: 'archived' })
      case 'archivedVisible':
        return createTeamSpace(database, { name, createdBy, members, visibleToAll: true, status: 'archived' })
    }
  }
  const spaces = Object.fromEntries(await Promise.all(TARGETS.map(async target => [target, await freshSpace(target)] as const))) as Record<TargetName, string>

  // 跨空间的行固定的那一端：八个人都是这个团队空间的空间管理员，所以"源空间是空间管理员"与
  // "目标空间有新建权限"在它这一端对谁都成立，那一行只考核另一端（见 MatrixWorld.crossSpace）
  const crossSpace = await createTeamSpace(database, {
    name: '矩阵：跨空间',
    createdBy,
    members: Object.fromEntries(ACTORS.map(name => [accounts[name].id, 'admin' as const])),
  })

  const freshSubject = async (target: TargetName, member: boolean): Promise<string> => {
    sequence += 1
    const subject = await createPassiveAccount(database, { username: `matrix-subject-${sequence}` })
    if (member && target !== 'personal' && target !== 'missing')
      await setMember(database, spaces[target], subject.id, 'viewer')
    return subject.id
  }

  /** 这个目标空间里的空间管理员：个人空间是所有者，团队空间是 spaceAdmin（新建的东西默认由他创建、由他删除） */
  const adminOf = (target: TargetName): string => (target === 'personal' ? accounts.owner.id : accounts.spaceAdmin.id)

  /**
   * 建一份文档，并给两个只凭授权的人在它上面各建一条授权（GRANTEE_ACTORS）：世界里的每一份文档都这样，
   * 他们在哪个空间里能做什么，只取决于那个空间给不给他们空间角色。设置授权的是那个空间的空间管理员（个人空间是所有者）——
   * 与被授权人不是同一个人（表上的 CHECK）
   */
  const seedGranted = async (spaceId: string, author: string, title: string, folderId?: string): Promise<MatrixDocument> => {
    const document = await seedDocument(database, { spaceId, createdBy: author, title, ...(folderId === undefined ? {} : { folderId }) })
    const grantedBy = spaceId === spaces.personal ? accounts.owner.id : accounts.spaceAdmin.id
    await setGrants(database, GRANTEE_ACTORS.map(name => ({ documentId: document.id, userId: accounts[name].id, role: grantRoleOf(name), grantedBy })))
    return document
  }

  const documentIn = async (spaceId: string, author: string, folderId?: string): Promise<MatrixDocument> => {
    sequence += 1
    return seedGranted(spaceId, author, `矩阵文档 ${sequence}`, folderId)
  }
  const freshDocument = async (target: TargetName, options: FreshDocumentOptions = {}): Promise<MatrixDocument> => {
    if (target === 'missing')
      return { id: randomUUID(), unitId: randomUUID() }
    return documentIn(spaces[target], options.createdBy ?? adminOf(target), options.folderId)
  }
  const documents = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    return [target, await seedGranted(spaces[target], adminOf(target), `${MATRIX_TITLE_PREFIX}${target}`)] as const
  }))) as Record<TargetName, MatrixDocument>

  const folderIn = async (spaceId: string, author: string): Promise<MatrixFolder> => {
    sequence += 1
    const name = `矩阵目录 ${sequence}`
    return { id: await seedFolder(database, { spaceId, createdBy: author, name }), name }
  }
  const freshFolder = async (target: TargetName): Promise<MatrixFolder> => {
    if (target === 'missing')
      return { id: randomUUID(), name: '' }
    return folderIn(spaces[target], adminOf(target))
  }
  const folders = Object.fromEntries(await Promise.all(TARGETS.map(async target => [target, await freshFolder(target)] as const))) as Record<TargetName, MatrixFolder>
  const folderDocuments = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    return [target, await seedGranted(spaces[target], adminOf(target), `${MATRIX_TITLE_PREFIX}${target} 目录里`, folders[target].id)] as const
  }))) as Record<TargetName, MatrixDocument>
  // 不给只凭授权的人授权的那一份（见 MatrixWorld.ungrantedDocuments）：直接建文档，不经 seedGranted
  const ungrantedDocuments = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    return [target, await seedDocument(database, { spaceId: spaces[target], createdBy: adminOf(target), title: `${MATRIX_TITLE_PREFIX}${target} 没分享的` })] as const
  }))) as Record<TargetName, MatrixDocument>

  /** 查库取一列 id（按 id 排序）：目标是不存在的空间时查的也是那个不存在的 id，结果是空的 */
  const idsOf = async (text: string, target: TargetName): Promise<string[]> => database.query(async client =>
    (await client.query<{ id: string }>(text, [spaces[target]])).rows.map(row => row.id))
  const rootDocumentIds = async (target: TargetName): Promise<string[]> =>
    idsOf('SELECT id FROM documents WHERE space_id = $1 AND folder_id IS NULL AND status = \'active\' ORDER BY id', target)
  const activeDocumentIds = async (target: TargetName): Promise<string[]> =>
    idsOf('SELECT id FROM documents WHERE space_id = $1 AND status = \'active\' ORDER BY id', target)
  const rootFolderIds = async (target: TargetName): Promise<string[]> =>
    idsOf('SELECT id FROM folders WHERE space_id = $1 AND parent_id IS NULL AND status = \'active\' ORDER BY id', target)
  const trashEntryIds = async (target: TargetName): Promise<string[]> =>
    idsOf('SELECT id FROM trash_entries WHERE space_id = $1 ORDER BY id', target)
  const grantedDocumentIds = async (userId: string, target?: TargetName): Promise<string[]> => database.query(async client => (await client.query<{ id: string }>(
    `SELECT d.id FROM document_grants g JOIN documents d ON d.id = g.document_id
     WHERE g.user_id = $1 AND d.status = 'active' AND ($2::uuid IS NULL OR d.space_id = $2::uuid) ORDER BY d.id`,
    [userId, target === undefined ? null : spaces[target]],
  )).rows.map(row => row.id))
  const freshFolderHolding = async (target: TargetName, author: string): Promise<MatrixFolder> => {
    const folder = await freshFolder(target)
    if (target !== 'missing') {
      sequence += 1
      await seedGranted(spaces[target], author, `矩阵目录里的文档 ${sequence}`, folder.id)
    }
    return folder
  }

  const freshTrashEntry = async (target: TargetName, deletedBy: string): Promise<MatrixTrashEntry> => {
    if (target === 'missing')
      return { id: randomUUID() }
    // 删除单元的标题就是被删文档删除时的标题（与 TrashService 一致）。里面那份文档上同样有两个只凭授权的人的授权：
    // 授权不给回收站开口子（恢复、永久删除只看空间角色）
    sequence += 1
    const title = `矩阵回收站 ${sequence}`
    const document = await seedGranted(spaces[target], deletedBy, title)
    return { id: await seedTrashEntry(database, { spaceId: spaces[target], kind: 'document', deletedBy, title, objectId: document.id }) }
  }

  // 固定的、已经在回收站里的文档与文件夹：对普通接口一律"不存在"的那张表只读不改，所以整张表共用这一批。
  // 文档的标题同样带 MATRIX_TITLE_PREFIX：搜索的矩阵据此核对"回收站里的搜不到"。文档上同样有两个只凭授权的人的授权：
  // 有授权也打不开、搜不到，"与我共享"里也没有
  const trashedDocuments = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    const title = `${MATRIX_TITLE_PREFIX}${target} 已删`
    const document = await seedGranted(spaces[target], adminOf(target), title)
    await seedTrashEntry(database, { spaceId: spaces[target], kind: 'document', deletedBy: adminOf(target), title, objectId: document.id })
    return [target, document] as const
  }))) as Record<TargetName, MatrixDocument>
  const trashedFolders = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    const folder = await freshFolder(target)
    if (target !== 'missing')
      await seedTrashEntry(database, { spaceId: spaces[target], kind: 'folder', deletedBy: adminOf(target), title: `矩阵已删目录：${target}`, objectId: folder.id })
    return [target, folder] as const
  }))) as Record<TargetName, MatrixFolder>

  const actors = Object.fromEntries(await Promise.all(ACTORS.map(async name => [name, {
    id: accounts[name].id,
    session: await login(app.baseUrl, USERNAMES[name], accounts[name].password),
  }] as const))) as Record<ActorName, MatrixActor>

  // 前提（M2-P5 S4）：两个只凭授权的人在固定的文档上确实有授权、别人一条也没有——没建上的话，他们那两列就与外人一样，
  // "只凭授权"的格子什么也证明不了（与"授权确实生效"的前提一起，见各矩阵读与搜索的格子）。
  // 不给授权的那一份上谁的授权也没有（审查 B 的 S2）：建上了的话，"它不在只凭授权的人的列表里"同样什么也证明不了
  const real = TARGETS.filter(target => target !== 'missing')
  const fixed = real.flatMap(target => [documents[target], folderDocuments[target], trashedDocuments[target]])
  await expectGranteesOn(database, fixed.map(document => document.id), GRANTEE_ACTORS.map(name => ({ userId: accounts[name].id, role: grantRoleOf(name) })))
  await expectGranteesOn(database, real.map(target => ungrantedDocuments[target].id), [])

  return {
    actors,
    spaces,
    documents,
    folders,
    folderDocuments,
    ungrantedDocuments,
    crossSpace,
    trashedDocuments,
    trashedFolders,
    freshDocument,
    documentIn,
    freshFolder,
    folderIn,
    freshFolderHolding,
    freshTrashEntry,
    freshSubject,
    freshSpace,
    rootDocumentIds,
    activeDocumentIds,
    rootFolderIds,
    trashEntryIds,
    grantedDocumentIds,
  }
}

/**
 * 前提的核对：这些文档都在库里，每一份上恰好是 grantees 的那几条授权（角色对），别的人一条也没有（别人的列不该被授权抬高）。
 * 直接查库，不经被测的接口
 */
async function expectGranteesOn(database: TestDatabase, documentIds: readonly string[], grantees: readonly { readonly userId: string, readonly role: GrantRole }[]): Promise<void> {
  const { stored, rows } = await database.query(async client => ({
    stored: (await client.query<{ count: number }>('SELECT count(*)::int AS count FROM documents WHERE id = ANY($1::uuid[])', [documentIds])).rows[0]?.count,
    rows: (await client.query<{ documentId: string, userId: string, role: GrantRole }>(
      'SELECT document_id AS "documentId", user_id AS "userId", role FROM document_grants WHERE document_id = ANY($1::uuid[]) ORDER BY document_id, user_id',
      [documentIds],
    )).rows,
  }))
  expect(stored, '固定的文档都在库里').toBe(documentIds.length)
  const key = (row: { readonly documentId: string, readonly userId: string }): string => `${row.documentId} ${row.userId}`
  const expected = documentIds.flatMap(documentId => grantees.map(grantee => ({ documentId, ...grantee })))
  expect(rows.toSorted((a, b) => key(a).localeCompare(key(b)))).toEqual(expected.toSorted((a, b) => key(a).localeCompare(key(b))))
}

/**
 * 一格的预期：成功的状态码、看得到却不能做（403）、看不到（404）、
 * 有权限但目标的状态不允许（409：M2-P2 只有"目标空间已归档"，SPACE_ARCHIVED）
 */
export type Expected = 200 | 201 | 204 | 403 | 404 | 409
/** 一行：各角色的预期，顺序同 ACTORS（owner、spaceAdmin、editor、viewer、outsider、systemAdmin、grantViewer、grantEditor） */
export type Row = readonly [Expected, Expected, Expected, Expected, Expected, Expected, Expected, Expected]
/** 一张矩阵：每个操作、每个目标一行 */
export type MatrixTable<Operation extends string> = Readonly<Record<Operation, Readonly<Record<TargetName, Row>>>>
/** 一个操作：某个角色对某个目标发请求 */
export type MatrixOperation = (actor: MatrixActor, target: TargetName) => Promise<Response>

export interface MatrixCell<Operation extends string> {
  readonly operation: Operation
  readonly target: TargetName
  readonly actor: ActorName
  readonly expected: Expected
}

/** 矩阵展开成格子：按格子生成用例 */
export function cellsOf<Operation extends string>(table: MatrixTable<Operation>): MatrixCell<Operation>[] {
  return (Object.keys(table) as Operation[]).flatMap(operation => TARGETS.flatMap(target => ACTORS.map((actor, column) => {
    const expected = table[operation][target][column]
    if (expected === undefined)
      throw new Error(`矩阵 ${operation} 的 ${target} 一行少了第 ${column + 1} 列`)
    return { operation, target, actor, expected }
  })))
}

/**
 * 返回文档详情的格子另外核对的（M2-P5 设计 §3.4(1)，"不给目录结构只在 toDetail 一处，矩阵逐接口核对"）：
 * 途径是 ACCESS_VIA 的那一格；只凭授权时不给所在的文件夹（null），有空间角色时是它实际所在的文件夹（located，null 表示根目录）。
 * located 在根目录时这一条挡不住"忘了去掉文件夹"，所以各矩阵另用放在文件夹里的文档核对
 */
export function expectDetailLocation(detail: DocumentDetail, actor: ActorName, target: TargetName, located: string | null): void {
  const via = accessViaOf(actor, target)
  expect(detail.accessVia, '看得到它的途径').toBe(via)
  expect(detail.folderId, '所在的文件夹').toBe(via === 'grant' ? null : located)
}

async function errorOf(response: Response): Promise<{ code: string, message: string }> {
  const { code, message } = parseExact(errorResponseSchema, await response.json()).error
  return { code, message }
}

/** 核对一格时另外要看的地方。 */
export interface CellOptions {
  /**
   * 这一格的 403 是哪个错误码；不给时是 PERMISSION_DENIED。
   * 只有"看得到却不能做"另有专门说法的格子才给（例如编辑者删除"里面有别人创建的文档"的文件夹，
   * 它与"空间已归档"要分得开，审查 B2）：逐格钉住，不是一个"几种都行"的名单（M2-P6 复核 B 的 G-2）
   */
  readonly deniedCode?: ErrorCode | undefined
  /** 这一格的 403 的说明（给出时逐字核对，例如归档的空间里说"空间已归档，只能查看"，M2-P6 复核 A 的 G3） */
  readonly deniedMessage?: string | undefined
  /**
   * 成功的格子另外核对响应的内容（列表类的操作：恰好是这个目标里的那几条，别处的一条也没有，M2-P6 复核 B 的 S-1；
   * 返回文档详情的操作：只凭授权时不带文件夹，M2-P5 S4）。状态码表达不了"列出来的是谁的东西"：列表的范围条件坏了，状态码照样是 200
   */
  readonly verify?: ((response: Response, target: TargetName, actor: ActorName) => Promise<void>) | undefined
}

/**
 * 核对一格：状态码；403 的错误码（默认 PERMISSION_DENIED，见 deniedCode）；409 的错误码是 SPACE_ARCHIVED；
 * 成功时按 verify 核对内容。404 的错误码是 NOT_FOUND，而且与同一个人对不存在的目标做同一个操作的响应完全相同：
 * 状态码、错误体（去掉请求标识，其余逐字段）与非易变的响应头（M2-P6 复核 B 的 G-1）——看不到与不存在一致。
 * 不存在的目标自己就是比较的基准，那一行不与自己比较；语句序列一致由 hidden-missing-parity.test.ts 逐条比较
 */
export async function expectCell<Operation extends string>(
  world: MatrixWorld,
  run: MatrixOperation,
  cell: MatrixCell<Operation>,
  options: CellOptions = {},
): Promise<void> {
  const actor = world.actors[cell.actor]
  const response = await run(actor, cell.target)
  expect(response.status, await response.clone().text()).toBe(cell.expected)
  if (cell.expected === 403) {
    const error = await errorOf(response)
    expect(error.code).toBe(options.deniedCode ?? 'PERMISSION_DENIED')
    if (options.deniedMessage !== undefined)
      expect(error.message).toBe(options.deniedMessage)
  }
  if (cell.expected === 409)
    expect((await errorOf(response)).code).toBe('SPACE_ARCHIVED')
  if (cell.expected !== 403 && cell.expected !== 404 && cell.expected !== 409 && options.verify !== undefined)
    await options.verify(response, cell.target, cell.actor)
  if (cell.expected === 404) {
    const hidden = await comparableOf(response)
    expect(hidden.body).toMatchObject({ error: { code: 'NOT_FOUND' } })
    if (cell.target !== 'missing')
      expect(await comparableOf(await run(actor, 'missing'))).toEqual(hidden)
  }
}

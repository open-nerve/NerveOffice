// 权限矩阵的固定世界（M2-P2 设计 §3.11，US-M2-14）：一套角色与一套目标，矩阵的每一格是"某个角色对某个目标做某个操作"。
// 各 Phase 往矩阵里加行（操作）与列（角色、目标）；预期写在各个矩阵的表格里，不调用生产代码的规则来算。
import type { ErrorCode } from '@nerve-office/contracts'
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { errorResponseSchema, SHEET_TEMPLATE, TRASH_RETENTION_DAYS } from '@nerve-office/contracts'
import { expect } from 'vitest'
import { createAccount, createPassiveAccount } from '../support/accounts.ts'
import { comparableOf } from '../support/comparable-response.ts'
import { parseExact } from '../support/contracts.ts'
import { seedDocument } from '../support/documents.ts'
import { login } from '../support/session-client.ts'
import { createTeamSpace, setMember } from '../support/spaces.ts'

/**
 * 角色：
 * - owner：个人空间的所有者（不是任何团队空间的成员）；
 * - spaceAdmin、editor、viewer：四个团队空间（普通、全员可见、归档、归档且全员可见）里的空间管理员、编辑者、查看者；
 * - outsider：与这些空间都没有关系的成员；
 * - systemAdmin：没有加入任何团队空间的系统管理员。
 */
export const ACTORS = ['owner', 'spaceAdmin', 'editor', 'viewer', 'outsider', 'systemAdmin'] as const
export type ActorName = (typeof ACTORS)[number]

/**
 * 目标空间：个人空间（owner 的）、团队空间、全员可见的团队空间、归档的团队空间、归档且全员可见的团队空间、不存在的空间。
 * 归档且全员可见（M2-P6 复核 B 的 S-3）：两条规则叠在一起——不是成员的人经"全员可见"是查看者，归档又让所有人至多是查看者；
 * 这一列守着"归档不收回全员可见给的查看"（读、列出、搜索照常）与"全员可见不越过归档"（谁都不能改）
 */
export const TARGETS = ['personal', 'team', 'visible', 'archived', 'archivedVisible', 'missing'] as const
export type TargetName = (typeof TARGETS)[number]

/**
 * 固定文档的标题前缀：只有 documents 与 trashedDocuments 这两批固定的文档带它，
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
   * "子文件夹里的文档不混进根目录"，整个空间的列表据此核对"子文件夹里的也列出来"。标题不带 MATRIX_TITLE_PREFIX，搜索的矩阵不受影响
   */
  readonly folderDocuments: Readonly<Record<TargetName, MatrixDocument>>
  /**
   * 跨空间操作（移动、复制）牵涉两个空间，矩阵的一行只放得下一个目标，所以另建一个
   * **六个人都是空间管理员**的团队空间当固定的那一端（M2-P4 S7）：
   * - 它当目标时，"目标空间有新建权限"对谁都成立，那一行只考核源空间的规则；
   * - 它当来源时，"源空间是空间管理员"对谁都成立，那一行只考核目标空间的规则。
   */
  readonly crossSpace: string
  /** 每个目标空间里一份在回收站里的文档；不存在的空间对应一个不存在的文档 */
  readonly trashedDocuments: Readonly<Record<TargetName, MatrixDocument>>
  /** 每个目标空间里一个在回收站里的文件夹；不存在的空间对应一个不存在的文件夹 */
  readonly trashedFolders: Readonly<Record<TargetName, MatrixFolder>>
  /** 在目标空间里另建一份文档：会改文档的格子（例如保存）各用各的，互不影响；createdBy 默认是这个空间的空间管理员 */
  readonly freshDocument: (target: TargetName, createdBy?: string) => Promise<MatrixDocument>
  /** 在某个空间里另建一份文档（跨空间的行用它在 crossSpace 里建） */
  readonly documentIn: (spaceId: string, createdBy: string) => Promise<MatrixDocument>
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

export async function buildMatrixWorld(database: TestDatabase, app: TestApp): Promise<MatrixWorld> {
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

  // 跨空间的行固定的那一端：六个人都是这个团队空间的空间管理员，所以"源空间是空间管理员"与
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

  const documentIn = async (spaceId: string, author: string): Promise<MatrixDocument> => {
    sequence += 1
    return seedDocument(database, { spaceId, createdBy: author, title: `矩阵文档 ${sequence}` })
  }
  const freshDocument = async (target: TargetName, createdBy?: string): Promise<MatrixDocument> => {
    if (target === 'missing')
      return { id: randomUUID(), unitId: randomUUID() }
    return documentIn(spaces[target], createdBy ?? adminOf(target))
  }
  const documents = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    return [target, await seedDocument(database, { spaceId: spaces[target], createdBy: adminOf(target), title: `${MATRIX_TITLE_PREFIX}${target}` })] as const
  }))) as Record<TargetName, MatrixDocument>

  const folderIn = async (spaceId: string, author: string): Promise<MatrixFolder> => {
    sequence += 1
    return { id: await seedFolder(database, { spaceId, createdBy: author, name: `矩阵目录 ${sequence}` }) }
  }
  const freshFolder = async (target: TargetName): Promise<MatrixFolder> => {
    if (target === 'missing')
      return { id: randomUUID() }
    return folderIn(spaces[target], adminOf(target))
  }
  const folders = Object.fromEntries(await Promise.all(TARGETS.map(async target => [target, await freshFolder(target)] as const))) as Record<TargetName, MatrixFolder>
  const folderDocuments = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    return [target, await seedDocument(database, { spaceId: spaces[target], createdBy: adminOf(target), title: `矩阵目录里的文档：${target}`, folderId: folders[target].id })] as const
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
  const freshFolderHolding = async (target: TargetName, author: string): Promise<MatrixFolder> => {
    const folder = await freshFolder(target)
    if (target !== 'missing') {
      sequence += 1
      await seedDocument(database, { spaceId: spaces[target], createdBy: author, title: `矩阵目录里的文档 ${sequence}`, folderId: folder.id })
    }
    return folder
  }

  const freshTrashEntry = async (target: TargetName, deletedBy: string): Promise<MatrixTrashEntry> => {
    if (target === 'missing')
      return { id: randomUUID() }
    // 删除单元的标题就是被删文档删除时的标题（与 TrashService 一致）
    sequence += 1
    const title = `矩阵回收站 ${sequence}`
    const document = await seedDocument(database, { spaceId: spaces[target], createdBy: deletedBy, title })
    return { id: await seedTrashEntry(database, { spaceId: spaces[target], kind: 'document', deletedBy, title, objectId: document.id }) }
  }

  // 固定的、已经在回收站里的文档与文件夹：对普通接口一律"不存在"的那张表只读不改，所以整张表共用这一批。
  // 文档的标题同样带 MATRIX_TITLE_PREFIX：搜索的矩阵据此核对"回收站里的搜不到"
  const trashedDocuments = Object.fromEntries(await Promise.all(TARGETS.map(async (target) => {
    if (target === 'missing')
      return [target, { id: randomUUID(), unitId: randomUUID() }] as const
    const title = `${MATRIX_TITLE_PREFIX}${target} 已删`
    const document = await seedDocument(database, { spaceId: spaces[target], createdBy: adminOf(target), title })
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

  return {
    actors,
    spaces,
    documents,
    folders,
    folderDocuments,
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
  }
}

/**
 * 一格的预期：成功的状态码、看得到却不能做（403）、看不到（404）、
 * 有权限但目标的状态不允许（409：M2-P2 只有"目标空间已归档"，SPACE_ARCHIVED）
 */
export type Expected = 200 | 201 | 204 | 403 | 404 | 409
/** 一行：各角色的预期，顺序同 ACTORS（owner、spaceAdmin、editor、viewer、outsider、systemAdmin） */
export type Row = readonly [Expected, Expected, Expected, Expected, Expected, Expected]
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
   * 成功的格子另外核对响应的内容（列表类的操作：恰好是这个目标里的那几条，别处的一条也没有，M2-P6 复核 B 的 S-1）。
   * 状态码表达不了"列出来的是谁的东西"：列表的范围条件坏了，状态码照样是 200
   */
  readonly verify?: ((response: Response, target: TargetName) => Promise<void>) | undefined
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
    await options.verify(response, cell.target)
  if (cell.expected === 404) {
    const hidden = await comparableOf(response)
    expect(hidden.body).toMatchObject({ error: { code: 'NOT_FOUND' } })
    if (cell.target !== 'missing')
      expect(await comparableOf(await run(actor, 'missing'))).toEqual(hidden)
  }
}

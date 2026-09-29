// 权限矩阵的固定世界（M2-P2 设计 §3.11，US-M2-14）：一套角色与一套目标，矩阵的每一格是"某个角色对某个目标做某个操作"。
// 各 Phase 往矩阵里加行（操作）与列（角色、目标）；预期写在各个矩阵的表格里，不调用生产代码的规则来算。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { LoggedIn } from '../support/session-client.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { SHEET_TEMPLATE } from '@nerve-office/contracts'
import { createAccount } from '../support/accounts.ts'
import { seedDocument } from '../support/documents.ts'
import { login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

/**
 * 角色：
 * - owner：个人空间的所有者（不是任何团队空间的成员）；
 * - spaceAdmin、editor、viewer：三个团队空间（普通、全员可见、归档）里的空间管理员、编辑者、查看者；
 * - outsider：与这些空间都没有关系的成员；
 * - systemAdmin：没有加入任何团队空间的系统管理员。
 */
export const ACTORS = ['owner', 'spaceAdmin', 'editor', 'viewer', 'outsider', 'systemAdmin'] as const
export type ActorName = (typeof ACTORS)[number]

/** 目标空间：个人空间（owner 的）、团队空间、全员可见的团队空间、归档的团队空间、不存在的空间 */
export const TARGETS = ['personal', 'team', 'visible', 'archived', 'missing'] as const
export type TargetName = (typeof TARGETS)[number]

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

export interface MatrixWorld {
  readonly actors: Readonly<Record<ActorName, MatrixActor>>
  readonly spaces: Readonly<Record<TargetName, string>>
  /** 每个目标空间里的一份文档；不存在的空间对应一个不存在的文档 */
  readonly documents: Readonly<Record<TargetName, MatrixDocument>>
  /** 在目标空间里另建一份文档：会改文档的格子（例如保存）各用各的，互不影响 */
  readonly freshDocument: (target: TargetName) => Promise<MatrixDocument>
}

/** 模板换上 unitId、A1 写入 value 的快照（保存用） */
export function snapshotOf(unitId: string, value: string): Buffer {
  const sheet = SHEET_TEMPLATE.sheets['sheet-1']
  const snapshot = { ...SHEET_TEMPLATE, id: unitId, sheets: { 'sheet-1': { ...sheet, cellData: { 0: { 0: { v: value } } } } } }
  return Buffer.from(JSON.stringify(snapshot), 'utf8')
}

export async function buildMatrixWorld(database: TestDatabase, app: TestApp): Promise<MatrixWorld> {
  const accounts = Object.fromEntries(await Promise.all(ACTORS.map(async name => [name, await createAccount(database, {
    username: USERNAMES[name],
    systemRole: name === 'systemAdmin' ? 'admin' : 'member',
  })] as const))) as Record<ActorName, Awaited<ReturnType<typeof createAccount>>>

  const members = { [accounts.spaceAdmin.id]: 'admin', [accounts.editor.id]: 'editor', [accounts.viewer.id]: 'viewer' } as const
  const createdBy = accounts.systemAdmin.id
  const spaces: Record<TargetName, string> = {
    personal: accounts.owner.personalSpaceId,
    team: await createTeamSpace(database, { name: '矩阵：团队空间', createdBy, members }),
    visible: await createTeamSpace(database, { name: '矩阵：全员可见', createdBy, members, visibleToAll: true }),
    archived: await createTeamSpace(database, { name: '矩阵：已归档', createdBy, members, status: 'archived' }),
    missing: randomUUID(),
  }

  const freshDocument = async (target: TargetName): Promise<MatrixDocument> => {
    if (target === 'missing')
      return { id: randomUUID(), unitId: randomUUID() }
    const createdBy = target === 'personal' ? accounts.owner.id : accounts.spaceAdmin.id
    return seedDocument(database, { spaceId: spaces[target], createdBy, title: `矩阵：${target}` })
  }
  const documents = Object.fromEntries(await Promise.all(TARGETS.map(async target => [target, await freshDocument(target)] as const))) as Record<TargetName, MatrixDocument>

  const actors = Object.fromEntries(await Promise.all(ACTORS.map(async name => [name, {
    id: accounts[name].id,
    session: await login(app.baseUrl, USERNAMES[name], accounts[name].password),
  }] as const))) as Record<ActorName, MatrixActor>

  return { actors, spaces, documents, freshDocument }
}

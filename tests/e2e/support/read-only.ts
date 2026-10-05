// 只读用例共用的部分（US-M2-11；specs/editor/read-only.spec.ts 与 read-only-shortcuts.spec.ts）：
// 写好只读样本的团队空间与成员、只读的全过程都不该有的（页面错误、保存请求）、打开到 steady、内存里的内容没有改动，
// 以及 SDK 的权限检查拦下操作时弹出的提示（平台把它改成只读的说法）。
// 入口的清单与预期、提示的说法、"改文档的 mutation"的判定与测试构建的页面自检共用（apps/web/src/editor/testing/ 的
// read-only-entries.ts、content-compare.ts，M3-P2 设计 §3.5），这里转出 E2E 用到的
import type { Locator, Page } from '@playwright/test'
import type { TestUser } from './database.ts'
import type { ProbeCommand } from './editor-probe.ts'
import type { Workbook } from './sheet.ts'
import { documentChangeAttemptsIn, documentChangesIn } from '../../../apps/web/src/editor/testing/content-compare.ts'
import { PERMISSION_ALERT_TITLE, PROTECTION_WORDING } from '../../../apps/web/src/editor/testing/read-only-entries.ts'
import { createDocumentIn, createTeamSpace, createUser } from './database.ts'
import { contentOf, probeCommands, probeSnapshot } from './editor-probe.ts'
import { expect } from './fixtures.ts'
import { collectPageErrors } from './page-errors.ts'
import { readOnlySampleFor } from './read-only-sample.ts'
import { loginThroughApi } from './session.ts'
import { openReader, saveStatus } from './sheet.ts'

export interface Scene {
  readonly author: TestUser
  readonly viewer: TestUser
  readonly spaceId: string
  /** 写好样本的一份文档 */
  readonly documentId: string
}

/** 系统管理员建团队空间，作者是空间管理员，查看者是查看者；作者在空间里有一份写好样本（默认是只读样本）的文档 */
export async function scene(prefix: string, snapshotFor: (unitId: string) => string = readOnlySampleFor): Promise<Scene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const space = await createTeamSpace('只读样本', admin, [[author, 'admin'], [viewer, 'viewer']])
  return { author, viewer, spaceId: space.id, documentId: await createDocumentIn(space.id, author, '只读样本', { snapshotFor }) }
}

/** 页面上收集到的：页面错误与这份文档的保存请求 */
export interface Watched {
  readonly pageErrors: string[]
  readonly saves: string[]
}

/**
 * 只读的全过程都应该没有的：页面错误（被取消的命令不产生页面错误，M2-P3 设计 §3.8）与保存请求。
 * 浏览器的 ResizeObserver 通知不算页面错误（support/page-errors.ts）
 */
export function watch(page: Page, documentId: string): Watched {
  const watched = { pageErrors: [] as string[], saves: [] as string[] }
  collectPageErrors(page, watched.pageErrors)
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === `/api/documents/${documentId}/content`)
      watched.saves.push(request.url())
  })
  return watched
}

/**
 * 打开到 steady：SDK 的一部分控制器在它的 Steady 阶段才装上（例如查找替换：它的快捷键要等查找的提供方注册之后才可用，
 * find-replace 的 find-replace.service.ts 的 _syncActiveProvider），入口要在这之后试
 */
export const OPENED = 'steady'

/** 查看者（或归档空间里的成员）打开（M3-P2：打开即阅读）：页头显示"只能查看" */
export async function openReadOnly(page: Page, user: TestUser, documentId: string): Promise<void> {
  await loginThroughApi(page, user)
  await openReader(page, documentId, OPENED)
  // 页头里看得见的状态（读屏的播报区是视觉隐藏的副本，M3-P4）
  await expect(saveStatus(page)).toHaveText('只能查看')
}

/** 快照的 unitId（本文档的 mutation 按它认） */
export function unitIdOf(snapshotText: string): string {
  return (JSON.parse(snapshotText) as Workbook).id
}

export { documentChangesIn }
export { READ_ONLY_ALERT as ALERT, ANY_READ_ONLY_ALERT, FACADE_ENTRIES, FORMULA_MUTATION_CELL, SHORTCUT_OUTCOMES, writeFormulaMutation } from '../../../apps/web/src/editor/testing/read-only-entries.ts'
export type { EntryOutcome, FacadeEntry } from '../../../apps/web/src/editor/testing/read-only-entries.ts'

/** mark 之后执行了的、变更检测会认作修改的 mutation（同 documentChangesIn） */
export async function documentChanges(page: Page, mark: number, unitId: string): Promise<ProbeCommand[]> {
  return documentChangesIn(await probeCommands(page, mark), unitId)
}

/**
 * mark 之后尝试过的、变更检测会认作修改的 mutation（执行前的记录，被取消的也算）：就绪到 steady 之间一条都不应该有，
 * 否则就是进入只读时 SDK 试图改文档、被防火墙取消了（P3 审查 B9）
 */
export async function documentChangeAttempts(page: Page, mark: number, unitId: string): Promise<ProbeCommand[]> {
  return documentChangeAttemptsIn(await probeCommands(page, mark), unitId)
}

/** mark 之后内存里的内容与 baseline 相同，也没有改动文档的 mutation 执行 */
export async function expectUnchanged(page: Page, baseline: string, mark: number): Promise<void> {
  expect(contentOf(await probeSnapshot(page)), '内存里的内容与打开时相同').toEqual(contentOf(baseline))
  expect(await documentChanges(page, mark, unitIdOf(baseline)), '没有改动文档的 mutation 执行').toEqual([])
}

/**
 * SDK 的权限检查拦下命令时弹出的提示（sheets-ui 的 sheet-permission-check-ui.controller.ts）。标题是"提示"，
 * 正文由平台的语言包改成只读的说法（editor/profile/locale.ts；SDK 的原文是给保护区域写的）
 */
export function permissionAlert(page: Page): Locator {
  return page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: PERMISSION_ALERT_TITLE, exact: true }) })
}

/** 关掉权限检查的提示：先核对它的说法（text），不再提保护、不让人联系创建者 */
export async function closePermissionAlert(page: Page, text: string | RegExp): Promise<void> {
  const alert = permissionAlert(page)
  await expect(alert).toContainText(text)
  await expect(alert).not.toContainText(PROTECTION_WORDING)
  await alert.getByRole('button', { name: '确定', exact: true }).click()
  await expect(alert).toBeHidden()
}

/**
 * 只看一次、不重试：web 优先的断言给最短的时限，第一次检查不满足就失败（Playwright 的 timeout: 0 是不限时，不能用）。
 * 用在"等到确定的时刻之后，这时应该已经如此"的地方：能编辑时的对照同样只看一次，只读时的否定才有校准
 */
export const LOOK_ONCE = { timeout: 1 } as const

/** 等两个动画帧：SDK 在动画帧里结算的状态（标签的拖动位置、右键菜单的弹出、对话框的渲染）这时已经处理完 */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(async () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

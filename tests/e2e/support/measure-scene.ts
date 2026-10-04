// 实测的场景与页面上的操作（M3-P2 S5：切换耗时与反复切换的内存，tests/e2e/measure/）：
// - 场景：系统管理员建团队空间，作者是空间管理员、查看者是查看者，作者在空间里有一份写好快照的文档（与只读用例同样的角色）；
// - 计时：页面开始之前装上 editor/testing/switch-timing.ts 的记录器（addInitScript），每次切换之前清空、点下去、等到 steady，
//   取出时刻整理成 SwitchTiming；
// - "有更新"：作者经接口保存一版（申请编辑权、保存、释放，与页面同一条路径），阅读的页面经 visibilitychange 立即读一次编辑状态
//   （页面回到前台时就是这样做的，edit-mode.ts），不必等 30 秒一次的检查。
import type { Locator, Page } from '@playwright/test'
import type { ResourceEnd, SwitchDirection, SwitchMark, SwitchTiming, SwitchTimingRecorder } from '../../../apps/web/src/editor/testing/switch-timing.ts'
import type { SnapshotFor, TestUser } from './database.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { EDIT_LEASE_HEADER, SNAPSHOT_UPLOAD_CONTENT_TYPE } from '@nerve-office/contracts'
import { request } from '@playwright/test'
import { installSwitchTiming, summarizeSwitch, SWITCH_TIMING_OPTIONS } from '../../../apps/web/src/editor/testing/switch-timing.ts'
import { createDocumentIn, createTeamSpace, createUser } from './database.ts'
import { e2eOrigin } from './environment.ts'
import { expect } from './fixtures.ts'

export interface MeasureScene {
  readonly author: TestUser
  readonly viewer: TestUser
  readonly documentId: string
}

/** 写库造场景：作者（空间管理员）有一份 snapshotFor 的文档，查看者能读它 */
export async function measureScene(prefix: string, title: string, snapshotFor: SnapshotFor): Promise<MeasureScene> {
  const admin = await createUser(`${prefix}-admin`, '系统管理员', { systemRole: 'admin' })
  const author = await createUser(`${prefix}-author`, '作者')
  const viewer = await createUser(`${prefix}-viewer`, '查看者')
  const space = await createTeamSpace('实测', admin, [[author, 'admin'], [viewer, 'viewer']])
  return { author, viewer, documentId: await createDocumentIn(space.id, author, title, { snapshotFor }) }
}

/** 这个页面之后的每个文档在开始之前都装上计时（每次导航、刷新都是新的记录器） */
export async function installTiming(page: Page): Promise<void> {
  await page.addInitScript(installSwitchTiming, SWITCH_TIMING_OPTIONS)
}

interface Recorded {
  readonly marks: readonly SwitchMark[]
  readonly resources: readonly ResourceEnd[]
}

async function recorded(page: Page): Promise<Recorded> {
  return page.evaluate((name) => {
    const recorder = (window as unknown as Record<string, SwitchTimingRecorder | undefined>)[name]
    if (recorder === undefined)
      throw new Error('页面上没有切换的计时：先 installTiming')
    return { marks: recorder.marks(), resources: recorder.resources() }
  }, SWITCH_TIMING_OPTIONS.globalName)
}

async function clearTiming(page: Page): Promise<void> {
  await page.evaluate((name) => {
    (window as unknown as Record<string, SwitchTimingRecorder | undefined>)[name]?.clear()
  }, SWITCH_TIMING_OPTIONS.globalName)
}

/** 等到这次切换的编辑器到了 steady（按记下的时刻判断），返回整理好的时刻 */
async function settled(page: Page, direction: SwitchDirection): Promise<SwitchTiming> {
  let timing: SwitchTiming | undefined
  await expect.poll(async () => {
    const { marks, resources } = await recorded(page)
    timing = direction === 'open' || marks.some(mark => mark.kind === 'click') ? summarizeSwitch(direction, marks, resources) : undefined
    return timing?.steady ?? null
  }, { message: `等${direction}的编辑器到 steady`, timeout: 60_000, intervals: [250] }).not.toBeNull()
  if (timing === undefined)
    throw new Error('没有整理出时刻')
  return timing
}

/** 打开（导航或刷新）到阅读的 steady：起点是导航开始 */
export async function measureOpen(page: Page, navigate: () => Promise<unknown>): Promise<SwitchTiming> {
  await navigate()
  return settled(page, 'open')
}

/** 一次切换：清空记下的时刻，act 点下按钮，等到新的编辑器 steady */
export async function measureSwitch(page: Page, direction: Exclude<SwitchDirection, 'open'>, act: () => Promise<unknown>): Promise<SwitchTiming> {
  await clearTiming(page)
  await act()
  return settled(page, direction)
}

/** 页头里的"有更新，点击刷新" */
export function updateButton(page: Page): Locator {
  return page.locator('#editor-chrome').getByRole('banner').getByRole('button', { name: '有更新，点击刷新', exact: true })
}

/** 阅读的页面立即读一次编辑状态：与回到前台相同（edit-mode.ts 在 visibilitychange 且页面没有隐藏时立即检查） */
export async function checkEditStatusNow(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}

/** 作者经接口保存新的版本（另一个人在别处编辑、保存）：与页面同一条路径——申请编辑权、保存、释放 */
export interface AuthorApi {
  /** 读服务器上的内容，"数据"表（第一张表）A1 写上 label，保存为新的一版；返回新的修订号 */
  readonly saveVersion: (documentId: string, label: string) => Promise<number>
  readonly dispose: () => Promise<void>
}

export async function authorApi(user: TestUser): Promise<AuthorApi> {
  const origin = e2eOrigin()
  const context = await request.newContext({ baseURL: origin })
  const login = await context.post('/api/auth/login', { data: { username: user.username, password: user.password }, headers: { origin } })
  expect(login.status(), await login.text()).toBe(200)
  const { csrfToken } = await (await context.get('/api/auth/session')).json() as { csrfToken: string }
  const headers = { 'origin': origin, 'x-csrf-token': csrfToken }
  return {
    saveVersion: async (documentId, label) => {
      const clientInstanceId = randomUUID()
      const acquired = await context.post(`/api/documents/${documentId}/edit-lease`, { data: { clientInstanceId }, headers })
      expect(acquired.status(), await acquired.text()).toBe(201)
      const lease = await acquired.json() as { token: string, writeEpoch: number, revision: number }
      try {
        const current = await context.get(`/api/documents/${documentId}/content`)
        expect(current.status()).toBe(200)
        const workbook = JSON.parse(await current.text()) as { sheetOrder: string[], sheets: Record<string, { cellData: Record<string, Record<string, unknown>> }> }
        const sheet = workbook.sheets[workbook.sheetOrder[0] ?? '']
        if (sheet === undefined)
          throw new Error('快照里没有第一张表')
        sheet.cellData['0'] = { ...sheet.cellData['0'], 0: { v: label, t: 1 } }
        const query = new URLSearchParams({ baseRevision: String(lease.revision), requestId: randomUUID(), clientInstanceId, localSeq: '1', writeEpoch: String(lease.writeEpoch) })
        const saved = await context.put(`/api/documents/${documentId}/content?${query.toString()}`, {
          headers: { ...headers, [EDIT_LEASE_HEADER]: lease.token, 'content-type': SNAPSHOT_UPLOAD_CONTENT_TYPE },
          data: zlib.gzipSync(Buffer.from(JSON.stringify(workbook), 'utf8')),
        })
        expect(saved.status(), await saved.text()).toBe(200)
        return (await saved.json() as { revision: number }).revision
      }
      finally {
        const released = await context.delete(`/api/documents/${documentId}/edit-lease`, { headers: { ...headers, [EDIT_LEASE_HEADER]: lease.token } })
        expect(released.status(), await released.text()).toBe(204)
      }
    },
    dispose: async () => context.dispose(),
  }
}

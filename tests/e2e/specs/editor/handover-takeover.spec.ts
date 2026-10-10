// 本人接管："在此编辑"（US-M3-08；M3-P5 设计 §3.7）。编辑状态说正在编辑的是自己时，页头的按钮换成"在此编辑"，说明按这份文档的本机锁
// （Web Locks）在本浏览器里有没有人持有分开说：
// - 本浏览器的另一个标签页在编辑：请它先保存再交出（交接频道 BroadcastChannel）——它回应之后挡住输入、保存，存上了放弃那一代（不释放，审查 B4）、
//   放锁、回到阅读；这一页等它做完（锁空了）再以本人接管申请（服务端换代，槽从来不空）。它不回应（冻结、Safari 暂停了后台页面、卡住）就 3 秒之后
//   以本人接管申请、核对过自己那一代是当前的才抢锁，它得知被抢、核对得知被接管，随即失去编辑权、给副本（M3-P6 设计 §3.13）。它的心跳在这一页
//   抢锁之前先得知被接管也一样：编辑状态的 sameSession 确认本次登录，立即说明本浏览器的另一个标签页接手了（不等抢锁）；
// - 不在本浏览器（另一台设备或浏览器、刚关闭或刷新过的页面、载入途中离开留下的孤儿租约）：立即以本人接管申请。另一台设备上的旧页面下一次心跳
//   得知被接管，失去编辑权、给副本（sameSession=false 立即说明另一台设备或浏览器，本机锁后台至多留 5 秒作查询失败的退路）；刷新时有保存在途的（旧页面留下
//   记号），先等那次保存提交（至多 30 秒）再接手。
// 两个标签页用同一个浏览器上下文（共用 Cookie、Web Locks、BroadcastChannel 与 Playwright 的时钟）；另一台设备用另一个上下文、同一个人登录。
// "不响应"只给那一个页面在载入之前吞掉交接频道的消息（support/sheet.ts 的 deafenHandover）；时间用 Playwright 的时钟（打开之前装上，之后照常
// 流动），要到点时 fastForward（上下文级：两个标签页一起走）。
// "旧页面离开"（关闭、刷新）在页面还在时派发 pagehide（与 M3-P4 的 pagehide 用例相同）：页面这时放锁，保存在途就不释放、留下记号，否则释放。
// 不真的关、真的刷新：关页、导航离开时的 keepalive 请求 Chrome、WebKit 不经 page.route（拦不住那次释放）；Playwright 的 WebKit 刷新时先取消
// 在途的请求、再派发 pagehide（页面看到的保存已经失败，不留记号），造不出"刷新时保存在途"（WebKit 的这个先后待真实 Safari 复核）。
// 容器 E2E 也跑（生产镜像里定时的自动保存照常运行）：要"修改没存上"的在修改之前拦下那一页的保存（blockSaves），断言只看结果；
// 交接成功时旧页的修改由交出前的保存或之前的自动保存存上，都按服务器上的内容断言
import type { Page, Request } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { advanceUntil, holdSaves, pauseTime, setPageHidden } from '../../support/autosave.ts'
import { CURRENT_CLIENT } from '../../support/client-format.ts'
import { createUser, editLeaseEndReason, editLeaseEpoch, editLeaseTakeover } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { actAs, loginThroughApi } from '../../support/session.ts'
import { blockSaves, cellOf, createSheetThroughApi, deafenHandover, editingNotice, EDITOR_TEST_TIMEOUT, enterEditButton, isSaveRequest, lostNotice, openAndEnterEditing, openReader, saveAndWait, saveButton, savedContent, statusRegion, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 自己在本浏览器的另一个标签页里编辑时的说明 */
const IN_THIS_BROWSER = '你在本浏览器的另一个标签页里正在编辑这份文档。点"在此编辑"，那个标签页会先保存，再把编辑权交给这里'
/** 自己在别处（另一台设备或浏览器，或者刚关闭、刷新过的页面）编辑时的说明 */
const ELSEWHERE = '你在另一台设备或浏览器上正在编辑这份文档（也可能是刚关闭、刷新过的页面）。点"在此编辑"在这里接着编辑，那边会失去编辑权，没保存的修改可以在那边另存为副本'
/** 是自己、锁不在本浏览器，刚关闭或刷新的页面还有一次保存在进行（记号在 30 秒内、那次保存还没提交，审查 B §七）时的说明 */
const JUST_CLOSED = '你刚关闭或刷新的页面还有一次保存在进行。点"在此编辑"会先等它存完（至多 30 秒）再接着编辑'
/**
 * 服务端说被本人接管、本机锁还在手里时，旧标签页等本浏览器里接手的那一页来抢锁至多这么久（毫秒，apps/web 的 edit-mode.ts 的
 * TAKEOVER_STEAL_WAIT_MS：E2E 不引用页面的模块）
 */
const STEAL_WAIT_MS = 5_000

/** 申请编辑权（POST …/edit-lease）的请求 */
function isLeaseAcquisition(request: Request, documentId: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`
}

/** 这个页面申请编辑权时带的接管方式（不带时为 null），按先后 */
function recordTakeovers(page: Page, documentId: string): (string | null)[] {
  const takeovers: (string | null)[] = []
  page.on('request', (request) => {
    if (isLeaseAcquisition(request, documentId))
      takeovers.push((request.postDataJSON() as { readonly takeover?: string }).takeover ?? null)
  })
  return takeovers
}

/**
 * 扣住这个页面的续租（心跳、拿锁时的核对：PUT …/edit-lease）：install 之后发出的都等 release 才发往服务端，之后照常；seen 在第一次被扣住时兑现。
 * 读编辑状态、申请、释放照常
 */
function holdLeaseRenewals(page: Page, documentId: string) {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let saw: () => void = () => {}
  const seen = new Promise<void>((resolve) => {
    saw = resolve
  })
  return {
    page,
    seen,
    release: () => release(),
    install: async () => page.route(`**/api/documents/${documentId}/edit-lease`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      saw()
      await released
      await route.continue()
    }),
  }
}

/**
 * 这个页面现在持有这份文档的本机锁（Web Locks 的 nerve-doc:<documentId>）没有：query 只给出各个持有者的 clientId，先拿一把只有它用的锁、从 query
 * 里认出自己的 clientId 再比。不经页面的模块与测试钩子，生产镜像里同样成立
 */
async function holdsDocumentLock(page: Page, documentId: string): Promise<boolean> {
  return page.evaluate(async (name) => {
    const probe = `probe-${crypto.randomUUID()}`
    return navigator.locks.request(probe, async () => {
      const { held = [] } = await navigator.locks.query()
      const self = held.find(lock => lock.name === probe)?.clientId
      return self !== undefined && held.some(lock => lock.name === name && lock.clientId === self)
    })
  }, `nerve-doc:${documentId}`)
}

/** 另存为副本之后的说明里新文档的 id（链接在新标签页打开它） */
async function copiedDocumentId(page: Page): Promise<string> {
  const link = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' }).getByRole('link', { name: '打开副本（新标签页）', exact: true })
  await expect(link).toBeVisible()
  return (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
}

test.describe('US-M3-08 本人接管："在此编辑"', () => {
  test('US-M3-08 同一个浏览器的两个标签页：B 点"在此编辑"，A 先保存再交出（不释放，审查 B4）、回到阅读并说明；B 等 A 做完才以本人接管申请，以服务器上包括 A 的修改的内容进入编辑——任何时候只有一个标签页在编辑', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('takeover-tabs'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)

    const other = await context.newPage()
    await openReader(other, documentId)
    await expect(editingNotice(other)).toHaveText(IN_THIS_BROWSER)
    await expect(takeOverHereButton(other)).toBeVisible()
    await expect(enterEditButton(other)).toHaveCount(0)
    await expect(saveButton(other)).toHaveCount(0)
    // B 打开之后 A 才改：自动保存照常运行时（容器 E2E），A 的这一处由自动保存存上，落在 B 打开之后时 B 会多说一句"这份文档有更新的版本"
    // （M3-P5 合并之后 CI 的容器 E2E 在 handover-request 里碰上的同一个先后）。测试构建里这一处一直没存上，交出之前先存上
    await typeInCell(page, 'A1', 'from the first tab')

    // 两边的请求按先后记下：A 的保存在 B 的申请之前，A 不发释放
    const order: string[] = []
    context.on('request', (request) => {
      if (isSaveRequest(request) && request.frame().page() === page)
        order.push('A 保存')
      if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease` && request.frame().page() === page)
        order.push('A 释放')
      if (isLeaseAcquisition(request, documentId) && request.frame().page() === other)
        order.push('B 申请')
    })
    const takeovers = recordTakeovers(other, documentId)
    await takeOverHereButton(other).click()
    await waitForEditorAccess(other, 'edit')
    await expect(saveButton(other)).toBeVisible()

    // A：存上、回到阅读，读屏状态区说明（之后的检查读到自己在本浏览器的另一个标签页编辑时一起说）
    await waitForEditorAccess(page, 'read')
    await expect(statusRegion(page)).toContainText('已交给本浏览器的另一个标签页')
    await expect(saveButton(page)).toHaveCount(0)
    await expect(lostNotice(page)).toHaveCount(0)
    // 生产构建里 A 的修改可能早已由自动保存存上（交出时没有要存的）；测试构建里是交出前的那一次保存
    expect(order.at(-1)).toBe('B 申请')
    expect(order).not.toContain('A 释放')
    // A 交出之后才申请，以本人接管换代（A 那一代没有释放：槽从来不空）
    expect(takeovers).toEqual(['self'])
    expect(await editLeaseTakeover(documentId)).toBe('self')
    expect(await editLeaseEpoch(documentId)).toBe(2)

    // B 的内容里有 A 的修改：B 接着改、保存，服务器上两处都在
    await typeInCell(other, 'B1', 'from the second tab')
    await saveAndWait(other)
    const saved = (await savedContent(other, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1')?.v]).toEqual(['from the first tab', 'from the second tab'])
  })

  test('US-M3-08 旧标签页不响应（收不到交接请求：冻结、暂停、卡住）：B 说正在请它交出，3 秒没有回应就以本人接管申请、抢锁；A 随即失去编辑权（本人在本浏览器的另一个标签页接手了），没保存的修改另存为副本', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('takeover-deaf'))
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await deafenHandover(page)
    await openAndEnterEditing(page, documentId)
    // A 的修改存不上（两种构建里都一样）
    const saves = await blockSaves(page)
    await typeInCell(page, 'A1', 'only in the deaf tab')

    const other = await context.newPage()
    await openReader(other, documentId)
    await expect(editingNotice(other)).toHaveText(IN_THIS_BROWSER)
    const takeovers = recordTakeovers(other, documentId)
    await takeOverHereButton(other).click()
    // 接手进行中：同一个按钮说正在接手（不可用、进行中），读屏状态区说在请那边交出
    const taking = other.locator('#editor-chrome').getByRole('banner').getByRole('button', { name: '正在接手…', exact: true })
    await expect(taking).toHaveAttribute('aria-busy', 'true')
    await expect(statusRegion(other)).toHaveText('正在请本浏览器的另一个标签页保存并交出编辑权…')
    expect(takeovers).toEqual([])

    // 3 秒没有回应：本人接管
    await other.clock.fastForward(3_000)
    await waitForEditorAccess(other, 'edit')
    expect(takeovers).toEqual(['self'])
    expect(await editLeaseTakeover(documentId)).toBe('self')

    // A 立即失去编辑权（本机锁被抢，向服务端核对得知那一代被本人接管，M3-P6 设计 §3.13），以只读显示本页的内容，给副本与放弃；副本是 A 的内容
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你在本浏览器的另一个标签页接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await waitForEditorAccess(page, 'read')
    await saves.unblock()
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    const copyId = await copiedDocumentId(page)
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('only in the deaf tab')

    // B 照常编辑、保存；原文档里没有 A 没存上的修改
    await typeInCell(other, 'B1', 'second tab')
    await saveAndWait(other)
    const saved = (await savedContent(other, documentId)).snapshot
    expect([cellOf(saved, 'A1'), cellOf(saved, 'B1')?.v]).toEqual([undefined, 'second tab'])
  })

  test('US-M3-08 B 已本人接管但尚未抢锁，A 心跳先得知失效：sameSession 立即说明本浏览器接手，不等本机证据（DEF-071）', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('takeover-beat-first'))
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await deafenHandover(page)
    await openAndEnterEditing(page, documentId)
    const saves = await blockSaves(page)
    await typeInCell(page, 'A1', 'only in the deaf tab')
    // 两边的续租（PUT …/edit-lease）都先扣住：A 的心跳不论什么时候到点，都等 B 本人接管之后才放行（服务端处理时 A 那一代已被接管）；
    // B 拿锁时锁被 A 占着、先核对（续租一次），扣到 A 得知被接管之后——B 抢锁之前还差这一次往返
    const heartbeat = holdLeaseRenewals(page, documentId)
    const confirmation = holdLeaseRenewals(await context.newPage(), documentId)
    const other = confirmation.page
    await confirmation.install()
    await heartbeat.install()
    await openReader(other, documentId)
    await expect(editingNotice(other)).toHaveText(IN_THIS_BROWSER)
    await takeOverHereButton(other).focus()
    await pauseTime(page)
    try {
      // 先让 A 的心跳在途，再推进 B 的 3 秒交接等待；不能在 B 核对已在途时跳过整整 10 秒，那会触发新请求时限。
      await page.clock.fastForward(10_000)
      await heartbeat.seen
      await other.keyboard.press('Enter')
      // heldHere 是异步的 Web Locks 查询；看到 asking 才能确定 3 秒交接计时器已经排下，不能从按键完成推断。
      await expect(statusRegion(other)).toHaveText('正在请本浏览器的另一个标签页保存并交出编辑权…')
      await other.clock.fastForward(3_000)
      await confirmation.seen
      expect(await editLeaseTakeover(documentId)).toBe('self')

      // 时钟仍暂停：A 的请求只等了 3 秒，B 的核对也没有超时。放行 A，真实编辑状态给出 sameSession=true。
      const takenOver = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/documents/${documentId}/edit-lease`)
      heartbeat.release()
      expect((await takenOver).status()).toBe(409)
      await advanceUntil(page, async () => lostNotice(page).isVisible(), '服务端确认本次登录后，A 保留内容并显示接管位置')
      await expect(lostNotice(page)).toContainText('你在本浏览器的另一个标签页接手了编辑')
      // 定位已经完成，锁仍在 A 手里（B 的核对还没有放行）：确定答案不依赖本机抢锁。
      expect(await holdsDocumentLock(page, documentId)).toBe(true)
    }
    finally {
      heartbeat.release()
      confirmation.release()
      await page.clock.resume()
    }

    // B 的核对回来、抢锁：A 的定位不变；副本仍是 A 的内容。
    await waitForEditorAccess(other, 'edit')
    expect(await holdsDocumentLock(other, documentId)).toBe(true)
    const lost = lostNotice(page)
    await expect(lost).toContainText('编辑权已失效：你在本浏览器的另一个标签页接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    await waitForEditorAccess(page, 'read')
    await saves.unblock()
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    const copyId = await copiedDocumentId(page)
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('only in the deaf tab')
    await typeInCell(other, 'B1', 'second tab')
    await saveAndWait(other)
    expect(cellOf((await savedContent(other, documentId)).snapshot, 'B1')?.v).toBe('second tab')
  })

  test('US-M3-08 旧页已关、它的释放没送到（锁随页面放开了，那一代还在）：说明是别处（也可能是刚关闭、刷新过的页面）；"在此编辑"立即以本人接管申请、进入编辑', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('takeover-closed'))
    const documentId = await createSheetThroughApi(page)
    const editor = await context.newPage()
    await openAndEnterEditing(editor, documentId)
    // 旧页面离开：放锁、发释放——释放送不到服务端（拦下）；之后再关时不再发（已经释放过一次）
    await editor.route('**/api/documents/*/edit-lease', async route => route.request().method() === 'DELETE' ? route.abort('internetdisconnected') : route.continue())
    // route.abort 完成、请求确实失败之后才关页，否则保活的释放仍可能送到服务端。
    const release = editor.waitForEvent('requestfailed', request => request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/documents/${documentId}/edit-lease`)
    await editor.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await release
    await editor.close()
    expect(await editLeaseEndReason(documentId)).toBeNull()

    await openReader(page, documentId)
    await expect(editingNotice(page)).toHaveText(ELSEWHERE)
    const takeovers = recordTakeovers(page, documentId)
    await takeOverHereButton(page).click()
    await waitForEditorAccess(page, 'edit')
    expect(takeovers).toEqual(['self'])
    expect(await editLeaseTakeover(documentId)).toBe('self')
    await typeInCell(page, 'A1', 'after the closed tab')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after the closed tab')
  })

  test('US-M3-08 孤儿租约（载入途中离开：取得了编辑权、却没有页面在用它，DEF-042）："在此编辑"立即接手，结束那一代', async ({ page }) => {
    await loginThroughApi(page, await createUser('takeover-orphan'))
    const documentId = await createSheetThroughApi(page)
    // 同一个登录、另一个页面标识取得的一代：没有页面持有它的本机锁
    await actAs(page, 'POST', `/api/documents/${documentId}/edit-lease`, { clientInstanceId: randomUUID(), ...CURRENT_CLIENT })
    const epoch = await editLeaseEpoch(documentId) ?? 0

    await openReader(page, documentId)
    await expect(editingNotice(page)).toHaveText(ELSEWHERE)
    const takeovers = recordTakeovers(page, documentId)
    await takeOverHereButton(page).click()
    await waitForEditorAccess(page, 'edit')
    expect(takeovers).toEqual(['self'])
    expect(await editLeaseTakeover(documentId)).toBe('self')
    expect(await editLeaseEpoch(documentId)).toBe(epoch + 1)
    await typeInCell(page, 'A1', 'after the orphan')
    await saveAndWait(page)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('after the orphan')
  })

  test('US-M3-08 旧页面离开（刷新、关闭）时有保存在途（R1）：它不释放、留下记号；新页面说刚关闭或刷新的页面还有一次保存在进行，点"在此编辑"先说上一个页面的保存还在进行、等它，那次保存提交了才接手——服务器上有那次保存，接手之后的内容包括它', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('takeover-pending'))
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    // 新页面先打开（记号的 30 秒从旧页面离开时算：不把新页面的载入算进去）
    const fresh = await context.newPage()
    await openReader(fresh, documentId)
    // 旧页面的保存拦着（在途），这时离开：不释放（M3-P4）、放锁、留下记号
    const saves = await holdSaves(page)
    await typeInCell(page, 'A1', 'saved while leaving')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.held()).toBeGreaterThan(0)
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    expect(await editLeaseEndReason(documentId)).toBeNull()

    // 新页面再读一次编辑状态（回到前台时立即读）：锁空着、那一代还在，有 30 秒以内的记号、那次保存还没提交——说刚关闭或刷新的页面还有一次
    // 保存在进行，不说"那边会失去编辑权、另存为副本"（审查 B §七）
    await setPageHidden(fresh, true)
    await setPageHidden(fresh, false)
    await expect(statusRegion(fresh)).toHaveText(JUST_CLOSED)

    // 新页面：锁空着、那一代还在——"在此编辑"先等那次保存
    const takeovers = recordTakeovers(fresh, documentId)
    await takeOverHereButton(fresh).click()
    await expect(statusRegion(fresh)).toHaveText('上一个页面的保存还在进行，稍后接手…')
    // 读编辑状态的间隔（2 秒）过去了，那次保存还没提交：不接手
    await fresh.clock.fastForward(2_000)
    await expect(statusRegion(fresh)).toHaveText('上一个页面的保存还在进行，稍后接手…')
    expect(takeovers).toEqual([])

    // 那次保存到了服务端、提交了（旧页面那一代的令牌照样有效）；下一次读到修订号前进就接手
    saves.release()
    await expect.poll(async () => cellOf((await savedContent(fresh, documentId)).snapshot, 'A1')?.v).toBe('saved while leaving')
    await fresh.clock.fastForward(2_000)
    await waitForEditorAccess(fresh, 'edit')
    expect(takeovers).toEqual(['self'])
    expect(await editLeaseTakeover(documentId)).toBe('self')

    // 接手之后的内容包括那次保存：接着改、保存，服务器上两处都在
    await typeInCell(fresh, 'B1', 'after taking over')
    await saveAndWait(fresh)
    const saved = (await savedContent(fresh, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'B1')?.v]).toEqual(['saved while leaving', 'after taking over'])
  })

  test('US-M3-08 跨设备：另一台设备上的 B 说明是别处在编辑，"在此编辑"立即接手；A 下一次心跳得知被接管——不续上，失去编辑权（本人在另一台设备或浏览器上接手了），没保存的修改另存为副本', async ({ page, anotherDevice }) => {
    const person = await createUser('takeover-device')
    await loginThroughApi(page, person)
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const saves = await blockSaves(page)
    await typeInCell(page, 'A1', 'only on the first device')

    await loginThroughApi(anotherDevice, person)
    await openReader(anotherDevice, documentId)
    await expect(editingNotice(anotherDevice)).toHaveText(ELSEWHERE)
    const takeovers = recordTakeovers(anotherDevice, documentId)
    await takeOverHereButton(anotherDevice).click()
    await waitForEditorAccess(anotherDevice, 'edit')
    expect(takeovers).toEqual(['self'])
    expect(await editLeaseTakeover(documentId)).toBe('self')

    // A 的下一次心跳得知被接管：不再申请（不续上），按真实编辑状态 sameSession=false 立即定位；后台本机 5 秒窗口不阻塞说明。
    const acquisitions: Request[] = []
    page.on('request', (request) => {
      if (isLeaseAcquisition(request, documentId))
        acquisitions.push(request)
    })
    await pauseTime(page)
    await page.clock.fastForward(10_000)
    const lost = lostNotice(page)
    await advanceUntil(page, async () => lost.isVisible(), '另一登录的服务端事实立即给出接管位置')
    await expect(lost).toContainText('编辑权已失效：你在另一台设备或浏览器上接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    expect(await holdsDocumentLock(page, documentId)).toBe(true)
    await page.clock.fastForward(STEAL_WAIT_MS)
    await expect.poll(async () => holdsDocumentLock(page, documentId)).toBe(false)
    await page.clock.resume()
    await waitForEditorAccess(page, 'read')
    expect(acquisitions).toEqual([])
    await saves.unblock()
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    const copyId = await copiedDocumentId(page)
    expect(cellOf((await savedContent(page, copyId)).snapshot, 'A1')?.v).toBe('only on the first device')

    // B 照常编辑、保存；原文档里没有 A 没存上的修改
    await typeInCell(anotherDevice, 'B1', 'second device')
    await saveAndWait(anotherDevice)
    const saved = (await savedContent(anotherDevice, documentId)).snapshot
    expect([cellOf(saved, 'A1'), cellOf(saved, 'B1')?.v]).toEqual([undefined, 'second device'])
  })
})

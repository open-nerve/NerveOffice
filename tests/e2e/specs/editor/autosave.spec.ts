// 修改自动保存，保存状态如实显示（US-M3-02；M3-P4 设计 §3.2–§3.9，A02、A08）与面板的防抖（§3.4；面板里还没写进模型的输入算未保存，
// Codex 评审 CX4）。公式的一致（US-M3-03）在 autosave-formulas.spec.ts。
// 节奏经测试构建的自动保存控制（support/autosave.ts：夹具默认暂停定时的上传，用例放开；日志记下每次捕获与上传的原因、序号与时刻）与
// Playwright 的时钟（page.clock）把握：要看节奏的用例在打开之前装上时钟（之后时间照常流动，页面照常载入、渲染），修改之前停住时间，
// 之后只在往前拨的时候走——机器多忙，修改、捕获、上传与断言之间都不会有计时器自己到点，捕获与上传的时刻按调度的日志断言到毫秒
// （规范 §8.1：不等真实的计时）。公式在 Worker 里算、请求在途是真实的时间：停住时让到点的计时器执行再看（support/autosave.ts 的 logNow）。
// 往前拨的两种：runFor 逐个执行其间到点的计时器（动画帧每 16 毫秒一次，编辑器每帧都画：停住的 1 秒约合 1.5 秒真实时间）；
// skipAhead（support/autosave.ts）最初的 10 毫秒逐个执行、其余一跳到终点——要看的时刻正好是终点（上传在修改之后 2 秒、退避到点）或者
// 这段时间里什么也不该发生时用它
// 立即上传（保存按钮、快捷键、退出编辑、切到后台）在定时上传暂停时照常，那几条不放开。
// 控制只在测试构建里：标签 @test-build（容器 E2E 测生产镜像，按标签排除；生产镜像里自动保存照常运行，现有用例按此改写，见 S6 的汇报）
import type { Locator, Page, Route } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { canonicalContentText } from '@nerve-office/contracts'
import { autosaveLog, capturesOf, clearAutosaveLog, holdSaves, logNow, pauseTime, recordWrites, releaseAutosave, saveParam, setPageHidden, settleAfterEdit, skipAhead, uploadedText, uploadsOf } from '../../support/autosave.ts'
import { archiveSpace, createDocument, createDocumentIn, createTeamSpace, createUser, editLeaseEndReason, expireSessions, revisionOf } from '../../support/database.ts'
import { probeSnapshot, setCellValue } from '../../support/editor-probe.ts'
import { expect, test } from '../../support/fixtures.ts'
import { pressUniverShortcut } from '../../support/keyboard.ts'
import { sampleWithoutImagesFor } from '../../support/read-only-sample.ts'
import { loginThroughApi, loginThroughUi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditing, exitEditButton, exitEditing, isSaveRequest, lostNotice, openAndEnterEditing, reloadAndEnterEditing, resourceOf, ribbon, saveAndCapture, saveButton, savedContent, saveStatus, selectCell, typeInCell, waitForEditorAccess, wouldPromptOnLeave } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

const FIRST_SHEET = 'sheet-1'

async function openNewSheet(page: Page, prefix: string, stage: 'ready' | 'steady' = 'ready'): Promise<string> {
  await loginThroughApi(page, await createUser(prefix))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId, stage)
  return documentId
}

/** 快照里一项资源按内容的口径（contracts 的规范化：深层为空的去掉、第一层取值为空的键去掉）解析出的值；没有时为 undefined */
function canonicalResource(snapshotText: string, name: string): unknown {
  const canonical = JSON.parse(canonicalContentText(snapshotText)) as { resources: { name: string, data: unknown }[] }
  return canonical.resources.find(resource => resource.name === name)?.data
}

/** 编辑器页的页头与说明（#editor-chrome）里的一条说明（role="alert"） */
function alertWith(page: Page, text: string | RegExp) {
  return page.locator('#editor-chrome').getByRole('alert').filter({ hasText: text })
}

test.describe('US-M3-02 修改自动保存，保存状态如实显示', { tag: '@test-build' }, () => {
  test('US-M3-02 修改停下 2 秒自动上传（没按保存）：停 1 秒捕获、2 秒上传，不到点不传；上传在途是"保存中…"，回包之前不说已保存，之后回到"已保存到云端"', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-quiet')
    const writes = recordWrites(page, documentId)
    const held = await holdSaves(page)
    await releaseAutosave(page)
    const changedAt = await pauseTime(page)
    await typeInCell(page, 'A1', 'auto')
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    // 停下不到 1 秒：不捕获；到 1 秒：捕获（公式收齐才算，没收齐时推迟到收齐，捕获的时刻照样是修改之后 1 秒）
    await page.clock.runFor(999)
    expect(capturesOf(await logNow(page))).toEqual([])
    await page.clock.runFor(1)
    await expect.poll(async () => capturesOf(await logNow(page))).toMatchObject([{ trigger: 'quiet', seq: 1, formulasPending: false, at: changedAt + 1_000 }])
    // 上传在修改之后 2 秒：拨到它之前 1 ms，还没传；再拨 1 ms，传了
    await page.clock.runFor(999)
    expect(writes.saves).toHaveLength(0)
    await page.clock.runFor(1)
    await expect.poll(held.held).toBe(1)
    // 回包之前（拦着）：保存中，不说已保存
    await expect(saveStatus(page)).toHaveText('保存中…')
    expect(uploadsOf(await autosaveLog(page))).toEqual([])
    held.release()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(uploadsOf(await autosaveLog(page))).toMatchObject([{ trigger: 'quiet', startedAt: changedAt + 2_000, seq: 1, outcome: { kind: 'saved' } }])
    expect(writes.saves).toHaveLength(1)
    await page.clock.resume()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('auto')
  })

  test('US-M3-02 持续编辑（每 0.5 秒改一处、持续 16 秒，从不停够 1 秒）：每 3 秒捕获一次（上限），从第一处修改算起 15 秒上传一次、不等停下；停下 2 秒再上传一次', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-continuous')
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    const start = await pauseTime(page)
    // 第 k 处修改在 start + 500k（k = 0…32）：改完让 SDK 的这一轮算完（上限到时的捕获不因公式没收齐带标记），再拨到下一处。
    // 捕获与上传该到的时刻都是 500 毫秒的整数倍，正是每一步的终点：skipAhead
    const editAndAdvance = async (edit: number): Promise<void> => {
      await setCellValue(page, `A${edit + 1}`, edit)
      await settleAfterEdit(page)
      await skipAhead(page, 490)
    }
    for (let edit = 0; edit <= 28; edit += 1)
      await editAndAdvance(edit)
    // 拨到了 start + 14500：15 秒还没到，一次也没传
    expect(writes.saves).toHaveLength(0)
    for (let edit = 29; edit <= 32; edit += 1)
      await editAndAdvance(edit)
    // 停在 start + 16500：最后一处在 start + 16000，再拨到 start + 17000（停 1 秒捕获）、start + 18000（停 2 秒上传）
    await skipAhead(page, 500)
    await skipAhead(page, 1_000)
    await expect.poll(async () => uploadsOf(await logNow(page)).length).toBe(2)
    const log = await autosaveLog(page)
    expect(capturesOf(log).map(({ trigger, at, seq, formulasPending }) => ({ trigger, at: at - start, seq, formulasPending }))).toEqual([
      { trigger: 'cap', at: 3_000, seq: 6, formulasPending: false },
      { trigger: 'cap', at: 6_000, seq: 12, formulasPending: false },
      { trigger: 'cap', at: 9_000, seq: 18, formulasPending: false },
      { trigger: 'cap', at: 12_000, seq: 24, formulasPending: false },
      { trigger: 'cap', at: 15_000, seq: 30, formulasPending: false },
      { trigger: 'quiet', at: 17_000, seq: 33, formulasPending: false },
    ])
    expect(uploadsOf(log).map(({ trigger, startedAt, seq, outcome }) => ({ trigger, startedAt: startedAt - start, seq, outcome: outcome.kind }))).toEqual([
      { trigger: 'cap', startedAt: 15_000, seq: 30, outcome: 'saved' },
      { trigger: 'quiet', startedAt: 18_000, seq: 33, outcome: 'saved' },
    ])
    expect(writes.saves).toHaveLength(2)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.clock.resume()
    const saved = (await savedContent(page, documentId)).snapshot
    expect(Array.from({ length: 33 }, (_, edit) => cellOf(saved, `A${edit + 1}`)?.v)).toEqual(Array.from({ length: 33 }, (_, edit) => edit))
  })

  test('US-M3-02 保存按钮与 Cmd/Ctrl+S 立即上传（定时上传暂停时照样，不等停下）；一律上传、不去重：没改再按也上传，服务端回答内容相同，修订号不变', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-button')
    const writes = recordWrites(page, documentId)
    await typeInCell(page, 'A1', 'button')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await typeInCell(page, 'A2', 'shortcut')
    await page.keyboard.press('ControlOrMeta+s')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await revisionOf(documentId)).toBe(3)
    // 没改再按：照样上传（兜住变更检测看不见的改动），内容相同，服务端只写回执
    const answered = page.waitForResponse(response => isSaveRequest(response.request()))
    await saveButton(page).click()
    expect(await (await answered).json()).toMatchObject({ revision: 3, unchanged: true })
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves).toHaveLength(3)
    expect(uploadsOf(await autosaveLog(page)).map(upload => [upload.trigger, upload.outcome.kind])).toEqual([['save-button', 'saved'], ['save-button', 'saved'], ['save-button', 'saved']])
    expect(await revisionOf(documentId)).toBe(3)
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'A2')?.v]).toEqual(['button', 'shortcut'])
  })

  test('US-M3-02 切到后台（visibilitychange 变成 hidden）立即上传：定时上传暂停时照样，不等计时器；回到前台不重复', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-hidden')
    const writes = recordWrites(page, documentId)
    await typeInCell(page, 'A1', 'background')
    await clearAutosaveLog(page)
    await setPageHidden(page, true)
    await expect.poll(() => writes.saves.length).toBe(1)
    await expect.poll(async () => uploadsOf(await autosaveLog(page))).toMatchObject([{ trigger: 'hidden', outcome: { kind: 'saved' } }])
    await setPageHidden(page, false)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves).toHaveLength(1)
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('background')
  })

  test('US-M3-02 退出编辑立即上传（定时上传暂停时照样）：先存上再释放编辑权；没有修改时退出不上传', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-exit')
    const writes = recordWrites(page, documentId)
    await typeInCell(page, 'A1', 'exit')
    await exitEditing(page)
    expect(writes.saves).toHaveLength(1)
    expect(writes.releases).toHaveLength(1)
    expect(uploadsOf(await autosaveLog(page))).toMatchObject([{ trigger: 'exit', outcome: { kind: 'saved' } }])
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('exit')
    await enterEditing(page)
    await exitEditing(page)
    expect(writes.saves).toHaveLength(1)
    expect(writes.releases).toHaveLength(2)
  })

  test('US-M3-02 A08：自动保存在途时继续输入——回包之后仍是"有未保存的修改"，服务器上是捕获那一刻的内容；下一次自动保存存上后来的', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-a08')
    const held = await holdSaves(page)
    await releaseAutosave(page)
    const start = await pauseTime(page)
    await typeInCell(page, 'A1', 'first')
    await skipAhead(page, 2_000)
    await expect.poll(held.held).toBe(1)
    await expect(saveStatus(page)).toHaveText('保存中…')
    // 上传在途（拦着）时继续输入
    await typeInCell(page, 'A2', 'second')
    held.release()
    await expect.poll(async () => uploadsOf(await autosaveLog(page))).toMatchObject([{ trigger: 'quiet', startedAt: start + 2_000, seq: 1, outcome: { kind: 'saved' } }])
    // 已保存的只前进到捕获时的那个：后来的修改还没存
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    expect(await wouldPromptOnLeave(page)).toBe(true)
    const first = (await savedContent(page, documentId)).snapshot
    expect([cellOf(first, 'A1')?.v, cellOf(first, 'A2')]).toEqual(['first', undefined])
    // 后来的那一处：停 1 秒捕获、2 秒上传
    await skipAhead(page, 2_000)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(uploadsOf(await autosaveLog(page)).map(({ trigger, startedAt, seq }) => ({ trigger, startedAt: startedAt - start, seq }))).toEqual([
      { trigger: 'quiet', startedAt: 2_000, seq: 1 },
      { trigger: 'quiet', startedAt: 4_000, seq: 2 },
    ])
    await page.clock.resume()
    const second = (await savedContent(page, documentId)).snapshot
    expect([cellOf(second, 'A1')?.v, cellOf(second, 'A2')?.v]).toEqual(['first', 'second'])
  })

  test('US-M3-02 单元格里正在输入（还没回车）：自动保存只存已经提交的，不提交、不打断这次输入，页头照旧"有未保存的修改"；回车之后存上', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-cell-input')
    await releaseAutosave(page)
    const start = await pauseTime(page)
    await typeInCell(page, 'A1', 'done')
    await typeInCell(page, 'B1', 'typing', false)
    await skipAhead(page, 2_000)
    await expect.poll(async () => uploadsOf(await logNow(page))).toMatchObject([{ trigger: 'quiet', startedAt: start + 2_000, seq: 1, outcome: { kind: 'saved' } }])
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    const first = (await savedContent(page, documentId)).snapshot
    expect([cellOf(first, 'A1')?.v, cellOf(first, 'B1')]).toEqual(['done', undefined])
    // 输入没被打断：接着键入落在同一个单元格里，回车之后是连在一起的一段
    await page.keyboard.type('more')
    await page.keyboard.press('Enter')
    await skipAhead(page, 2_000)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.clock.resume()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'B1')?.v).toBe('typingmore')
  })

  test('US-M3-02 会话内去重：改了又撤销——与确认过的那一份相同时不上传；打开之后不知道服务端那一份的摘要，第一次照常发出、服务端回答内容相同（修订号不变），之后才不再上传；只改视图（缩放、滚动、选区）不算修改，不捕获也不上传', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-dedupe')
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    await pauseTime(page)
    /** 键入一处、撤销它：内容回到之前的样子（修改序号加了两次），再往前拨 2 秒（停 1 秒捕获、2 秒上传） */
    const changeAndUndo = async (text: string): Promise<void> => {
      await typeInCell(page, 'A1', text)
      await pressUniverShortcut(page, 'Z')
      await skipAhead(page, 2_000)
    }
    const outcomes = async (): Promise<string[]> => uploadsOf(await logNow(page)).map(upload => upload.outcome.kind)
    await typeInCell(page, 'A1', 'kept')
    await skipAhead(page, 2_000)
    await expect.poll(outcomes).toEqual(['saved'])
    expect(await revisionOf(documentId)).toBe(2)
    // 改了又撤销：与刚确认过的那一份相同，不上传（按这次的序号确认）
    await changeAndUndo('temp')
    await expect.poll(outcomes).toEqual(['saved', 'deduped'])
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves).toHaveLength(1)

    // 重新打开（新的一次编辑）：不知道服务端那一份的摘要，改了又撤销之后的第一次照常发出，服务端回答内容相同、修订号不变；再一次才不发
    await page.clock.resume()
    await reloadAndEnterEditing(page)
    await releaseAutosave(page)
    await clearAutosaveLog(page)
    const reopened = recordWrites(page, documentId)
    await pauseTime(page)
    await changeAndUndo('again')
    await expect.poll(outcomes).toEqual(['saved'])
    expect(reopened.saves).toHaveLength(1)
    expect(await (await reopened.saves[0]?.response())?.json()).toMatchObject({ revision: 2, unchanged: true })
    await changeAndUndo('once more')
    await expect.poll(outcomes).toEqual(['saved', 'deduped'])
    expect(reopened.saves).toHaveLength(1)
    await expect(saveStatus(page)).toHaveText('已保存到云端')

    // 只改视图：缩放、滚动、选区不是修改
    const captures = capturesOf(await autosaveLog(page)).length
    await page.evaluate(() => {
      const sheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
      if (sheet === undefined)
        throw new Error('页面里没有编辑器的探针')
      sheet.zoom(1.5)
      sheet.scrollToCell(40, 8)
      sheet.getRange('C7').activate()
    })
    await skipAhead(page, 5_000)
    expect(capturesOf(await logNow(page))).toHaveLength(captures)
    expect(reopened.saves).toHaveLength(1)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.clock.resume()
    expect(await revisionOf(documentId)).toBe(2)
  })

  test('US-M3-02 A02：M0 的保存重开样本（各插件的资源，去掉图片）经自动保存的管道（捕获、等公式、压缩、上传、服务端校验与规范化哈希）存下之后重开一致；再保存一次服务端回答内容相同，修订号不增加', async ({ page }) => {
    const owner = await createUser('autosave-a02')
    const documentId = await createDocument(owner, '保存重开样本', sampleWithoutImagesFor)
    await loginThroughApi(page, owner)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    const start = await pauseTime(page)
    await setCellValue(page, 'K20', '经自动保存')
    await skipAhead(page, 2_000)
    await expect.poll(async () => uploadsOf(await logNow(page))).toMatchObject([{ trigger: 'quiet', startedAt: start + 2_000, outcome: { kind: 'saved' } }])
    await page.clock.resume()
    // 服务器上存下的就是本页捕获、上传的那一份；各插件的资源都在，按内容的口径（规范化：SDK 改过一张表之后给它补上空的规则表，
    // 打开时又去掉，contracts 的 content-canonical.ts 第 2 步）与样本的相同
    const saved = await savedContent(page, documentId)
    expect(saved.revision).toBe(2)
    expect(saved.text).toBe(uploadedText(writes.saves[0]))
    const sample = sampleWithoutImagesFor(saved.snapshot.id)
    const plugins = (JSON.parse(sample) as Workbook).resources.filter(resource => resource.data !== '' && resource.data !== '{}' && resource.data !== '[]').map(resource => resource.name)
    expect(plugins).toEqual(expect.arrayContaining(['SHEET_CONDITIONAL_FORMATTING_PLUGIN', 'SHEET_DATA_VALIDATION_PLUGIN', 'SHEET_DEFINED_NAME_PLUGIN', 'SHEET_FILTER_PLUGIN', 'SHEET_NOTE_PLUGIN']))
    for (const name of plugins)
      expect(canonicalResource(saved.text, name), name).toEqual(canonicalResource(sample, name))
    expect(cellOf(saved.snapshot, 'K20')?.v).toBe('经自动保存')
    // 重开：编辑器里的内容按内容的口径与服务器上的相同，打开不算修改
    await reloadAndEnterEditing(page, 'steady')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(canonicalContentText(await probeSnapshot(page))).toBe(canonicalContentText(saved.text))
    // 再保存一次：内容相同，修订号不增加
    const again = await saveAndCapture(page)
    expect(again.answer).toMatchObject({ revision: 2, unchanged: true })
    expect(canonicalContentText(again.uploaded)).toBe(canonicalContentText(saved.text))
    expect(await revisionOf(documentId)).toBe(2)
  })

  test('US-M3-02 离线：页头说已离线（修改还在本页），过了静默也不发请求；恢复联网立即上传最近一次捕获（不等静默），之后的修改照常', async ({ page, context }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-offline')
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    const start = await pauseTime(page)
    await context.setOffline(true)
    await typeInCell(page, 'A1', 'offline')
    await expect(saveStatus(page)).toHaveText('已离线：修改还在本页，恢复网络之后自动保存')
    // 照常捕获（修改之后 1 秒），过了上传的静默也不上传
    await page.clock.runFor(1_000)
    await skipAhead(page, 4_000)
    await expect.poll(async () => capturesOf(await logNow(page))).toMatchObject([{ trigger: 'quiet', at: start + 1_000, seq: 1 }])
    expect(writes.saves).toHaveLength(0)
    expect(uploadsOf(await autosaveLog(page))).toEqual([])
    await expect(saveStatus(page)).toHaveText('已离线：修改还在本页，恢复网络之后自动保存')
    // 离线时又改了一处（start + 5000），0.5 秒之后恢复联网：不等这一处的静默，立即上传最近一次捕获（第一处）
    await typeInCell(page, 'A2', 'later')
    await skipAhead(page, 500)
    await context.setOffline(false)
    await expect.poll(async () => uploadsOf(await logNow(page))).toMatchObject([{ trigger: 'online', startedAt: start + 5_500, seq: 1, outcome: { kind: 'saved' } }])
    // 后来的那一处照常：停 1 秒捕获、2 秒上传
    await skipAhead(page, 500)
    await skipAhead(page, 1_000)
    await expect.poll(async () => uploadsOf(await logNow(page)).length).toBe(2)
    expect(uploadsOf(await autosaveLog(page))[1]).toMatchObject({ trigger: 'quiet', startedAt: start + 7_000, seq: 2, outcome: { kind: 'saved' } })
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await page.clock.resume()
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'A2')?.v]).toEqual(['offline', 'later'])
  })

  test('US-M3-02 服务繁忙（503 带 Retry-After）与服务端出错（502）：页头说保存失败、稍后自动重试；503 按服务端给的时间等，之后按退避等（第二次失败之后 4 秒），到点原样重发同一个 requestId', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-busy')
    const writes = recordWrites(page, documentId)
    // 第一次保存：服务繁忙，7 秒之后再试（比退避的 2 秒长）；第二次：代理出错（结果未知，没有 Retry-After）；之后照常
    let failed = 0
    await page.route('**/api/documents/*/content?*', async (route: Route) => {
      if (route.request().method() !== 'PUT' || failed >= 2) {
        await route.continue()
        return
      }
      failed += 1
      if (failed === 1)
        await route.fulfill({ status: 503, headers: { 'retry-after': '7' }, contentType: 'application/json', json: { error: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试', requestId: 'e2e-busy' } } })
      else
        await route.fulfill({ status: 502, contentType: 'text/html', body: 'bad gateway' })
    })
    await releaseAutosave(page)
    const start = await pauseTime(page)
    await typeInCell(page, 'A1', 'busy')
    await skipAhead(page, 2_000)
    await expect.poll(async () => uploadsOf(await logNow(page))).toMatchObject([{ trigger: 'quiet', startedAt: start + 2_000, outcome: { kind: 'failed', failure: { kind: 'retry', retryAfterMs: 7_000 } } }])
    await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
    await expect(alertWith(page, '保存失败：')).toBeVisible()
    // 按 Retry-After 等：7 秒之前不重发
    await skipAhead(page, 6_999)
    expect(writes.saves).toHaveLength(1)
    await skipAhead(page, 1)
    await expect.poll(async () => uploadsOf(await logNow(page)).length).toBe(2)
    expect(uploadsOf(await autosaveLog(page))[1]).toMatchObject({ trigger: 'retry', startedAt: start + 9_000, outcome: { kind: 'failed', failure: { kind: 'retry' } } })
    await expect(saveStatus(page)).toHaveText('保存失败，稍后自动重试')
    // 第二次失败：退避翻倍到 4 秒（服务端这次没给 Retry-After）
    await skipAhead(page, 3_999)
    expect(writes.saves).toHaveLength(2)
    await skipAhead(page, 1)
    await expect.poll(async () => uploadsOf(await logNow(page)).length).toBe(3)
    expect(uploadsOf(await autosaveLog(page))[2]).toMatchObject({ trigger: 'retry', startedAt: start + 13_000, outcome: { kind: 'saved' } })
    expect(writes.saves).toHaveLength(3)
    // 原样重发：同一个 requestId、同样的正文
    expect(new Set(writes.saves.map(save => saveParam(save, 'requestId')))).toEqual(new Set([saveParam(writes.saves[0], 'requestId')]))
    expect(new Set(writes.saves.map(save => uploadedText(save)))).toEqual(new Set([uploadedText(writes.saves[0])]))
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect(alertWith(page, '保存失败：')).toHaveCount(0)
    await page.clock.resume()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('busy')
  })

  test('US-M3-02 服务端拒绝的内容（422，嵌套过深）：同一份不再自动重传；有了新的修改才再试（仍不合格照样被拒），改对之后存上', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-rejected')
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    await pauseTime(page)
    // 单元格的自定义数据嵌套 80 层：页面照常捕获、上传，服务端按嵌套的上限（64 层）拒绝
    await page.evaluate(() => {
      let deep: Record<string, unknown> = { leaf: true }
      for (let level = 0; level < 80; level += 1)
        deep = { level: deep }
      const sheet = window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet()
      if (sheet === undefined)
        throw new Error('页面里没有编辑器的探针')
      sheet.getRange('B2').setCustomMetaData(deep)
    })
    await skipAhead(page, 2_000)
    await expect.poll(async () => uploadsOf(await logNow(page))).toMatchObject([{ outcome: { kind: 'failed', failure: { kind: 'content' } } }])
    await expect(saveStatus(page)).toHaveText('保存失败')
    await expect(alertWith(page, '保存失败：表格的内容过于复杂（嵌套太深）')).toBeVisible()
    // 同一份内容不再自动重传：会自动重试的失败第一次退避 2 秒、之后翻倍，过了几轮也没有发
    await skipAhead(page, 5_000)
    await skipAhead(page, 5_000)
    expect(writes.saves).toHaveLength(1)
    // 有了新的修改（内容仍不合格）：再试一次，照样被拒
    await setCellValue(page, 'A1', '新的修改')
    await skipAhead(page, 2_000)
    await expect.poll(() => writes.saves.length).toBe(2)
    await expect.poll(async () => uploadsOf(await logNow(page)).map(upload => upload.outcome.kind)).toEqual(['failed', 'failed'])
    // 改对（去掉嵌套的数据）：存上
    await page.evaluate(() => {
      window.__nerveEditorProbe?.univerAPI.getActiveWorkbook().getActiveSheet().getRange('B2').setCustomMetaData({})
    })
    await skipAhead(page, 2_000)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves).toHaveLength(3)
    await page.clock.resume()
    const saved = await savedContent(page, documentId)
    expect([saved.revision, cellOf(saved.snapshot, 'A1')?.v]).toEqual([2, '新的修改'])
  })

  test('US-M3-02 离开提示：有还没上传的修改时离开会提示；自动保存存上之后不再提示', async ({ page }) => {
    await page.clock.install()
    await openNewSheet(page, 'autosave-leave')
    await releaseAutosave(page)
    await pauseTime(page)
    expect(await wouldPromptOnLeave(page)).toBe(false)
    await typeInCell(page, 'A1', 'leave')
    expect(await wouldPromptOnLeave(page)).toBe(true)
    // 捕获了、还没上传：照样提示
    await page.clock.runFor(1_000)
    await expect.poll(async () => capturesOf(await logNow(page)).length).toBe(1)
    expect(await wouldPromptOnLeave(page)).toBe(true)
    await page.clock.runFor(1_000)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await wouldPromptOnLeave(page)).toBe(false)
  })

  test('US-M3-02 登录过期：自动保存的上传得到 401 之后暂停（页头说暂停保存、登录回来之后自动保存），之后不再发请求——没有 401 接连不断；本人在新标签页登录回来之后自动上传', async ({ page, context }) => {
    const owner = await createUser('autosave-session')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    await pauseTime(page)
    // 登录过期之后的一处修改：停 2 秒上传，得到 401；页面确认会话之后说明本页的修改还在、在新标签页登录
    await expireSessions(owner)
    await typeInCell(page, 'A1', 'kept')
    await skipAhead(page, 2_000)
    const signedOut = alertWith(page, '本页的修改还在')
    await expect.poll(async () => {
      await page.clock.runFor(0)
      return signedOut.count()
    }).toBe(1)
    await expect(saveStatus(page)).toHaveText('暂停保存：登录回来之后自动保存')
    expect(writes.saves).toHaveLength(1)
    expect(uploadsOf(await autosaveLog(page))).toMatchObject([{ outcome: { kind: 'failed', failure: { kind: 'session' } } }])
    // 之后的修改：照常捕获，不上传（会话不对时不发；会话类的失败照样退避，到点也不发）
    await typeInCell(page, 'A2', 'also kept')
    await skipAhead(page, 5_000)
    await skipAhead(page, 5_000)
    await expect.poll(async () => capturesOf(await logNow(page)).length).toBe(2)
    expect(writes.saves).toHaveLength(1)
    await expect(saveStatus(page)).toHaveText('暂停保存：登录回来之后自动保存')
    // 本人在新标签页登录：本页确认是本人、续上编辑权，随即自动上传（不用按保存）
    await page.clock.resume()
    const [loginPage] = await Promise.all([context.waitForEvent('page'), signedOut.getByRole('link', { name: '在新标签页中登录' }).click()])
    await expect(loginPage.getByRole('form', { name: '登录' })).toBeVisible()
    await loginThroughUi(loginPage, owner)
    await expect(loginPage.getByRole('heading', { name: '我的空间' })).toBeVisible()
    await expect(signedOut).toBeHidden()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves.length).toBeGreaterThan(1)
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'A2')?.v]).toEqual(['kept', 'also kept'])
  })

  test('US-M3-02 确认会话断网（审查 A6）：自动保存暂停，页头说暂时无法确认登录状态（人一直在登录中，不说"登录回来之后"），确认失败期间不再发；网络恢复之后页面自己再确认、换上新的令牌，不用按保存就存上', async ({ page, context }) => {
    const owner = await createUser('autosave-unconfirmed')
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    // 同一个人在别处经接口重新登录：本页的令牌失效（没有广播）；本页确认会话断网
    const other = await context.newPage()
    await loginThroughApi(other, owner)
    let checks = 0
    await page.route('**/api/auth/session', async (route) => {
      checks += 1
      await route.abort('internetdisconnected')
    })
    // 自动保存的上传得到令牌失效，页面确认会话、断网：暂停
    await typeInCell(page, 'A1', 'kept')
    await expect(saveStatus(page)).toHaveText('暂停保存：暂时无法确认登录状态，稍后自动重试')
    expect(writes.saves).toHaveLength(1)
    // 之后的修改不上传：页面定时再确认（2、4……秒）照样断网，不带着失效的令牌再发
    await typeInCell(page, 'A2', 'also kept')
    const failedChecks = checks
    await expect.poll(() => checks, { timeout: 15_000 }).toBeGreaterThan(failedChecks)
    expect(writes.saves).toHaveLength(1)
    await expect(saveStatus(page)).toHaveText('暂停保存：暂时无法确认登录状态，稍后自动重试')
    // 网络恢复（联网的事件）：页面立即再确认，是本人、换上新的令牌、续上编辑权，自动保存随即上传
    await page.unroute('**/api/auth/session')
    await context.setOffline(true)
    await context.setOffline(false)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(writes.saves.length).toBeGreaterThan(1)
    const saved = (await savedContent(page, documentId)).snapshot
    expect([cellOf(saved, 'A1')?.v, cellOf(saved, 'A2')?.v]).toEqual(['kept', 'also kept'])
  })

  test('US-M3-02 失去编辑权（空间刚被归档，自动保存得知 403）：自动保存停下，之后不再发；本页的内容另存为副本照常', async ({ page }) => {
    const lead = await createUser('autosave-lost-lead')
    const editor = await createUser('autosave-lost-editor')
    const space = await createTeamSpace('自动保存失去编辑权', lead, [[lead, 'admin'], [editor, 'editor']])
    const documentId = await createDocumentIn(space.id, lead, '共同的表')
    await loginThroughApi(page, editor)
    await page.clock.install()
    await openAndEnterEditing(page, documentId)
    const writes = recordWrites(page, documentId)
    await releaseAutosave(page)
    await pauseTime(page)
    await typeInCell(page, 'A1', '存上了的')
    await skipAhead(page, 2_000)
    await expect.poll(async () => uploadsOf(await logNow(page)).map(upload => upload.outcome.kind)).toEqual(['saved'])
    // 归档之后的修改：自动保存上传得到 403，本页失去编辑权、以只读重建（渲染靠动画帧，往前拨让它走完）
    await typeInCell(page, 'B1', '没存上的')
    await archiveSpace(space.id)
    await skipAhead(page, 2_000)
    await expect.poll(() => writes.saves.length).toBe(2)
    const lost = lostNotice(page)
    await expect.poll(async () => {
      await page.clock.runFor(100)
      return (await lost.count()) === 1 ? lost.textContent() : null
    }).toContain('本页的修改没有保存：可以另存为副本，或者放弃这些修改。')
    // 停下了：会自动重试的失败第一次退避 2 秒、之后翻倍，过了几轮也没有再发保存
    await skipAhead(page, 5_000)
    await skipAhead(page, 5_000)
    expect(writes.saves).toHaveLength(2)
    await page.clock.resume()
    await waitForEditorAccess(page, 'read')
    expect(writes.saves).toHaveLength(2)
    // 副本照常：是本页的内容（两处都在）
    await lost.getByRole('button', { name: '另存为副本', exact: true }).click()
    const notice = page.locator('#editor-chrome').getByRole('status').filter({ hasText: '已另存为副本' })
    const link = notice.getByRole('link', { name: '打开副本（新标签页）', exact: true })
    await expect(link).toBeVisible()
    const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    const copy = (await savedContent(page, copyId)).snapshot
    expect([cellOf(copy, 'A1')?.v, cellOf(copy, 'B1')?.v]).toEqual(['存上了的', '没存上的'])
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'B1')).toBeUndefined()
  })

  test('US-M3-02 本页的版本过旧（自动保存得到 CLIENT_OUTDATED）：页头"需要刷新"，放掉编辑权，之后的修改不再上传', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'autosave-outdated')
    const writes = recordWrites(page, documentId)
    // 把这个页面的保存改写成旧页面的（查询参数里的 Univer 版本换成旧的）：服务端回答 CLIENT_OUTDATED
    await page.route('**/api/documents/*/content?*', async (route: Route) => {
      if (route.request().method() !== 'PUT') {
        await route.continue()
        return
      }
      const url = new URL(route.request().url())
      url.searchParams.set('univerVersion', '0.0.1')
      await route.continue({ url: url.toString() })
    })
    await releaseAutosave(page)
    await pauseTime(page)
    await typeInCell(page, 'A1', '旧页面的修改')
    await skipAhead(page, 2_000)
    await expect.poll(() => writes.saves.length).toBe(1)
    await expect.poll(async () => {
      await page.clock.runFor(0)
      return saveStatus(page).textContent()
    }).toBe('需要刷新')
    await expect(alertWith(page, /^页面的版本过旧/)).toContainText('本页的修改没有保存，也不能再保存')
    // 之后的修改：不再上传
    await typeInCell(page, 'A2', '之后的修改')
    await skipAhead(page, 5_000)
    await skipAhead(page, 5_000)
    expect(writes.saves).toHaveLength(1)
    await page.clock.resume()
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
    expect(await revisionOf(documentId)).toBe(1)
  })

  test('US-M3-02 页面关闭（pagehide）时有保存在途：不释放编辑权（让它到期，免得释放先提交、那次保存被拒）；没有在途的保存时照旧释放', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-pagehide')
    const writes = recordWrites(page, documentId)
    const held = await holdSaves(page)
    await typeInCell(page, 'A1', 'in flight')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('保存中…')
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    // 让释放有机会发出（它是同步发起的 keepalive 请求）：没有发
    await expect(saveStatus(page)).toHaveText('保存中…')
    expect(writes.releases).toHaveLength(0)
    held.release()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    // 编辑权还在（没有明确结束）：那次保存照常提交了
    expect(await editLeaseEndReason(documentId)).toBeNull()
    expect(cellOf((await savedContent(page, documentId)).snapshot, 'A1')?.v).toBe('in flight')
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await expect.poll(() => writes.releases.length).toBe(1)
    await expect.poll(async () => editLeaseEndReason(documentId)).toBe('released')
  })
})

test.describe('面板的防抖：退出编辑之前先让面板里最后的改动写进模型（M3-P4 设计 §3.4、§7）', { tag: '@test-build' }, () => {
  test('批注浮层里键入之后立即退出编辑（SDK 300 ms 之后才写进批注）：服务器上有这次键入的全部文字', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-note')
    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    await page.getByRole('textbox', { name: '在此输入' }).click()
    await page.keyboard.type('remember')
    await exitEditButton(page).click()
    await waitForEditorAccess(page, 'read')
    const { snapshot } = await savedContent(page, documentId)
    expect(resourceOf(snapshot, 'SHEET_NOTE_PLUGIN')).toMatchObject({ [FIRST_SHEET]: { 3: { 3: { note: 'remember', row: 3, col: 3 } } } })
  })

  test('数据验证面板里改了数值之后立即退出编辑（SDK 1 秒之后才写进规则）：服务器上的规则是改过的', async ({ page }) => {
    const documentId = await openNewSheet(page, 'autosave-dv')
    await selectCell(page, 'C3')
    const data = await ribbon(page, '数据')
    await data.getByRole('button', { name: '数据验证' }).click()
    await page.getByRole('menuitem', { name: '新建规则' }).click()
    // 新建的规则是"数字等于 100"：把数值改成 250
    const value = page.getByRole('complementary', { name: '侧边栏' }).getByRole('textbox').last()
    await value.fill('250')
    await exitEditButton(page).click()
    await waitForEditorAccess(page, 'read')
    const { snapshot } = await savedContent(page, documentId)
    expect(resourceOf(snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')).toMatchObject({
      [FIRST_SHEET]: [{ type: 'decimal', operator: 'equal', formula1: '250', ranges: [{ startRow: 2, startColumn: 2, endRow: 2, endColumn: 2 }] }],
    })
  })
})

// 面板里还没写进模型的输入（Codex 评审 CX4，M3-P6 设计 §3.13）：批注浮层、数据验证面板按 SDK 的防抖（300 ms、1 秒）才把改动写进模型。
// 这段时间离开提示要拦下、页头不说"已保存到云端"（期间到来的旧的保存确认也不说），到点写进模型之后照常自动保存。原来保存的状态机看不到
// 这一段：页头说已保存、离开不提示，离开就丢（评审在真实 Chromium 上复现：数据验证的数值 100 改成 250，导航没有提示，服务器上仍是 100）。
// 不用测试构建的控制（容器 E2E 同样跑）：自动保存照常运行，时间经 Playwright 的时钟停住——SDK 的防抖与自动保存的计时器都只在往前拨、
// 恢复之后到点
test.describe('US-M3-02 面板里还没写进模型的输入：离开提示拦下、页头不说已保存，到点之后照常自动保存（Codex 评审 CX4）', () => {
  test.use({ autosave: 'running' })

  /** 编辑器页头里回到"我的空间"的链接（整页跳转） */
  function backLink(page: Page): Locator {
    return page.locator('#editor-chrome').getByRole('link', { name: '我的空间', exact: true })
  }

  /** 服务器上 C3 的数据验证规则的数值 */
  async function storedRuleValue(page: Page, documentId: string): Promise<unknown> {
    const rules = resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN') as Record<string, { formula1?: unknown }[] | undefined> | undefined
    return rules?.[FIRST_SHEET]?.[0]?.formula1
  }

  /**
   * 打开新表格（先装上时钟）、进入编辑，在 C3 上新建数据验证规则（数字等于 100），等自动保存把它存上、离开不再提示：之后"有没存的"
   * 只看面板里的输入。交回文档与面板里数值的输入框
   */
  async function openSavedRule(page: Page, prefix: string): Promise<{ documentId: string, value: Locator }> {
    await page.clock.install()
    const documentId = await openNewSheet(page, prefix)
    await selectCell(page, 'C3')
    const data = await ribbon(page, '数据')
    await data.getByRole('button', { name: '数据验证' }).click()
    await page.getByRole('menuitem', { name: '新建规则' }).click()
    const value = page.getByRole('complementary', { name: '侧边栏' }).getByRole('textbox').last()
    await expect(value).toHaveValue('100')
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await expect.poll(async () => wouldPromptOnLeave(page)).toBe(false)
    expect(await storedRuleValue(page, documentId)).toBe('100')
    return { documentId, value }
  }

  /**
   * 停住时间（pauseTime：先往前跳 1 秒，其间到点的计时器照常执行），再核对前提：都已存上、离开不提示。之后的"未保存""离开提示"只能
   * 来自面板里这一次的输入——之前若还有 SDK 防抖中的写入（打开批注浮层时 SDK 按同一个防抖写进一条空批注），它会在这 1 秒里到点，
   * 旧的实现上用例就会为了别的原因通过（变异验证时发现）
   */
  async function pauseWithNothingUnsaved(page: Page): Promise<void> {
    await pauseTime(page)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await wouldPromptOnLeave(page)).toBe(false)
  }

  test('US-M3-02 数据验证面板改了数值、SDK 1 秒的防抖还没到点：离开提示拦下，页头不说已保存到云端（期间到来的旧的保存确认也不说）；到点之后照常自动保存，服务器上是改过的', async ({ page }) => {
    const { documentId, value } = await openSavedRule(page, 'panel-dv-unsaved')
    await pauseWithNothingUnsaved(page)
    // 一次保存在途（拦着）：它确认的是改数值之前的那一份
    const held = await holdSaves(page)
    await saveButton(page).click()
    await expect.poll(held.held).toBe(1)
    await value.fill('250')
    await expect(value).toHaveValue('250')
    expect(await wouldPromptOnLeave(page)).toBe(true)
    await expect(saveStatus(page)).not.toHaveText('已保存到云端')
    // 旧的保存确认在防抖期间到来：仍是有未保存的修改、离开提示拦下；服务器上确实还是 100
    held.release()
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    expect(await wouldPromptOnLeave(page)).toBe(true)
    expect(await storedRuleValue(page, documentId)).toBe('100')
    // 防抖到点：SDK 把 250 写进规则（一处修改），存上之前照旧有未保存的修改
    await skipAhead(page, 1_100)
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    expect(await wouldPromptOnLeave(page)).toBe(true)
    // 自动保存照常：停 1 秒捕获、2 秒上传，之后回到已保存到云端、离开不提示
    await page.clock.resume()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await wouldPromptOnLeave(page)).toBe(false)
    expect(await storedRuleValue(page, documentId)).toBe('250')
  })

  test('US-M3-02 数据验证面板改了数值、防抖还没到点时真实地离开（点页头的"我的空间"）：浏览器弹出离开的提示；选留下，到点之后照常自动保存，存上之后再离开不提示', async ({ page }) => {
    const { documentId, value } = await openSavedRule(page, 'panel-dv-leave')
    await pauseWithNothingUnsaved(page)
    await value.fill('250')
    await expect(value).toHaveValue('250')
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss()
    })
    await backLink(page).click()
    await expect.poll(() => dialogs).toEqual(['beforeunload'])
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`))
    await expect(value).toHaveValue('250')
    await page.clock.resume()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await storedRuleValue(page, documentId)).toBe('250')
    await backLink(page).click()
    await expect(page).toHaveURL(/\/$/)
    expect(dialogs).toEqual(['beforeunload'])
  })

  test('US-M3-02 批注浮层里键入、SDK 300 ms 的防抖还没到点：离开提示拦下，页头不说已保存到云端；到点之后照常自动保存，服务器上有这次键入的文字', async ({ page }) => {
    await page.clock.install()
    const documentId = await openNewSheet(page, 'panel-note-unsaved')
    const writes = recordWrites(page, documentId)
    await selectCell(page, 'D4', { button: 'right' })
    await page.getByRole('button', { name: '添加批注' }).click()
    await page.getByRole('textbox', { name: '在此输入' }).click()
    // 打开浮层时 SDK 按同一个 300 ms 的防抖写进一条空批注：等自动保存把它存上，键入之前都已存上
    await expect.poll(() => writes.saves.length).toBeGreaterThanOrEqual(1)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    await pauseWithNothingUnsaved(page)
    await page.keyboard.type('remember')
    expect(await wouldPromptOnLeave(page)).toBe(true)
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await page.clock.resume()
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await wouldPromptOnLeave(page)).toBe(false)
    const { snapshot } = await savedContent(page, documentId)
    expect(resourceOf(snapshot, 'SHEET_NOTE_PLUGIN')).toMatchObject({ [FIRST_SHEET]: { 3: { 3: { note: 'remember', row: 3, col: 3 } } } })
  })

  test('US-M3-02 数据验证面板里只是点了一下（没有改动）：防抖期间同样先说有未保存的修改、离开提示拦下；到点之后回到已保存到云端，不发保存', async ({ page }) => {
    const { documentId, value } = await openSavedRule(page, 'panel-dv-noop')
    const writes = recordWrites(page, documentId)
    await pauseWithNothingUnsaved(page)
    await value.click()
    expect(await wouldPromptOnLeave(page)).toBe(true)
    await expect(saveStatus(page)).toHaveText('有未保存的修改')
    await skipAhead(page, 1_100)
    await expect(saveStatus(page)).toHaveText('已保存到云端')
    expect(await wouldPromptOnLeave(page)).toBe(false)
    await skipAhead(page, 5_000)
    expect(writes.saves).toHaveLength(0)
    expect(await storedRuleValue(page, documentId)).toBe('100')
  })
})

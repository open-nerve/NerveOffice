// 测试构建的交接日志（M3-P5 设计 §3.13 的观察钩子）：编辑器页把交接的各步报给挂在 window 上的日志（apps/web/src/editor/testing/handover-log.ts），
// 真实 Safari 的复核（§3.14）读两个标签页各自的日志：有没有回应、多久进入编辑、旧标签页什么时候得知。这里在 Playwright 的三个浏览器上校准它：
// 同一个浏览器里 B 点"在此编辑"，A 回应、先保存再交出，B 进入编辑——两边的日志按先后记下了各步，墙上时间跨标签页对得上先后。
// 日志只在测试构建里：标签 @test-build（生产镜像里没有它，门禁 artifacts 核对）
import type { Page } from '@playwright/test'
import type { HandoverLog, HandoverLogEntry } from '../../../../apps/web/src/editor/testing/handover-log.ts'
import { HANDOVER_LOG_GLOBAL } from '../../../../apps/web/src/editor/testing/handover-log.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, openReader, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

// 打开编辑器的用例：整份 spec 放宽时限（support/sheet.ts 里有实测数字与理由）
test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

/** 这一页的交接日志（拷贝） */
async function logOf(page: Page): Promise<HandoverLogEntry[]> {
  return page.evaluate(name => (window as unknown as Record<string, HandoverLog | undefined>)[name]?.log() ?? [], HANDOVER_LOG_GLOBAL)
}

/** 日志里第一条这一种的 */
function first(log: readonly HandoverLogEntry[], kind: string): HandoverLogEntry {
  const entry = log.find(item => item.kind === kind)
  if (entry === undefined)
    throw new Error(`日志里没有 ${kind}：${log.map(item => item.kind).join('、')}`)
  return entry
}

test.describe('US-M3-08 测试构建的交接日志（观察钩子）', { tag: '@test-build' }, () => {
  test('US-M3-08 同一个浏览器里"在此编辑"：B 记下开始、锁在本浏览器、发出请求、收到 ack（或锁空了）、申请（普通申请）与结果、进入编辑；A 记下回应 ack、开始离开（交给标签页）、告诉它做完了、回到阅读；跨标签页按墙上时间 A 的回应不早于 B 的请求、B 的申请不早于 A 的回应', async ({ page, context }) => {
    await loginThroughApi(page, await createUser('trace-tabs'))
    const documentId = await createSheetThroughApi(page)
    await openAndEnterEditing(page, documentId)
    await typeInCell(page, 'A1', 'from the first tab')
    const other = await context.newPage()
    await openReader(other, documentId)
    await takeOverHereButton(other).click()
    await waitForEditorAccess(other, 'edit')
    await waitForEditorAccess(page, 'read')

    const a = await logOf(page)
    const b = await logOf(other)
    // A：打开、进入编辑的那几条在前；之后是交接
    expect(a.slice(0, 3).map(entry => [entry.kind, entry.trigger ?? null])).toEqual([['acquire', 'enter'], ['acquire-result', null], ['entered', null]])
    expect(a.slice(3).map(entry => entry.kind)).toEqual(['handover-answer', 'leave', 'handover-finish', 'left'])
    expect(first(a, 'handover-answer')).toMatchObject({ answer: 'ack', state: 'editing' })
    expect(first(a, 'leave')).toMatchObject({ cause: 'handover-tab' })
    expect(first(a, 'handover-finish')).toMatchObject({ outcome: 'done', reason: null })
    expect(first(a, 'left')).toMatchObject({ cause: 'handover-tab', outcome: 'reading' })
    // B：开始、锁在本浏览器、请求，之后收到回应或者锁空了，最后申请（"在此编辑"：那边做完了，普通申请）、结果、进入编辑
    const kinds = b.map(entry => entry.kind)
    expect(kinds.slice(0, 3)).toEqual(['takeover-start', 'takeover-locate', 'handover-request'])
    expect(kinds.slice(-3)).toEqual(['acquire', 'acquire-result', 'entered'])
    expect(first(b, 'takeover-locate')).toMatchObject({ here: true })
    expect(first(b, 'acquire')).toMatchObject({ trigger: 'take-over', takeover: null })
    expect(first(b, 'acquire-result')).toMatchObject({ result: 'acquired', interruption: false })
    // 回应与锁空了谁先到不定（A 存上、放锁很快时 B 先看到锁空了、不再收回应）：至少有一样；收到的回应都是这一次请求的 ack 或 done
    expect(kinds.some(kind => kind === 'handover-reply' || kind === 'handover-lock-free')).toBe(true)
    for (const entry of b.filter(item => item.kind === 'handover-reply'))
      expect([entry.requestId, ['ack', 'done'].includes(String(entry.reply))]).toEqual([first(b, 'handover-request').requestId, true])
    // 每一页里按单调的时钟不倒退；跨标签页按墙上时间对得上先后
    for (const log of [a, b]) {
      for (let index = 1; index < log.length; index += 1)
        expect((log[index]?.at ?? 0) >= (log[index - 1]?.at ?? 0)).toBe(true)
    }
    expect(first(a, 'handover-answer').wall).toBeGreaterThanOrEqual(first(b, 'handover-request').wall)
    expect(first(b, 'acquire').wall).toBeGreaterThanOrEqual(first(a, 'handover-answer').wall)
  })
})

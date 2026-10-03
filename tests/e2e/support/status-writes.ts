// 读屏用的状态区（role="status"）写进说明的那一刻（M2-P5 复验 S1）：确认框（Radix 的模态对话框）开着时，它之外的内容都被标为
// aria-hidden（只跳过打开那一刻已经在的、显式写了 aria-live 的元素，状态区不在此列）；在确认框里写进状态区的说明，写进去的那一刻在 aria-hidden 之下，读屏多半不播报，确认框关掉之后文字不再变化，也不会补播。
// 共用的确认框（apps/web 的 features/confirmation）等自己关掉、焦点交还之后才写；这里在真实浏览器里核对：
// 页面里用 MutationObserver 记下状态区每一次内容变化时的样子——文字；它或祖先是不是带 aria-hidden="true"、inert、hidden；
// 焦点是不是已经交还。DOM 一变就在随后的微任务里记下，那时的样子就是写进去那一刻的样子。记录放在页面的 window 上：整页跳转之后就没有了。
// 单元测试里的同一项核对在 apps/web 的 shared/testing/announcement.test-support.ts。
import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

/** 状态区的一次内容变化 */
export interface StatusWrite {
  /** 变化之后状态区的全部文字 */
  readonly text: string
  /** 写进去的那一刻状态区不在无障碍树里：它或祖先带 aria-hidden="true"、inert 或 hidden */
  readonly hidden: boolean
  /**
   * 写进去的那一刻焦点已经交还：不在 body 上，也不在别的对话框里（例如还开着的确认框；状态区自己就在对话框里时，焦点在同一个对话框里算）。
   * 只看 hidden 分不出"与确认框关掉在同一次渲染里写进去"：那时 Radix 的撤销可能已经执行，确认框连同有焦点的按钮却刚被移走，
   * 焦点在 body 上，交还焦点还在后面
   */
  readonly focusReturned: boolean
}

const STORE = '__nerveStatusWrites'

/**
 * 开始记下这些状态区的内容变化（regions 匹配到的每一个；至少要有一个）。要在写进说明之前调用：
 * 状态区在说明写进去之前就要在（一直在无障碍树里，M2-P5 审查 B 的 M1），与说明一起插入的状态区记不到
 */
export async function recordStatusWrites(regions: Locator): Promise<void> {
  const count = await regions.evaluateAll((elements, store) => {
    const page = window as unknown as Record<string, StatusWrite[] | undefined>
    const writes = page[store] ?? []
    page[store] = writes
    for (const element of elements) {
      new MutationObserver(() => {
        const active = document.activeElement
        const dialog = active?.closest('[role="dialog"], [role="alertdialog"]') ?? null
        writes.push({
          text: element.textContent,
          hidden: element.closest('[aria-hidden="true"], [inert], [hidden]') !== null,
          focusReturned: active !== null && active !== document.body && (dialog === null || dialog.contains(element)),
        })
      }).observe(element, { childList: true, subtree: true, characterData: true })
    }
    return elements.length
  }, STORE)
  expect(count, '没有找到要记下的状态区').toBeGreaterThan(0)
}

/** 记下的、变化之后文字恰好是 text 的那几次（从 recordStatusWrites 起） */
export async function statusWrites(page: Page, text: string): Promise<StatusWrite[]> {
  const writes = await page.evaluate(store => (window as unknown as Record<string, StatusWrite[] | undefined>)[store] ?? [], STORE)
  return writes.filter(write => write.text === text)
}

/**
 * 这句说明是在确认框关掉之后才写进状态区的：至少写过一次，每一次写进去的那一刻状态区都在无障碍树里（不在 aria-hidden、inert、hidden 之下）、
 * 焦点都已经交还——读屏这时才会播报。在说明已经出现之后调用（例如 toHaveText 之后）
 */
export async function expectWrittenAfterClose(page: Page, text: string): Promise<void> {
  const writes = await statusWrites(page, text)
  expect(writes, `"${text}"没有写进记下的状态区（状态区要在说明写进去之前就在）`).not.toHaveLength(0)
  expect(writes.filter(write => write.hidden), `"${text}"写进状态区的那一刻状态区在 aria-hidden 之下（确认框还开着）：读屏多半不播报`).toEqual([])
  expect(writes.filter(write => !write.focusReturned), `"${text}"写进状态区的那一刻焦点还没有交还（与确认框关掉同时写的）`).toEqual([])
}

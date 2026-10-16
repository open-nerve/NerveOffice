import type { Page } from '@playwright/test'

/** 一次组合输入：update 是组字中的文字，commit 选定并结束 */
interface Composition {
  readonly update: (text: string) => Promise<void>
  readonly commit: (text: string) => Promise<void>
}

/**
 * 在获得焦点的输入框里开始组字（M3-P4 设计 §3.6）：Chromium 内核（chromium、chrome、msedge）经 CDP 的 Input.imeSetComposition 驱动
 * 浏览器自己的组合输入（M0-P5 的做法），选定用 Input.insertText；WebKit 没有这个协议，派发合成的 compositionstart、compositionupdate、
 * compositionend，组字中的文字经 textarea 原型上的 value 写进去并派发 input（与页面自检的 composition 场景相同，React 才认得出值变了）。
 * 真实的输入法在自动化里驱动不了，登记为人工核对的盲区
 */
export async function startComposition(page: Page, browserName: string): Promise<Composition> {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    return {
      update: async (text) => {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
      },
      commit: async (text) => {
        await cdp.send('Input.insertText', { text })
      },
    }
  }
  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }))
  })
  const type = async (text: string, phase: 'update' | 'end'): Promise<void> => page.evaluate(({ text, phase }) => {
    const input = document.activeElement
    if (!(input instanceof HTMLTextAreaElement))
      throw new Error('焦点不在批注的输入框上')
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: text }))
    Reflect.set(HTMLTextAreaElement.prototype, 'value', text, input)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: true, inputType: 'insertCompositionText', data: text }))
    if (phase === 'end')
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: text }))
  }, { text, phase })
  return {
    update: async text => type(text, 'update'),
    commit: async text => type(text, 'end'),
  }
}

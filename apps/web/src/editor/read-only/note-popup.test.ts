import { afterEach, describe, expect, it } from 'vitest'
import { lockNotePopups } from './note-popup.ts'

/** MutationObserver 的回调在微任务里送达：等一个宏任务 */
async function mutationsDelivered(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function textarea(comp: string): HTMLTextAreaElement {
  const element = document.createElement('textarea')
  element.dataset.uComp = comp
  return element
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('只读时批注浮层的文本框设为只读（SDK 的 DOM 标记 data-u-comp="note-textarea"）', () => {
  it('已经在页面上的，与之后加入的（文本框本身，或者包着它的浮层）都设为只读；文字照常显示', async () => {
    const existing = textarea('note-textarea')
    existing.value = '已有的批注'
    document.body.append(existing)
    const stop = lockNotePopups()
    expect(existing.readOnly).toBe(true)
    expect(existing.value).toBe('已有的批注')

    const direct = textarea('note-textarea')
    const popup = document.createElement('div')
    popup.innerHTML = '<div><textarea data-u-comp="note-textarea"></textarea></div>'
    document.body.append(direct, popup)
    await mutationsDelivered()
    expect(direct.readOnly).toBe(true)
    expect(popup.querySelector('textarea')?.readOnly).toBe(true)
    stop()
  })

  it('别的文本框不动（SDK 自己的 textarea、平台的输入框）', async () => {
    const stop = lockNotePopups()
    const other = textarea('textarea')
    const plain = document.createElement('textarea')
    document.body.append(other, plain)
    await mutationsDelivered()
    expect([other.readOnly, plain.readOnly]).toEqual([false, false])
    stop()
  })

  it('断开之后不再处理；可以重复断开', async () => {
    const stop = lockNotePopups()
    stop()
    stop()
    const later = textarea('note-textarea')
    document.body.append(later)
    await mutationsDelivered()
    expect(later.readOnly).toBe(false)
  })

  it('只观察给定的根：根之外加入的不管', async () => {
    const root = document.createElement('section')
    document.body.append(root)
    const stop = lockNotePopups(root)
    const inside = textarea('note-textarea')
    const outside = textarea('note-textarea')
    root.append(inside)
    document.body.append(outside)
    await mutationsDelivered()
    expect([inside.readOnly, outside.readOnly]).toEqual([true, false])
    stop()
  })
})

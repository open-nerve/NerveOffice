import { afterEach, describe, expect, it } from 'vitest'
import { FIND_ADVANCED_LINK_SELECTOR } from '../internal-api/index.ts'
import { ADVANCED_FIND_STYLE_MARKER, hideAdvancedFind } from './advanced-find.ts'

afterEach(() => {
  document.head.querySelectorAll(`[${ADVANCED_FIND_STYLE_MARKER}]`).forEach(style => style.remove())
  document.body.replaceChildren()
})

/** 照 find-replace 的查找面板造出来：查找框（外层 div 里只有输入框），与放着"替换 / 高级查找"链接的那一块 */
function findDialog(): { readonly search: HTMLElement, readonly advanced: HTMLElement } {
  const root = document.createElement('div')
  root.innerHTML = '<div data-u-comp="find-replace-dialog"><div class="search"><input data-u-comp="search-input"></div><div class="advanced"><a>替换 / 高级查找</a></div></div>'
  document.body.append(root)
  const search = root.querySelector<HTMLElement>('.search')
  const advanced = root.querySelector<HTMLElement>('.advanced')
  if (search === null || advanced === null)
    throw new Error('没有造出查找面板')
  return { search, advanced }
}

describe('只读时查找面板里没有"替换 / 高级查找"（DEF-028）', () => {
  it('标记只认放着链接的那一块，不认查找框', () => {
    const { search, advanced } = findDialog()
    expect(advanced.matches(FIND_ADVANCED_LINK_SELECTOR)).toBe(true)
    expect(search.matches(FIND_ADVANCED_LINK_SELECTOR)).toBe(false)
  })

  it('加上的样式藏起那一块，查找框照常；去掉之后照常显示，可以重复去掉', () => {
    const { search, advanced } = findDialog()
    const restore = hideAdvancedFind()
    expect(getComputedStyle(advanced).display).toBe('none')
    expect(getComputedStyle(search).display).not.toBe('none')
    expect(document.head.querySelectorAll(`[${ADVANCED_FIND_STYLE_MARKER}]`)).toHaveLength(1)
    restore()
    restore()
    expect(getComputedStyle(advanced).display).not.toBe('none')
    expect(document.head.querySelectorAll(`[${ADVANCED_FIND_STYLE_MARKER}]`)).toHaveLength(0)
  })
})

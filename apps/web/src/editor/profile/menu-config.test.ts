import { describe, expect, it } from 'vitest'
import { BEFORE_M5_MENU_ITEMS, HIDDEN_MENU_ITEMS, PROTECTION_MENU_ITEMS, READ_ONLY_MENU_ITEMS, sheetMenuConfig, UNSUPPORTED_MENU_ITEMS } from './menu-config.ts'

const ids = (items: readonly { id: string }[]): string[] => items.map(item => item.id)

describe('两种打开方式都隐藏的菜单项', () => {
  it('保护类与工作表背景图片：插件档案 v1 §5.1 的 13 项', () => {
    expect(ids(PROTECTION_MENU_ITEMS)).toEqual([
      'sheet.command.add-range-protection-from-toolbar',
      'sheet.contextMenu.permission',
      'sheet.command.add-range-protection-from-context-menu',
      'sheet.command.set-range-protection-from-context-menu',
      'sheet.command.delete-range-protection-from-context-menu',
      'sheet.command.view-sheet-permission-from-context-menu',
      'sheet.command.add-range-protection-from-sheet-bar',
      'sheet.command.delete-worksheet-protection-from-sheet-bar',
      'sheet.command.change-sheet-protection-from-sheet-bar',
      'sheet.command.view-sheet-permission-from-sheet-bar',
    ])
    expect(ids(UNSUPPORTED_MENU_ITEMS)).toEqual([
      'sheet.menu.worksheet-background-image',
      'sheet.command.add-worksheet-background-image',
      'sheet.command.delete-worksheet-background-image',
    ])
  })

  it('M5 之前不开放的入口：插入图片的父菜单与两个子项、保存单元格图片、工具栏与右键两种 id 的超链接（P4 设计 §3.6.8）', () => {
    expect(ids(BEFORE_M5_MENU_ITEMS)).toEqual([
      'sheet.menu.image',
      'sheet.command.insert-float-image',
      'sheet.command.insert-cell-image',
      'sheet.command.save-cell-images',
      'sheet.operation.insert-hyper-link-toolbar',
      'sheet.operation.insert-hyper-link',
    ])
  })

  it('每一项写明出处，没有重复', () => {
    expect(HIDDEN_MENU_ITEMS.filter(item => item.source.trim() === '')).toEqual([])
    expect(new Set(ids(HIDDEN_MENU_ITEMS)).size).toBe(HIDDEN_MENU_ITEMS.length)
  })

  it('能编辑时的菜单配置：按 id 把每一项设为隐藏，别的都不动', () => {
    const config = sheetMenuConfig('edit')
    expect(Object.keys(config).sort()).toEqual(ids(HIDDEN_MENU_ITEMS).sort())
    expect(Object.values(config).every(item => JSON.stringify(item) === JSON.stringify({ hidden: true }))).toBe(true)
  })
})

describe('只读时另外隐藏的菜单项（插件档案 v1 §5.2，M2-P3 设计 §3.4）', () => {
  it('工作表标签的 5 项：删除、复制、改名、标签颜色、隐藏', () => {
    expect(ids(READ_ONLY_MENU_ITEMS)).toEqual([
      'sheet.command.remove-sheet-confirm',
      'sheet.command.copy-sheet',
      'sheet.operation.rename-sheet',
      'sheet.command.set-tab-color',
      'sheet.command.set-worksheet-hidden',
    ])
  })

  it('每一项写明出处，与两种方式都隐藏的不重复', () => {
    expect(READ_ONLY_MENU_ITEMS.filter(item => item.source.trim() === '')).toEqual([])
    const all = ids([...HIDDEN_MENU_ITEMS, ...READ_ONLY_MENU_ITEMS])
    expect(new Set(all).size).toBe(all.length)
  })

  it('只读时的菜单配置：两种方式都隐藏的，加上这 5 项，每一项都设为隐藏', () => {
    const config = sheetMenuConfig('read')
    expect(Object.keys(config).sort()).toEqual(ids([...HIDDEN_MENU_ITEMS, ...READ_ONLY_MENU_ITEMS]).sort())
    expect(Object.values(config).every(item => JSON.stringify(item) === JSON.stringify({ hidden: true }))).toBe(true)
  })

  it('能编辑时不隐藏这 5 项', () => {
    const config = sheetMenuConfig('edit')
    expect(ids(READ_ONLY_MENU_ITEMS).filter(id => id in config)).toEqual([])
  })
})

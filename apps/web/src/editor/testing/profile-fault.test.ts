import type { PluginEntry } from '../profile/plugin-entry.ts'
import { describe, expect, it, vi } from 'vitest'
import { SHEET_PLUGIN_GROUPS, sheetPluginEntries } from '../profile/sheet-profile.ts'
import { faultyGroups, PROFILE_FAULT_PARAM, sheetPluginEntriesUnderFault } from './profile-fault.ts'

vi.hoisted(() => {
  // jsdom 没有 Path2D：档案里的界面包在模块求值时就创建它。这里只展开档案，不运行 Univer
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const context = { container: document.createElement('div'), formulaWorker: {} as Worker, access: 'edit' as const }

function names(entries: readonly PluginEntry[]): string[] {
  return entries.map(entry => entry.plugin.pluginName)
}

describe('测试构建的档案故障开关（M3-P4 设计 §3.14）', () => {
  it('没有这个参数：与档案的注册完全相同（插件与顺序）', () => {
    expect(faultyGroups('')).toEqual(new Set())
    expect(faultyGroups('?edit=new')).toEqual(new Set())
    expect(names(sheetPluginEntriesUnderFault('?edit=new')(context))).toEqual(names(sheetPluginEntries(context)))
  })

  it('点名的组不注册，其余照档案的顺序；可以点好几组', () => {
    const without = (ids: readonly string[]): string[] => names(SHEET_PLUGIN_GROUPS.filter(group => !ids.includes(group.id)).flatMap(group => group.plugins(context)))
    expect(names(sheetPluginEntriesUnderFault(`?${PROFILE_FAULT_PARAM}=note`)(context))).toEqual(without(['note']))
    expect(names(sheetPluginEntriesUnderFault(`?edit=new&${PROFILE_FAULT_PARAM}=cf&${PROFILE_FAULT_PARAM}=filter`)(context))).toEqual(without(['cf', 'filter']))
    expect(names(sheetPluginEntriesUnderFault(`?${PROFILE_FAULT_PARAM}=note`)(context))).not.toContain('SHEET_NOTE_PLUGIN')
  })

  it('认不出的组名直接报错（写错了的用例不会悄悄地什么也不缺）', () => {
    expect(() => faultyGroups(`?${PROFILE_FAULT_PARAM}=notes`)).toThrow(/档案没有的插件组：notes/)
    expect(() => sheetPluginEntriesUnderFault(`?${PROFILE_FAULT_PARAM}=`)).toThrow(/档案没有的插件组/)
  })
})

// 测试构建的档案故障开关（M3-P4 设计 §3.14，US-M3-15 的"档案不全"，@test-build）：编辑器页的地址带 profileFault=<组>（可以带几个）时，
// 这几组插件不注册，复现"插件没有完整载入"——打开自检据此报 profile-missing-hook。只在测试构建里：sheet-editor.ts 在 e2e 分支里、
// 注册插件之前动态引入它（任何一次创建都看地址，阅读、编辑与各种重建一致）；生产构建里没有它（门禁 artifacts 按来源认出 editor/testing/）。
// 组名是档案里的（profile/sheet-profile.ts 的 SHEET_PLUGIN_GROUPS）；认不出的组名直接报错，写错了的用例不会悄悄地什么也不缺
import type { PluginEntry } from '../profile/plugin-entry.ts'
import type { SheetProfileContext } from '../profile/sheet-profile.ts'
import { SHEET_PLUGIN_GROUPS } from '../profile/sheet-profile.ts'

/** 地址里的参数名 */
export const PROFILE_FAULT_PARAM = 'profileFault'

/** 地址的查询串里要跳过的插件组；没有这个参数时为空。认不出的组名抛错 */
export function faultyGroups(search: string): ReadonlySet<string> {
  const requested = new URLSearchParams(search).getAll(PROFILE_FAULT_PARAM)
  const known = new Set(SHEET_PLUGIN_GROUPS.map(group => group.id))
  const unknown = requested.filter(id => !known.has(id))
  if (unknown.length > 0)
    throw new Error(`档案故障开关（${PROFILE_FAULT_PARAM}）里有档案没有的插件组：${unknown.join('、')}；档案的组是 ${[...known].join('、')}`)
  return new Set(requested)
}

/** 按档案注册插件，只是跳过地址里点名的组（顺序与档案相同；没有点名时就是 sheetPluginEntries） */
export function sheetPluginEntriesUnderFault(search: string): (context: SheetProfileContext) => PluginEntry[] {
  const skipped = faultyGroups(search)
  return context => SHEET_PLUGIN_GROUPS.filter(group => !skipped.has(group.id)).flatMap(group => group.plugins(context))
}

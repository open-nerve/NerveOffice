// SDK 挂上了哪些右键菜单（只在测试构建里用：E2E 的探针与页面自检，M5-P8 托管 Mac 第 5 轮之后）。
// @univerjs/ui 的 AnchoredContextMenu 挂上之后在 effect 里向 IContextMenuHostService 登记自己的 hostId、卸下时注销。单元格的右键菜单
// 是 Workbench 渲染的 DesktopContextMenu（hostId 'desktop-context-menu'，只在界面插件的 contextMenu 为真时渲染），工作表标签的是
// sheets-ui 的 SheetBarTabsContextMenu（hostId 'sheetbar-tabs-context-menu-' 加 6 位随机后缀，同样看界面插件的 contextMenu）。
// 1.0.1 构建里的行号见 registry.ts 的登记。只读档案给 contextMenu: false（profile/sheet-profile.ts），两个都不挂，右键就不会弹出菜单。
// 宿主服务没有公开登记的清单，这里读它的私有字段 _menuMap；字段不在或不是 Map 时抛错，不当作"没有菜单"放行
import type { Univer } from '@univerjs/core'
import { IContextMenuHostService } from '@univerjs/ui'
import { injectorOf } from './injector.ts'

/** 这个实例的 SDK 现在挂着的右键菜单：在右键菜单宿主服务里登记的 hostId */
export function contextMenuHosts(univer: Univer): readonly string[] {
  const service: object = injectorOf(univer).get(IContextMenuHostService)
  if (!('_menuMap' in service) || !(service._menuMap instanceof Map))
    throw new Error('SDK 的 ContextMenuHostService 没有 _menuMap：升级改了右键菜单的登记方式，回头核对 internal-api 的登记')
  return [...service._menuMap.keys()].map(String)
}

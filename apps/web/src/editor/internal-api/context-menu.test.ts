// SDK 挂上了哪些右键菜单（context-menu.ts）：用真实的 ContextMenuHostService 核对私有字段的读法（升级 SDK 时先跑）——没有登记时为空、
// 菜单登记之后列出它的 hostId、注销之后不再列出；服务没有这个字段时抛错，不当作"没有菜单"放行
import type { IContextMenuHostService as ContextMenuHost } from '@univerjs/ui'
import { Univer } from '@univerjs/core'
import { ContextMenuHostService, IContextMenuHostService } from '@univerjs/ui'
import { EMPTY } from 'rxjs'
import { afterEach, describe, expect, it } from 'vitest'
import { contextMenuHosts } from './context-menu.ts'
import { injectorOf } from './injector.ts'

const created: Univer[] = []

function univerWith(service: ContextMenuHost | undefined): Univer {
  const univer = new Univer()
  created.push(univer)
  injectorOf(univer).add(service === undefined ? [IContextMenuHostService, { useClass: ContextMenuHostService }] : [IContextMenuHostService, { useValue: service }])
  return univer
}

afterEach(() => {
  for (const univer of created.splice(0))
    univer.dispose()
})

describe('contextMenuHosts：SDK 挂上了哪些右键菜单', () => {
  it('没有菜单时为空；菜单挂上时列出它的 hostId，卸下之后不再列出', () => {
    const univer = univerWith(undefined)
    const host = injectorOf(univer).get(IContextMenuHostService)
    expect(contextMenuHosts(univer)).toEqual([])
    const cell = host.registerMenu('desktop-context-menu', () => {})
    const tab = host.registerMenu('sheetbar-tabs-context-menu-a1b2c3', () => {})
    expect(contextMenuHosts(univer)).toEqual(['desktop-context-menu', 'sheetbar-tabs-context-menu-a1b2c3'])
    cell.dispose()
    expect(contextMenuHosts(univer)).toEqual(['sheetbar-tabs-context-menu-a1b2c3'])
    tab.dispose()
    expect(contextMenuHosts(univer)).toEqual([])
  })

  it('服务没有 _menuMap 时抛错（SDK 升级改了登记方式），不当作没有菜单', () => {
    const lacking: ContextMenuHost = {
      activeMenuId: null,
      activeMenuId$: EMPTY,
      registerMenu: () => ({ dispose: () => {} }),
      activateMenu: () => {},
      deactivateMenu: () => {},
      hideActiveMenu: () => {},
    }
    expect(() => contextMenuHosts(univerWith(lacking))).toThrow(/_menuMap/)
  })
})

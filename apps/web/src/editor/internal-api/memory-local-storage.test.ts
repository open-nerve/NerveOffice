import type { EditorAccess } from '../editor-access.ts'
import { ILocalStorageService, Univer } from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sheetPluginEntries } from '../profile/sheet-profile.ts'
import { injectorOf } from './injector.ts'

vi.hoisted(() => {
  globalThis.Path2D ??= class {} as unknown as typeof Path2D
})

const instances: Univer[] = []
afterEach(() => {
  for (const univer of instances.splice(0))
    univer.dispose()
  localStorage.clear()
})

/** 真正注册当前档案的 Render/UI 插件，捕获把 override 错放在核心配置而悄悄无效的回归。 */
function storage(access: EditorAccess = 'edit') {
  const univer = new Univer()
  instances.push(univer)
  const entries = sheetPluginEntries({ container: document.createElement('div'), formula: { kind: 'main-thread' }, access })
  for (const entry of entries.filter(entry => ['UNIVER_RENDER_ENGINE_PLUGIN', 'UNIVER_UI_PLUGIN'].includes(entry.plugin.pluginName)))
    entry.register(univer)
  return { univer, service: injectorOf(univer).get(ILocalStorageService) }
}

describe('SDK 本机偏好仅在本编辑器实例内存在', () => {
  it.each(['read', 'edit'] as const)('%s 的真实 UI 注入不向 localStorage 写入，不继承另一个实例', async (access) => {
    const first = storage(access)
    const second = storage(access)
    expect(await first.service.setItem('recent', ['0.00'])).toEqual(['0.00'])
    expect(await first.service.getItem('recent')).toEqual(['0.00'])
    expect(await second.service.getItem('recent')).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('销毁释放内容；旧回调继续调用服务不能复活数据或影响新实例', async () => {
    const first = storage()
    await first.service.setItem('recent', ['0.00'])
    first.univer.dispose()
    instances.splice(instances.indexOf(first.univer), 1)
    expect(await first.service.getItem('recent')).toBeNull()
    expect(await first.service.setItem('late', ['%'])).toEqual(['%'])
    expect(await first.service.keys()).toEqual([])
    expect(await first.service.key(0)).toBeNull()
    expect(await first.service.iterate(() => 'unexpected')).toBeUndefined()
    await first.service.removeItem('late')
    await first.service.clear()
    expect(await storage().service.getItem('late')).toBeNull()
  })

  it('读写隔离可变对象，setItem 的返回对象也不能反向改变内容', async () => {
    const { service } = storage()
    const value = { formats: ['0.00'] }
    const returned = await service.setItem('format', value)
    value.formats.push('0%')
    returned.formats.push('0.000')
    const read = await service.getItem<typeof value>('format')
    expect(read).toEqual({ formats: ['0.00'] })
    read?.formats.push('0.0')
    expect(await service.getItem('format')).toEqual({ formats: ['0.00'] })
  })

  it('替换/移除/clear、键索引与 iterate 从 1 开始并在非 undefined 结果停止', async () => {
    const { service } = storage()
    expect(await service.getItem('missing')).toBeNull()
    expect(await service.key(-1)).toBeNull()
    await service.setItem('b', { n: 1 })
    await service.setItem('a', { n: 2 })
    await service.setItem('b', { n: 3 })
    expect(await service.keys()).toEqual(['b', 'a'])
    expect(await service.key(1)).toBe('a')
    expect(await service.key(2)).toBeNull()
    const seen: unknown[] = []
    expect(await service.iterate<{ n: number }, undefined>((value, key, index) => {
      seen.push([key, value.n, index])
      value.n = 99
      return undefined
    })).toBeUndefined()
    expect(seen).toEqual([['b', 3, 1], ['a', 2, 2]])
    expect(await service.getItem('b')).toEqual({ n: 3 })
    const stopped: string[] = []
    expect(await service.iterate((_, key) => {
      stopped.push(key)
      return false
    })).toBe(false)
    expect(stopped).toEqual(['b'])
    await service.removeItem('b')
    await service.removeItem('missing')
    expect(await service.keys()).toEqual(['a'])
    await service.clear()
    expect(await service.keys()).toEqual([])
  })
})

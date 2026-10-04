import type { IRenderManagerService } from '../internal-api/ui.ts'
import { createInterceptorKey, InterceptorManager } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { HeaderResizeRenderController } from '../internal-api/ui.ts'
import { lockHeaderResize } from './header-resize.ts'

/** 与 sheets-ui 的行列调整控制器同样的拦截点（header-resize.render-controller.ts 的 HEADER_RESIZE_PERMISSION_CHECK） */
const HEADER_RESIZE_PERMISSION_CHECK = createInterceptorKey<boolean, { row?: number, col?: number }>('headerResizePermissionCheck')

type Manager = InterceptorManager<{ HEADER_RESIZE_PERMISSION_CHECK: typeof HEADER_RESIZE_PERMISSION_CHECK }>

/** 控制器问的"这条分隔线能不能调整"：SDK 的调用方式是 fetchThroughInterceptors(…)(null, { row })，结果为假就不显示控制点 */
function canResize(interceptor: Manager, context: { row?: number, col?: number }): unknown {
  return interceptor.fetchThroughInterceptors(HEADER_RESIZE_PERMISSION_CHECK)(null, context)
}

/**
 * 假的渲染管理：只有 unitId 这份文档有渲染单元，渲染单元里只取得到行列调整的控制器。控制器上先装上与 SDK 同样写法的拦截器
 * （sheet-permission-interceptor-canvas-render.controller.ts 的 _initHeaderResizePermissionInterceptor：没有优先级，
 * 只在 row、col 为真值时看权限点——只读时权限点不允许——所以第 1 行、A 列（索引 0）一律放行）
 */
function fakeRenderManager(unitId: string) {
  const interceptor: Manager = new InterceptorManager({ HEADER_RESIZE_PERMISSION_CHECK })
  // SDK 的 if (rangeParams.row)：数字按真值判断，0（以及 undefined、NaN）都当作没有给出
  const given = (index: number | undefined): boolean => index !== undefined && index !== 0 && !Number.isNaN(index)
  interceptor.intercept(HEADER_RESIZE_PERMISSION_CHECK, {
    handler: (_value, { row, col }) => {
      if (given(row))
        return false
      if (given(col))
        return false
      return true
    },
  })
  const withDependency = vi.fn((dependency: unknown) => {
    if (dependency !== HeaderResizeRenderController)
      throw new Error('只取行列调整的控制器')
    return { interceptor }
  })
  const renderManager = {
    getRenderUnitById: (id: string) => id === unitId ? { with: withDependency } : null,
  } as unknown as Pick<IRenderManagerService, 'getRenderUnitById'>
  return { renderManager, interceptor, withDependency }
}

describe('只读时第 1 行、A 列的分隔线拖不动（DEF-027：SDK 把索引 0 当作没有给出，一律放行）', () => {
  it('复现 SDK 的写法：只读时第 1 行、A 列放行，别的行列不放行；装上之后一律不放行（排在 SDK 的拦截器之前）；撤掉之后照旧，可以重复撤掉', () => {
    const { renderManager, interceptor, withDependency } = fakeRenderManager('unit-1')
    expect([canResize(interceptor, { row: 0 }), canResize(interceptor, { col: 0 }), canResize(interceptor, { row: 4 }), canResize(interceptor, { col: 3 })]).toEqual([true, true, false, false])
    const unlock = lockHeaderResize(renderManager, 'unit-1')
    expect(withDependency).toHaveBeenCalledExactlyOnceWith(HeaderResizeRenderController)
    expect([canResize(interceptor, { row: 0 }), canResize(interceptor, { col: 0 }), canResize(interceptor, { row: 4 }), canResize(interceptor, { col: 3 })]).toEqual([false, false, false, false])
    unlock()
    unlock()
    expect([canResize(interceptor, { row: 0 }), canResize(interceptor, { col: 0 })]).toEqual([true, true])
  })

  it('这份文档还没有渲染：报错（要在渲染完成之后装上）', () => {
    const { renderManager } = fakeRenderManager('unit-1')
    expect(() => lockHeaderResize(renderManager, 'unit-2')).toThrow('unit-2')
  })
})

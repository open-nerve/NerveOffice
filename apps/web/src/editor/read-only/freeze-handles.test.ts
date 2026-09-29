import type { IRenderManagerService } from '../internal-api/ui.ts'
import { createInterceptorKey, InterceptorManager } from '@univerjs/core'
import { describe, expect, it, vi } from 'vitest'
import { HeaderFreezeRenderController } from '../internal-api/ui.ts'
import { lockFreezeHandles } from './freeze-handles.ts'

/** 与 sheets-ui 的冻结线控制器同样的拦截点（freeze.render-controller.ts 的 FREEZE_PERMISSION_CHECK） */
const FREEZE_PERMISSION_CHECK = createInterceptorKey<boolean, null>('freezePermissionCheck')

/** 冻结线的控制器问的"能不能拖"：没有拦截器时是 true（SDK 的调用方式：fetchThroughInterceptors(…)(true, null)） */
function canDrag(interceptor: InterceptorManager<{ FREEZE_PERMISSION_CHECK: typeof FREEZE_PERMISSION_CHECK }>): unknown {
  return interceptor.fetchThroughInterceptors(FREEZE_PERMISSION_CHECK)(true, null)
}

/** 假的渲染管理：只有 unitId 这份文档有渲染单元，渲染单元里只取得到冻结线的控制器 */
function fakeRenderManager(unitId: string) {
  const interceptor = new InterceptorManager({ FREEZE_PERMISSION_CHECK })
  const withDependency = vi.fn((dependency: unknown) => {
    if (dependency !== HeaderFreezeRenderController)
      throw new Error('只取冻结线的控制器')
    return { interceptor }
  })
  const renderManager = {
    getRenderUnitById: (id: string) => id === unitId ? { with: withDependency } : null,
  } as unknown as Pick<IRenderManagerService, 'getRenderUnitById'>
  return { renderManager, interceptor, withDependency }
}

describe('只读时冻结线拖不动（P3 审查 B2：SDK 没有注册冻结线的权限拦截）', () => {
  it('在这份文档的冻结线控制器上拦下：移上、按下与拖动时问到的都是不允许；撤掉之后照常，可以重复撤掉', () => {
    const { renderManager, interceptor, withDependency } = fakeRenderManager('unit-1')
    expect(canDrag(interceptor)).toBe(true)
    const unlock = lockFreezeHandles(renderManager, 'unit-1')
    expect(withDependency).toHaveBeenCalledExactlyOnceWith(HeaderFreezeRenderController)
    expect(canDrag(interceptor)).toBe(false)
    unlock()
    unlock()
    expect(canDrag(interceptor)).toBe(true)
  })

  it('这份文档还没有渲染：报错（要在渲染完成之后装上）', () => {
    const { renderManager } = fakeRenderManager('unit-1')
    expect(() => lockFreezeHandles(renderManager, 'unit-2')).toThrow('unit-2')
  })
})

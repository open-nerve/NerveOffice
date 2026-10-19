import process from 'node:process'
import { LifecycleService, LifecycleStages, Univer } from '@univerjs/core'
import { registerSheetsDrawingFloatingHostCapability, SheetCanvasFloatDomManagerService } from '@univerjs/sheets-drawing-ui'
import { describe, expect, it, vi } from 'vitest'
import { injectorOf } from './injector.ts'

function setup(create: () => object = () => ({})) {
  const univer = new Univer()
  const injector = injectorOf(univer)
  // 宿主的实例化是被观察的边界，不创建画布；注册与 LifecycleService 都使用真实 SDK。
  injector.add([SheetCanvasFloatDomManagerService, { useFactory: create }])
  return { univer, injector, lifecycle: injector.get(LifecycleService) }
}
const drain = async () => new Promise(resolve => setTimeout(resolve, 0))

describe('UR-031：图片宿主的 Ready 等待', () => {
  it('Ready 前销毁时取消等待，没有 drawing 未处理拒绝', async () => {
    const h = setup()
    const rejected: unknown[] = []
    const onRejected = (error: unknown) => rejected.push(error)
    process.on('unhandledRejection', onRejected)
    try {
      registerSheetsDrawingFloatingHostCapability(h.injector)
      h.univer.dispose()
      await drain()
      expect(rejected).toEqual([])
    }
    finally {
      process.off('unhandledRejection', onRejected)
    }
  })

  it.each([false, true])('正常 Ready 照常初始化宿主（注册前已就绪：%s）', async (alreadyReady) => {
    const create = vi.fn(() => ({}))
    const h = setup(create)
    try {
      if (alreadyReady)
        h.lifecycle.stage = LifecycleStages.Ready
      registerSheetsDrawingFloatingHostCapability(h.injector)
      h.lifecycle.stage = LifecycleStages.Ready
      await drain()
      expect(create).toHaveBeenCalledOnce()
    }
    finally {
      h.univer.dispose()
    }
  })

  it('其他初始化错误仍明确报告，不冒充正常取消', async () => {
    const failure = new Error('floating host failed')
    const h = setup(() => {
      throw failure
    })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      registerSheetsDrawingFloatingHostCapability(h.injector)
      h.lifecycle.stage = LifecycleStages.Ready
      await drain()
      expect(reported).toHaveBeenCalledWith(failure)
    }
    finally {
      reported.mockRestore()
      h.univer.dispose()
    }
  })
})

import { DataValidationErrorStyle, DataValidationStatus, DataValidationType } from '@univerjs/core'
import { VALIDATE_CELL } from '@univerjs/sheets'
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'

// SDK 导入时创建下拉箭头的 Path2D；本组不绘制。
vi.hoisted(() => vi.stubGlobal('Path2D', class {}))

afterEach(() => vi.restoreAllMocks())

type Handler = (lastResult: Promise<boolean>, context: Record<string, unknown>, next: (value: Promise<boolean>) => Promise<boolean>) => Promise<boolean>
type ControllerClass = new (...args: unknown[]) => { dispose: () => void }

/** 取实际发布包里“拒绝输入”的控制器：经插件自己的登记拿到类，不复制被测代码，也不加测试专用导出 */
function controllerClass(): ControllerClass {
  const dependencies: unknown[][] = []
  const plugin = new UniverSheetsDataValidationUIPlugin({}, { add: (entry: unknown[]) => dependencies.push(entry), get: () => ({}) } as never, { registerCommand() {} } as never, { setConfig() {} } as never)
  plugin.onStarting()
  const found = dependencies.find(([token]) => typeof token === 'function' && token.name === 'DataValidationRejectInputController')
  if (found === undefined)
    throw new Error('发布包应登记拒绝输入的控制器')
  return found[0] as ControllerClass
}

class CancelledLikeSdk extends Error {
  constructor() {
    super('Data validation task is no longer current')
    this.name = 'DataValidationCancelledError'
  }
}

function setup(validatorCell: () => Promise<DataValidationStatus>) {
  let handler: Handler | undefined
  const interceptors = { writeCellInterceptor: { intercept: (point: unknown, interceptor: { handler: Handler }) => {
    expect(point).toBe(VALIDATE_CELL)
    handler = interceptor.handler
    return { dispose() {} }
  } } }
  const rule = { uid: 'r1', type: DataValidationType.CUSTOM, errorStyle: DataValidationErrorStyle.STOP, showErrorMessage: true, ranges: [] }
  const model = { getRuleIdByLocation: () => 'r1', getRuleById: () => rule }
  const registry = { getValidatorItem: () => ({ getRuleFinalError: () => '不合规' }) }
  const dialog = { open: vi.fn(), close: vi.fn() }
  const Controller = controllerClass()
  const controller = new Controller(interceptors, model, registry, dialog, { t: (key: string) => key }, { validatorCell })
  const next = vi.fn(async (value: Promise<boolean>) => value)
  const run = async () => handler!(Promise.resolve(true), { row: 0, col: 0, unitId: 'wb', subUnitId: 's1' }, next)
  return { controller, run, next, dialog }
}

describe('M5R-M-08：拒绝输入的校验被取消时不留下未处理的拒绝', () => {
  it('校验任务因撤销、规则变更或销毁而取消：按无结论处理，这次输入不写入，也不弹提示', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const h = setup(async () => {
        throw new CancelledLikeSdk()
      })
      await expect(h.run()).resolves.toBe(false)
      expect(h.next).toHaveBeenCalledOnce()
      expect(h.dialog.open).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
      h.controller.dispose()
    }
    finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('真实错误照常抛给调用方，不被当成取消吞掉', async () => {
    const failure = new Error('校验本身出错')
    const h = setup(async () => {
      throw failure
    })
    await expect(h.run()).rejects.toBe(failure)
    expect(h.next).not.toHaveBeenCalled()
    h.controller.dispose()
  })

  it('校验通过与不通过的原路径不变', async () => {
    const valid = setup(async () => DataValidationStatus.VALID)
    await expect(valid.run()).resolves.toBe(true)
    expect(valid.dialog.open).not.toHaveBeenCalled()
    const invalid = setup(async () => DataValidationStatus.INVALID)
    await expect(invalid.run()).resolves.toBe(false)
    expect(invalid.dialog.open).toHaveBeenCalledOnce()
    valid.controller.dispose()
    invalid.controller.dispose()
  })
})

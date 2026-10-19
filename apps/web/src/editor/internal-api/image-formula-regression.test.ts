import type { ICommandInfo } from '@univerjs/core'
import type { IUnitImageFormulaDataType } from '@univerjs/engine-formula'
import { ICommandService, IImageIoService, Injector, IURLImageService, ObjectMatrix } from '@univerjs/core'
import { FormulaDataModel, SetImageFormulaDataMutation } from '@univerjs/engine-formula'
import { SheetInterceptorService } from '@univerjs/sheets'
import { ImageFormulaCellInterceptorController } from '@univerjs/sheets-formula'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../async-tools.ts'

const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
const OTHER = '/api/assets/22222222-2222-4222-8222-222222222222'
const cleanup: (() => void)[] = []

function setup(autoLoad = true) {
  let listener: ((command: ICommandInfo) => Promise<void>) | undefined
  const data: IUnitImageFormulaDataType = {}
  const getImage = vi.fn(async (_source: string) => 'blob:https://app.test/resolved')
  const cached = vi.fn<() => HTMLImageElement | undefined>(() => undefined)
  const track = vi.fn()
  const formulas = new Map<number, string>()
  const merge = vi.fn((next: IUnitImageFormulaDataType) => {
    for (const [unit, sheets] of Object.entries(next)) {
      const target = data[unit] ??= {}
      for (const [sheet, cells] of Object.entries(sheets ?? {})) {
        const matrix = target[sheet] ??= new ObjectMatrix()
        cells.forValue((row, column, value) => {
          matrix.setValue(row, column, value)
        })
      }
    }
  })
  const refreshed = vi.fn()
  // 实际发布控制器与依赖注入；替身只提供命令事件、公式结果存储和异步 IO 边界。
  const injector = new Injector([
    [ICommandService, { useValue: { onCommandExecuted: (callback: typeof listener) => {
      listener = callback
      return { dispose: () => {} }
    } } }],
    [SheetInterceptorService, { useValue: { intercept: () => ({ dispose: () => {} }) } }],
    [FormulaDataModel, { useValue: { mergeUnitImageFormulaData: merge, getUnitImageFormulaData: () => data, getFormulaStringByCell: (row: number) => formulas.get(row) ?? null } }],
    [IURLImageService, { useValue: { getImage } }],
    [IImageIoService, { useValue: { getImageSourceCache: cached, addImageSourceCache: track } }],
  ])
  const controller = injector.createInstance(ImageFormulaCellInterceptorController)
  controller.registerRefreshRenderFunction(refreshed)
  cleanup.push(() => {
    controller.dispose()
    injector.dispose()
  })
  const assigned: string[] = []
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, source: string) {
    assigned.push(source)
    this.setAttribute('src', source)
    Object.defineProperties(this, { width: { value: 120, configurable: true }, height: { value: 80, configurable: true }, naturalWidth: { value: 120, configurable: true }, naturalHeight: { value: 80, configurable: true }, complete: { value: true, configurable: true } })
    if (autoLoad)
      queueMicrotask(() => this.dispatchEvent(new Event('load')))
  })
  return {
    controller,
    getImage,
    cached,
    track,
    merge,
    refreshed,
    assigned,
    setFormula: (formula: string) => formulas.set(0, formula),
    value: () => data.book?.sheet?.getValue(0, 0),
    run: async (source = SOURCE, extra?: string) => {
      if (!listener)
        throw new Error('实际控制器没有注册公式结果监听')
      formulas.set(0, `=IMAGE(${JSON.stringify(source)})`)
      const imageFormulaData = [{ unitId: 'book', sheetId: 'sheet', row: 0, column: 0, source }]
      if (extra !== undefined) {
        formulas.set(1, `=IMAGE(${JSON.stringify(extra)})`)
        imageFormulaData.push({ unitId: 'book', sheetId: 'sheet', row: 1, column: 0, source: extra })
      }
      await listener({ id: SetImageFormulaDataMutation.id, params: { imageFormulaData } })
    },
  }
}

afterEach(() => {
  cleanup.splice(0).forEach(finish => finish())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('IMAGE 公式量尺寸也归当前图片实例所有', () => {
  it('普通失败的占位尺寸不沿用到恢复原图；只有有效解码才触发重新量尺寸', async () => {
    const h = setup()
    h.getImage.mockResolvedValueOnce('https://app.test/placeholder.svg')
    await h.run()
    expect(h.value()).toMatchObject({ imageNaturalWidth: 120, imageNaturalHeight: 80 })
    const waiting = h.track.mock.calls.at(-1)?.[2] as HTMLImageElement
    waiting.dispatchEvent(new Event('load'))
    await Promise.resolve()
    expect(h.getImage).toHaveBeenCalledTimes(1)
    const loaded = document.createElement('img')
    loaded.src = 'blob:https://app.test/resolved'
    Object.defineProperties(loaded, { naturalWidth: { value: 32, configurable: true }, naturalHeight: { value: 48, configurable: true } })
    h.cached.mockReturnValue(loaded)
    waiting.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(h.value()).toMatchObject({ imageNaturalWidth: 32, imageNaturalHeight: 48 }))
    expect(h.getImage).toHaveBeenCalledTimes(2)
    expect(h.refreshed).toHaveBeenCalledTimes(2)
  })

  it.each(['edit', 'dispose'] as const)('普通失败后等待恢复期间发生 %s，晚 load 不重新写回', async (action) => {
    const h = setup()
    h.getImage.mockResolvedValueOnce('https://app.test/placeholder.svg')
    await h.run()
    const waiting = h.track.mock.calls.at(-1)?.[2] as HTMLImageElement
    const loaded = document.createElement('img')
    loaded.src = 'blob:https://app.test/resolved'
    h.cached.mockReturnValue(loaded)
    if (action === 'edit')
      h.setFormula('=SUM(1,2)')
    else
      h.controller.dispose()
    waiting.dispatchEvent(new Event('load'))
    await Promise.resolve()
    expect(h.getImage).toHaveBeenCalledTimes(1)
    expect(h.merge).toHaveBeenCalledTimes(1)
  })

  it('占位测量刚结束时真实缓存已经到达，最终提交采用真实原件尺寸', async () => {
    const h = setup()
    const loaded = document.createElement('img')
    loaded.src = 'blob:https://app.test/resolved'
    Object.defineProperties(loaded, { naturalWidth: { value: 32, configurable: true }, naturalHeight: { value: 48, configurable: true } })
    h.getImage.mockResolvedValueOnce('https://app.test/placeholder.svg')
    h.cached.mockReturnValueOnce(undefined).mockReturnValue(loaded)
    await h.run()
    expect(h.value()).toMatchObject({ imageNaturalWidth: 32, imageNaturalHeight: 48 })
    expect(h.getImage).toHaveBeenCalledOnce()
  })

  it('服务已返回但登记元素时本代撤回，后续有效解码仍能恢复量尺寸', async () => {
    const h = setup(false)
    h.track.mockImplementationOnce((_source, _type, image: HTMLImageElement) => {
      image.src = 'https://app.test/placeholder.svg'
    })
    await h.run()
    expect(h.merge).not.toHaveBeenCalled()
    const waiting = h.track.mock.calls.at(-1)?.[2] as HTMLImageElement
    const loaded = document.createElement('img')
    loaded.src = 'blob:https://app.test/resolved'
    h.cached.mockReturnValue(loaded)
    waiting.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(h.value()).toMatchObject({ imageNaturalWidth: 120, imageNaturalHeight: 80 }))
    expect(h.getImage).toHaveBeenCalledTimes(2)
  })

  it('首次读取取消后，受管元素的新 load 重新量尺寸，旧调用本身不写回', async () => {
    const h = setup()
    h.getImage.mockRejectedValueOnce(new DOMException('换代', 'AbortError'))
    await h.run()
    expect(h.merge).not.toHaveBeenCalled()
    expect(h.track).toHaveBeenCalledOnce()
    const waiting = h.track.mock.calls[0]?.[2] as HTMLImageElement
    const loaded = document.createElement('img')
    loaded.src = 'blob:https://app.test/resolved'
    h.cached.mockReturnValue(loaded)
    waiting.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(h.value()).toMatchObject({ source: SOURCE, imageNaturalWidth: 120 }))
    expect(h.getImage).toHaveBeenCalledTimes(2)
  })

  it.each(['edit', 'dispose'] as const)('取消后等待新图片期间发生 %s，晚 load 不复活原公式', async (action) => {
    const h = setup()
    h.getImage.mockRejectedValueOnce(new DOMException('换代', 'AbortError'))
    await h.run()
    expect(h.track).toHaveBeenCalledOnce()
    const waiting = h.track.mock.calls[0]?.[2] as HTMLImageElement
    const loaded = document.createElement('img')
    loaded.src = 'blob:https://app.test/resolved'
    h.cached.mockReturnValue(loaded)
    if (action === 'edit')
      h.setFormula('=SUM(1,2)')
    else
      h.controller.dispose()
    waiting.dispatchEvent(new Event('load'))
    await Promise.resolve()
    expect(h.getImage).toHaveBeenCalledTimes(1)
    expect(h.merge).not.toHaveBeenCalled()
  })

  it('正常量尺寸还没返回时公式已经被普通内容替换，迟到尺寸不写回', async () => {
    const h = setup()
    const late = deferred<string>()
    h.getImage.mockReturnValueOnce(late.promise)
    const pending = h.run()
    h.setFormula('=SUM(1,2)')
    late.resolve('blob:https://app.test/resolved')
    await pending
    expect(h.merge).not.toHaveBeenCalled()
  })

  it('使用 URL 服务的解析结果、登记元素，结果模型只保留原来源', async () => {
    const h = setup()
    await h.run()
    expect(h.getImage).toHaveBeenCalledExactlyOnceWith(SOURCE)
    expect(h.assigned).toEqual(['blob:https://app.test/resolved'])
    expect(h.track).toHaveBeenCalledWith(SOURCE, 'URL', expect.any(HTMLImageElement))
    expect(h.value()).toMatchObject({ source: SOURCE, imageNaturalWidth: 120, imageNaturalHeight: 80, isErrorImage: false })
    expect(JSON.stringify(h.value())).not.toContain('blob:')
    expect(h.refreshed).toHaveBeenCalledOnce()
  })

  it('服务取消没有原地址请求、公式结果更新或未处理拒绝', async () => {
    const h = setup()
    h.getImage.mockRejectedValue(new DOMException('退役', 'AbortError'))
    await h.run()
    expect(h.assigned).toEqual([])
    expect(h.merge).not.toHaveBeenCalled()
    expect(h.refreshed).not.toHaveBeenCalled()
  })

  it('控制器退役后，忽略取消的晚返回不写公式结果', async () => {
    const h = setup()
    const late = deferred<string>()
    h.getImage.mockReturnValue(late.promise)
    const pending = h.run()
    h.controller.dispose()
    late.resolve('blob:https://app.test/late')
    await pending
    expect(h.assigned).toEqual([])
    expect(h.merge).not.toHaveBeenCalled()
  })

  it('同一格逆序收到两个公式图片结果，只保留最后的来源', async () => {
    const h = setup()
    const late = deferred<string>()
    h.getImage.mockReturnValueOnce(late.promise)
    const pending = h.run()
    h.getImage.mockResolvedValue('blob:https://app.test/second')
    await h.run(OTHER)
    late.resolve('blob:https://app.test/first')
    await pending
    expect(h.value()?.source).toBe(OTHER)
    expect(h.refreshed).toHaveBeenCalledOnce()
  })

  it('旧批次的另一格还在等待时，新批次已更新本格；旧批次不能覆盖新结果', async () => {
    const h = setup()
    const slowSource = '/api/assets/33333333-3333-4333-8333-333333333333'
    const late = deferred<string>()
    h.getImage.mockImplementation(async source => source === slowSource ? late.promise : `blob:https://app.test/${source === SOURCE ? 'first' : 'second'}`)
    const first = h.run(SOURCE, slowSource)
    await vi.waitFor(() => expect(h.track).toHaveBeenCalledWith(SOURCE, 'URL', expect.any(HTMLImageElement)))
    await h.run(OTHER)
    late.resolve('blob:https://app.test/third')
    await first
    expect(h.value()?.source).toBe(OTHER)
  })

  it('复用服务已经解码的原件，不创建额外量尺寸元素', async () => {
    const h = setup()
    const image = document.createElement('img')
    image.src = 'blob:https://app.test/resolved'
    h.cached.mockReturnValue(image)
    h.assigned.splice(0)
    await h.run()
    expect(h.getImage).toHaveBeenCalledWith(SOURCE)
    expect(h.assigned).toEqual([])
    expect(h.value()).toMatchObject({ imageNaturalWidth: 120, imageNaturalHeight: 80 })
  })

  it('真实其他服务错误明确报告，不能吞成取消或退回原 URL', async () => {
    const h = setup()
    const failure = new Error('unexpected image service failure')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.getImage.mockRejectedValue(failure)
    await h.run()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    expect(h.assigned).toEqual([])
    expect(h.merge).not.toHaveBeenCalled()
  })

  it('控制器退役及时结束原生量尺寸等待，并清除其未完成元素', async () => {
    const h = setup(false)
    const pending = h.run()
    await vi.waitFor(() => expect(h.track).toHaveBeenCalledOnce())
    const image = h.track.mock.calls[0]?.[2] as HTMLImageElement
    h.controller.dispose()
    await pending
    expect(image.getAttribute('src')).toBeNull()
    expect(h.merge).not.toHaveBeenCalled()
  })

  it('原生量尺寸既不 load 也不 error 时，十秒结束并清除元素', async () => {
    vi.useFakeTimers()
    const h = setup(false)
    const pending = h.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.track).toHaveBeenCalledOnce()
    const image = h.track.mock.calls[0]?.[2] as HTMLImageElement
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.value()?.isErrorImage).toBe(true)
    await pending
    expect(image.getAttribute('src')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

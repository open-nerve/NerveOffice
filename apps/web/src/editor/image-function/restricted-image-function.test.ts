import type { BaseValueObject } from '../internal-api/index.ts'
import { ArrayValueObject, NumberValueObject, StringValueObject } from '@univerjs/engine-formula'
import { describe, expect, it } from 'vitest'
import { BaseFunction, ErrorType, ErrorValueObject } from '../internal-api/index.ts'
import { isPlatformAssetAddress } from './platform-asset.ts'
import { RestrictedImageFunction } from './restricted-image-function.ts'

const ORIGIN = 'https://docs.example.com'
const ASSET = '/api/assets/0192d4c3-7a1b-7c2d-8e3f-0123456789ab'

/** 代替 SDK 的 ImageFunction：记下调用，返回一个可以辨认的结果 */
class FakeImageFunction extends BaseFunction {
  override minParams = 1
  override maxParams = 5
  readonly calls: BaseValueObject[][] = []
  readonly result = StringValueObject.create('')

  override calculate(...args: BaseValueObject[]): BaseValueObject {
    this.calls.push(args)
    return this.result
  }
}

function restricted() {
  const original = new FakeImageFunction('IMAGE')
  const wrapper = new RestrictedImageFunction(original, source => isPlatformAssetAddress(source, ORIGIN))
  return { original, wrapper }
}

function isValueError(value: unknown): boolean {
  return value instanceof ErrorValueObject && value.getErrorType() === ErrorType.VALUE
}

describe('IMAGE() 的 restricted 包装', () => {
  it('名称与参数个数沿用原执行器', () => {
    const { wrapper } = restricted()
    expect(wrapper.name).toBe('IMAGE')
    expect([wrapper.minParams, wrapper.maxParams]).toEqual([1, 5])
  })

  it.each([ASSET, `${ORIGIN}${ASSET}`])('平台资源地址 %s 交给原执行器，其余参数原样转交', (address) => {
    const { original, wrapper } = restricted()
    const source = StringValueObject.create(address)
    const altText = StringValueObject.create('说明')
    const sizing = NumberValueObject.create(0)
    expect(wrapper.calculate(source, altText, sizing)).toBe(original.result)
    expect(original.calls).toEqual([[source, altText, sizing]])
  })

  it.each([
    'https://evil.example/a.png',
    'data:image/png;base64,AAAA',
    `${ASSET}?w=1`,
    '',
  ])('其他地址 %j 返回 #VALUE!，不交给原执行器（不产生请求）', (address) => {
    const { original, wrapper } = restricted()
    expect(isValueError(wrapper.calculate(StringValueObject.create(address)))).toBe(true)
    expect(original.calls).toEqual([])
  })

  it('单元格引用、区域与数组常量在计算时都是数组：即使里面是平台地址也拒绝', () => {
    const { original, wrapper } = restricted()
    expect(isValueError(wrapper.calculate(ArrayValueObject.createByArray([[ASSET]])))).toBe(true)
    expect(isValueError(wrapper.calculate(ArrayValueObject.createByArray([[ASSET], ['https://evil.example/a.png']])))).toBe(true)
    expect(original.calls).toEqual([])
  })

  it('只接受字符串：内容是平台地址、类型却不是字符串的值同样拒绝', () => {
    const { original, wrapper } = restricted()
    const disguised = { isString: () => false, isArray: () => false, isError: () => false, getValue: () => ASSET } as unknown as BaseValueObject
    expect(isValueError(wrapper.calculate(disguised))).toBe(true)
    expect(original.calls).toEqual([])
  })

  it('不是字符串的参数（数字、错误）返回 #VALUE!', () => {
    const { original, wrapper } = restricted()
    expect(isValueError(wrapper.calculate(NumberValueObject.create(1)))).toBe(true)
    expect(isValueError(wrapper.calculate(ErrorValueObject.create(ErrorType.REF)))).toBe(true)
    expect(original.calls).toEqual([])
  })
})

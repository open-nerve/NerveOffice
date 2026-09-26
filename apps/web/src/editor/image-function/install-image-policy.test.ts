import type { Univer } from '@univerjs/core'
import type { BaseFunction } from '../internal-api/index.ts'
import { StringValueObject } from '@univerjs/engine-formula'
import { describe, expect, it } from 'vitest'
import { ErrorType, ErrorValueObject, IFunctionService } from '../internal-api/index.ts'
import { installRestrictedImageFunction } from './install-image-policy.ts'
import { RestrictedImageFunction } from './restricted-image-function.ts'

const ORIGIN = 'https://docs.example.com'
const ASSET = '/api/assets/0192d4c3-7a1b-7c2d-8e3f-0123456789ab'

/** 假的函数服务：与 SDK 的 FunctionService 一样按名称存执行器，后注册的覆盖先注册的 */
function fakeFunctions(initial?: BaseFunction) {
  const executors = new Map<string, BaseFunction>()
  if (initial !== undefined)
    executors.set('IMAGE', initial)
  const clearedCache: string[][] = []
  const service = {
    getExecutor: (name: string) => executors.get(name),
    registerExecutors: (...functions: BaseFunction[]) => functions.forEach(fn => executors.set(String(fn.name), fn)),
    deleteFormulaAstCacheKey: (...names: string[]) => clearedCache.push(names),
  }
  const univer = {
    __getInjector: () => ({
      get: (id: unknown) => {
        expect(id).toBe(IFunctionService)
        return service
      },
    }),
  } as unknown as Univer
  return { univer, executors, clearedCache }
}

function fakeImage(): BaseFunction {
  return { name: 'IMAGE', minParams: 1, maxParams: 5, calculate: () => StringValueObject.create('') } as unknown as BaseFunction
}

describe('安装 IMAGE() 的限制', () => {
  it('取出原执行器、注册同名的包装、清掉 IMAGE 的公式缓存；包装按本站的源判断地址', async () => {
    const original = fakeImage()
    const { univer, executors, clearedCache } = fakeFunctions(original)
    await expect(installRestrictedImageFunction(univer, ORIGIN)).resolves.toBe(true)
    const installed = executors.get('IMAGE')
    expect(installed).toBeInstanceOf(RestrictedImageFunction)
    expect(clearedCache).toEqual([['IMAGE']])
    const wrapper = installed as RestrictedImageFunction
    expect(wrapper.calculate(StringValueObject.create(`${ORIGIN}${ASSET}`))).not.toBeInstanceOf(ErrorValueObject)
    const rejected = wrapper.calculate(StringValueObject.create('https://evil.example/a.png'))
    expect(rejected instanceof ErrorValueObject && rejected.getErrorType() === ErrorType.VALUE).toBe(true)
  })

  it('引擎还没有注册 IMAGE：失败', async () => {
    const { univer, executors } = fakeFunctions()
    await expect(installRestrictedImageFunction(univer, ORIGIN)).resolves.toBe(false)
    expect(executors.has('IMAGE')).toBe(false)
  })

  it('Ready 时引擎还没注册 IMAGE、下一个宏任务才注册：按失败处理（这之间的计算可能用了没有包装的执行器）', async () => {
    const { univer, executors } = fakeFunctions()
    const installing = installRestrictedImageFunction(univer, ORIGIN)
    executors.set('IMAGE', fakeImage())
    await expect(installing).resolves.toBe(false)
  })

  it('已经装过：不再套一层', async () => {
    const { univer, executors } = fakeFunctions(fakeImage())
    await installRestrictedImageFunction(univer, ORIGIN)
    const first = executors.get('IMAGE')
    await expect(installRestrictedImageFunction(univer, ORIGIN)).resolves.toBe(true)
    expect(executors.get('IMAGE')).toBe(first)
  })

  it('安装之后、核对之前被晚到的注册覆盖：核对时重新装上', async () => {
    const { univer, executors } = fakeFunctions(fakeImage())
    const installing = installRestrictedImageFunction(univer, ORIGIN)
    // 同一轮里晚到的注册（安装是同步的，核对在下一个宏任务）
    const late = fakeImage()
    executors.set('IMAGE', late)
    await expect(installing).resolves.toBe(true)
    const installed = executors.get('IMAGE')
    expect(installed).toBeInstanceOf(RestrictedImageFunction)
    expect(installed).not.toBe(late)
  })
})

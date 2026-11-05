import type { ExternalRequestWatch } from './external-requests.ts'
import { watchExternalRequests } from './external-requests.ts'
import { test as base, expect } from './fixtures.ts'

export interface ImplicitExternalRequests extends ExternalRequestWatch {
  /** 本用例就是要触发站外请求（观察器自身的对照）：声明之后夹具只附上记录，不再断言为空 */
  readonly expectRequests: () => void
}

/**
 * 只用于没有明确外站导航动作的故事；从首次导航前收集到用例结束，不以 CSP 报告代替请求记录。
 * 观察默认上下文，以及经 newDevice 另开的上下文（anotherDevice 同样经它，M5R-M-15）；能力限制见 external-requests.ts
 */
export const test = base.extend<{ implicitExternalRequests: ImplicitExternalRequests }>({
  implicitExternalRequests: [async ({ context, baseURL }, provide, testInfo) => {
    if (baseURL === undefined)
      throw new Error('外部请求检查缺少被测站点地址')
    const watcher = watchExternalRequests(context, baseURL)
    const declared = { expected: false }
    try {
      await provide({ ...watcher, expectRequests: () => {
        declared.expected = true
      } })
    }
    finally {
      watcher.stop()
      const external = watcher.list()
      await testInfo.attach('implicit-external-requests', { body: JSON.stringify({ expected: declared.expected, external }), contentType: 'application/json' })
      expect(declared.expected ? [] : external, '打开、输入、历史、保存和重开期间不得隐式读取外站').toEqual([])
    }
  }, { auto: true }],
  // 另开的设备在用例结束、它的上下文关闭之前一直在观察窗口内（关闭先于本夹具的收尾）
  newDevice: async ({ newDevice, implicitExternalRequests }, provide) => {
    await provide(async () => {
      const page = await newDevice()
      implicitExternalRequests.watch(page.context())
      return page
    })
  },
})

export { expect } from './fixtures.ts'

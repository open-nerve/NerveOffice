import { watchExternalRequests } from './external-requests.ts'
import { test as base, expect } from './fixtures.ts'

/** 只用于没有明确外站导航动作的故事；从首次导航前收集到用例结束，不以 CSP 报告代替请求记录。 */
export const test = base.extend<{ implicitExternalRequests: void }>({
  implicitExternalRequests: [async ({ context, baseURL }, provide, testInfo) => {
    if (baseURL === undefined)
      throw new Error('外部请求检查缺少被测站点地址')
    const watcher = watchExternalRequests(context, baseURL)
    try {
      await provide()
    }
    finally {
      watcher.stop()
      const external = watcher.list()
      await testInfo.attach('implicit-external-requests', { body: JSON.stringify(external), contentType: 'application/json' })
      expect(external, '打开、输入、历史、保存和重开期间不得隐式读取外站').toEqual([])
    }
  }, { auto: true }],
})

export { expect } from './fixtures.ts'

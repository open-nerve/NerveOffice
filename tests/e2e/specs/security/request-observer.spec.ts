// 外部请求观察器自身的对照（M5 整体审查 M5R-M-15）：另开的浏览器上下文（第二设备）里的站外请求同样被隐式请求夹具看到。
// favicon 地址与被 CSP 拦下的尝试的对照在 csp.spec.ts（要用测试构建的探针页）；能力限制见 support/external-requests.ts。
import { expect, test } from '../../support/implicit-request-fixture.ts'
import { startTargetServer } from '../../support/servers.ts'

test('M5R-M-15 对照：第二设备的上下文里出现站外请求，隐式请求夹具能看到，目标服务也收到', async ({ anotherDevice, implicitExternalRequests }, testInfo) => {
  // 本用例就是要触发站外请求：声明之后夹具不再断言为空
  implicitExternalRequests.expectRequests()
  const target = await startTargetServer()
  try {
    await anotherDevice.goto(`${target.origin}/new-page`)
    await expect(anotherDevice.locator('body')).toHaveText('reachable')
    expect(implicitExternalRequests.list()).toEqual([`${target.origin}/new-page`])
    expect(target.requests()).toEqual(['/new-page'])
  }
  finally {
    await testInfo.attach('second-context-observer-control', { body: JSON.stringify({ observed: implicitExternalRequests.list(), targetRequests: target.requests() }), contentType: 'application/json' })
    await target.close()
  }
})

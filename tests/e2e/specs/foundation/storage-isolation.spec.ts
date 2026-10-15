import { randomUUID } from 'node:crypto'
import { expect, test } from '../../support/fixtures.ts'

test('独立设备的浏览资料不能读到另一台设备的 OPFS 目录', async ({ page, anotherDevice }) => {
  // 初始空白来源不提供存储 API，隔离夹具不得产生 pageerror 或阻断后续 initScript。
  await page.goto('about:blank')
  await page.goto('/api/health/ready')
  await anotherDevice.goto('/api/health/ready')
  const name = `nerve-office-e2e-isolation-${randomUUID()}`
  await page.evaluate(async name => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true }), name)
  try {
    const other = await anotherDevice.evaluate(async (name) => {
      try {
        await (await navigator.storage.getDirectory()).getDirectoryHandle(name)
        return 'present'
      }
      catch (error) {
        return error instanceof DOMException ? error.name : 'other-error'
      }
    }, name)
    expect(other).toBe('NotFoundError')
  }
  finally {
    await page.evaluate(async name => (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }), name)
  }
})

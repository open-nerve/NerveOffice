import { expect, it, vi } from 'vitest'
import { settleCrashCleanup } from './crash-cleanup.ts'

it('任一清理失败均不阻断其余资源回收，只交回固定步骤名', async () => {
  const proxy = vi.fn(() => {
    throw new Error('不得进入报告的底层信息')
  })
  const backend = vi.fn(async () => {
    throw new Error('非零退出')
  })
  const temporary = vi.fn()
  expect(await settleCrashCleanup([{ name: 'proxy', run: proxy }, { name: 'backend', run: backend }, { name: 'temporary', run: temporary }])).toEqual(['proxy', 'backend'])
  expect(proxy).toHaveBeenCalledOnce()
  expect(backend).toHaveBeenCalledOnce()
  expect(temporary).toHaveBeenCalledOnce()
})

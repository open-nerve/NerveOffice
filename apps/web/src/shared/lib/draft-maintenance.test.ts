import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDraftMaintenance } from './draft-maintenance.ts'

const mocks = vi.hoisted(() => ({ mount: vi.fn(), dispose: vi.fn() }))
vi.mock('../local-drafts/browser-maintenance.ts', () => ({ mountBrowserMaintenance: mocks.mount }))
afterEach(() => vi.resetAllMocks())
describe('维护按需加载不阻塞页面启动', () => {
  it('同步返回释放函数，模块到达后才启动维护', async () => {
    mocks.mount.mockReturnValue({ dispose: mocks.dispose })
    const stop = startDraftMaintenance()
    expect(typeof stop).toBe('function')
    await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce())
    stop()
    stop()
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it('已离开的页面不因迟到的动态模块重新启动', async () => {
    const stop = startDraftMaintenance()
    stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.mount).not.toHaveBeenCalled()
  })
})

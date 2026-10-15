import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDraftMaintenance } from './draft-maintenance.ts'

const mocks = vi.hoisted(() => ({ mount: vi.fn(), dispose: vi.fn() }))
const IDLE = { busy: false, cleanup: 'none', retention: 'done', problem: undefined, catalog: undefined, completed: [] }
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

  it('按需挂载后观察维护完成；忙碌期间不刷新索引，释放后不再通知', async () => {
    let busy = true
    let reads = 0
    const listeners = new Set<() => void>()
    mocks.mount.mockReturnValue({ dispose: mocks.dispose, model: {
      view: () => ({ ...IDLE, busy }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    } })
    const stop = startDraftMaintenance(() => {
      reads += 1
    })
    await vi.waitFor(() => expect(mocks.mount).toHaveBeenCalledOnce())
    listeners.forEach(listener => listener())
    expect(reads).toBe(0)
    busy = false
    listeners.forEach(listener => listener())
    expect(reads).toBe(1)
    stop()
    listeners.forEach(listener => listener())
    expect(reads).toBe(1)
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })

  it('加载观察者之前已完成维护时也刷新一次，不能只等待下次信号', async () => {
    let reads = 0
    mocks.mount.mockReturnValue({ dispose: mocks.dispose, model: {
      view: () => IDLE,
      subscribe: () => () => {},
    } })
    const stop = startDraftMaintenance(() => {
      reads += 1
    })
    await vi.waitFor(() => expect(reads).toBe(1))
    stop()
  })
})

import { expect, it, vi } from 'vitest'
import './main.ts'

const { logger, runtime, childProcess, exit } = vi.hoisted(() => {
  const listeners = new Map<string, () => void>()
  const exit = vi.fn()
  const logger = {
    info: vi.fn((_fields: unknown, message: string) => {
      // 在观察到启动日志的同一刻发信号，固定真实进程测试偶发遇到的时序。
      if (message === 'HTTP 服务已启动')
        listeners.get('SIGTERM')?.()
    }),
    fatal: vi.fn(),
    warn: vi.fn(),
  }
  return {
    logger,
    exit,
    childProcess: {
      on: (signal: string, listener: () => void) => { listeners.set(signal, listener) },
      exit,
    },
    runtime: {
      logger,
      listen: vi.fn(async () => ({ address: '127.0.0.1', port: 3100 })),
      shutdown: vi.fn(async () => 'graceful' as const),
    },
  }
})

// 信号处理器使用真实实现，只替换进程事件接口，避免结束测试运行器。
vi.mock('node:process', () => ({ default: childProcess }))
vi.mock('../modules/logging/index.ts', () => ({ createRootLogger: () => logger }))
vi.mock('./index.ts', () => ({
  ConfigError: class extends Error {},
  loadServerConfigFromEnvironment: () => ({}),
  createApplication: async () => runtime,
}))

it('刚公布启动成功就收到 SIGTERM：仍走优雅退出并返回 0', async () => {
  await new Promise(resolve => setImmediate(resolve))

  expect(logger.info).toHaveBeenCalledWith({ address: '127.0.0.1', port: 3100 }, 'HTTP 服务已启动')
  expect(runtime.shutdown).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(logger.fatal).not.toHaveBeenCalled()
})

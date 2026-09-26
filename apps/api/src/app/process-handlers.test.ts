import type { ShutdownResult } from './shutdown.ts'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createRootLogger } from '../modules/logging/index.ts'
import { handleFatalErrors, handleShutdownSignals } from './process-handlers.ts'

function setup() {
  const process = new EventEmitter()
  const exit = vi.fn()
  const logger = createRootLogger({ level: 'silent' })
  return { process, exit, logger }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('handleShutdownSignals', () => {
  it.each([['graceful', 0], ['forced', 1]] as const)('收到 SIGTERM 后优雅退出：结果为 %s 时退出码 %d', async (result, code) => {
    const { process, exit, logger } = setup()
    const shutdown = vi.fn(async (): Promise<ShutdownResult> => result)
    handleShutdownSignals(shutdown, { process, exit, logger })
    process.emit('SIGTERM')
    await settle()
    expect(shutdown).toHaveBeenCalledWith('SIGTERM')
    expect(exit).toHaveBeenCalledWith(code)
  })

  it('退出过程中再次收到信号：立即退出，退出码 1', () => {
    const { process, exit, logger } = setup()
    const shutdown = vi.fn(async () => new Promise<ShutdownResult>(() => {}))
    handleShutdownSignals(shutdown, { process, exit, logger })
    process.emit('SIGINT')
    expect(exit).not.toHaveBeenCalled()
    process.emit('SIGINT')
    expect(exit).toHaveBeenCalledWith(1)
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('退出失败时退出码 1', async () => {
    const { process, exit, logger } = setup()
    handleShutdownSignals(async () => Promise.reject(new Error('关闭失败')), { process, exit, logger })
    process.emit('SIGTERM')
    await settle()
    expect(exit).toHaveBeenCalledWith(1)
  })
})

describe('handleFatalErrors', () => {
  it.each(['uncaughtException', 'unhandledRejection'])('%s：记 fatal 后退出，退出码 1', (event) => {
    const { process, exit, logger } = setup()
    handleFatalErrors({ process, exit, logger })
    process.emit(event, new Error('意外'))
    expect(exit).toHaveBeenCalledWith(1)
  })
})

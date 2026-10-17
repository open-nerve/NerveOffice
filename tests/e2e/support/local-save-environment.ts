// 每组使用独占测试后端，其公开来源就是本组代理；保留实际 Origin/CSRF 校验。
import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startLocalSaveProxy } from '../safari/local-save-proxy.ts'
import { databaseUrl, e2eDatabaseName, pickFreePort } from './environment.ts'

export async function startLocalSaveEnvironment(runId: string) {
  if (process.env.NERVE_TEST_DATABASE_URL === undefined)
    throw new Error('保存测量必须显式使用专用测试数据库')
  const previousDatabase = process.env.E2E_DATABASE_URL
  const port = await pickFreePort()
  const backendOrigin = `http://127.0.0.1:${port}`
  const proxy = await startLocalSaveProxy({ runId, backendOrigin })
  process.env.E2E_DATABASE_URL = databaseUrl(e2eDatabaseName(process.pid))
  const backend = spawn(process.execPath, [fileURLToPath(new URL('./serve.ts', import.meta.url))], {
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=@nerve-office/source`, E2E_PORT: String(port), E2E_BASE_URL: proxy.origin },
    stdio: ['pipe', 'ignore', 'inherit'],
  })
  let spawnFailed = false
  backend.on('error', () => {
    spawnFailed = true
  })
  const ended = new Promise<number | null>(resolve => backend.once('close', code => resolve(code)))
  const stopBackend = async (): Promise<void> => {
    let forced = false
    backend.stdin?.end()
    const timer = setTimeout(() => {
      forced = true
      backend.kill('SIGKILL')
    }, 30_000)
    const code = await ended.finally(() => clearTimeout(timer))
    if (code !== 0 || forced || spawnFailed)
      throw new Error('本组测试后端没有正常退出')
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed)
      return
    closed = true
    try {
      try {
        await proxy.close()
      }
      finally {
        await stopBackend()
      }
    }
    finally {
      if (previousDatabase === undefined)
        delete process.env.E2E_DATABASE_URL
      else
        process.env.E2E_DATABASE_URL = previousDatabase
    }
  }
  try {
    const deadline = Date.now() + 60_000
    for (;;) {
      if (spawnFailed || backend.exitCode !== null || backend.signalCode !== null || Date.now() >= deadline)
        throw new Error('本组测试后端未就绪')
      try {
        if ((await fetch(`${backendOrigin}/api/health/ready`, { signal: AbortSignal.timeout(1000) })).ok)
          break
      }
      catch { /* 下轮再次核对存活与总时限。 */ }
      await delay(100)
    }
    return { proxy, close, healthy: () => !closed && !spawnFailed && backend.exitCode === null && backend.signalCode === null }
  }
  catch (error) {
    await close()
    throw error
  }
}

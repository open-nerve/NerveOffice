import type { TestApp } from '../support/api-app.ts'
import { fork } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { AssetUploadService } from '@nerve-office/api'
import { describe, expect, it, vi } from 'vitest'
import { createPassiveAccount } from '../support/accounts.ts'
import { serverEnvironment, startTestApp } from '../support/api-app.ts'
import { createAssetActor } from '../support/assets.ts'
import { createTestDatabase } from '../support/database.ts'

describe('真实进程崩溃留下的任务临时文件', () => {
  it.each(['before-link', 'after-link'])('%s：SIGKILL 后重新启动并上传，清理残留并复用预留', async (stage) => {
    const database = await createTestDatabase()
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'nerve-staging-crash-')))
    const root = join(directory, 'assets')
    const uploader = await createAssetActor(database, (await createPassiveAccount(database, { username: 'asset-crash-uploader' })).id)
    let app: TestApp | undefined
    const child = fork(new URL('./storage-crash.test-support.mjs', import.meta.url), [uploader.userId, stage, uploader.sessionId], {
      // 不继承 Vitest 的源码条件/loader，实际运行正式构建产物。
      execArgv: [],
      env: { PATH: process.env.PATH, ...serverEnvironment(database.url, { NERVE_ASSET_ROOT: root }) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      stderr += text
    })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    try {
      const message = await new Promise<unknown>((resolve, reject) => {
        child.once('message', resolve)
        child.once('exit', code => reject(new Error(`图片崩溃夹具提前退出 ${String(code)}：${stderr}`)))
        child.once('error', reject)
      })
      expect(message).toEqual({ stage })
      const staging = join(root, 'staging')
      expect(await readdir(staging)).toHaveLength(1)
      const held = async (): Promise<number> => database.query(async client => Number((await client.query<{ count: string }>('SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = \'advisory\' AND a.datname = current_database()')).rows[0]!.count))
      expect(await held()).toBe(1)
      // 初始化只核对本地目录；真正发布前才按数据库占用清理 tmp。
      app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
      expect(await readdir(staging)).toHaveLength(1)
      await app.close()
      app = undefined
      child.kill('SIGKILL')
      await closed
      expect(child.signalCode).toBe('SIGKILL')
      await vi.waitFor(async () => expect(await held()).toBe(0))
      const objectFiles = async (): Promise<string[]> => (await readdir(join(root, 'objects'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
      const published = await objectFiles()
      expect(published).toHaveLength(stage === 'after-link' ? 1 : 0)
      const reserved = await database.query(async client => (await client.query<{ used_bytes: string }>('SELECT used_bytes FROM asset_quota')).rows[0]!.used_bytes)
      app = await startTestApp({ databaseUrl: database.url, env: { NERVE_ASSET_ROOT: root } })
      expect(await readdir(staging)).toHaveLength(1)
      expect(await objectFiles()).toEqual(published)
      const data = await readFile(new URL('../../../../apps/api/src/modules/assets/testdata/minimum.png', import.meta.url))
      const result = await app.runtime.get(AssetUploadService).upload(uploader, async () => ({ data, mimeType: 'image/png', extension: 'png' }), new AbortController().signal)
      expect(await readdir(staging)).toEqual([])
      expect(result.bytes).toBe(Number(reserved))
      const quota = await database.query(async client => (await client.query<{ used_bytes: string, used_assets: number }>('SELECT used_bytes, used_assets FROM asset_quota')).rows[0]!)
      expect(quota).toEqual({ used_bytes: reserved, used_assets: 1 })
    }
    finally {
      child.kill('SIGKILL')
      await closed
      await app?.close()
      await database.drop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

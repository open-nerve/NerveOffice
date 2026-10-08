// 真实进程的启动与退出、迁移命令（P2 设计 §3.3、§3.7、§3.9）：用构建产物启动。
// 本机密钥的主密钥（M3-P6 设计 §3.4）：只有应用进程要求它，缺失、写法不对、HTTPS 下可读时拒绝启动且输出里没有取值；命令行没有它照常。
import type { ApiProcess } from '../support/api-process.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readExpectedMigrations } from '@nerve-office/api'
import { afterEach, describe, expect, it } from 'vitest'
import { serverEnvironment, testEnvironment } from '../support/api-app.ts'
import { startApiProcess } from '../support/api-process.ts'
import { createTestDatabase } from '../support/database.ts'

const started: ApiProcess[] = []
const databases: TestDatabase[] = []

function start(env: Readonly<Record<string, string>>, entry?: 'main' | 'migrate'): ApiProcess {
  const api = startApiProcess(env, entry)
  started.push(api)
  return api
}

/** 主密钥的写法不对时的说明（apps/api 的 config.ts）：只有原因，没有取值 */
const MASTER_KEY_PROBLEM = '必须是 32 字节随机数的标准 base64（44 个字符、以 = 结尾，例如 openssl rand -base64 32 的输出）'

afterEach(async () => {
  // 用例失败时不留下进程
  for (const api of started.splice(0))
    api.kill('SIGKILL')
  for (const database of databases.splice(0))
    await database.drop()
})

describe('迁移命令', () => {
  it('对空库执行全部迁移；再执行一次时说明已是最新；退出码都是 0', async () => {
    const database = await createTestDatabase({ migrated: false })
    try {
      const first = start(testEnvironment(database.url), 'migrate')
      expect((await first.exited).code).toBe(0)
      await first.waitForLog(entry => entry.msg === `已执行 ${readExpectedMigrations().length} 个迁移`)
      const second = start(testEnvironment(database.url), 'migrate')
      expect((await second.exited).code).toBe(0)
      await second.waitForLog(entry => entry.msg === '库结构已是最新，不需要迁移')
    }
    finally {
      await database.drop()
    }
  })

  it('配置缺失时退出码 1', async () => {
    const migrate = start({}, 'migrate')
    expect((await migrate.exited).code).toBe(1)
    await migrate.waitForLog(entry => entry.code === 'CONFIG_INVALID')
  })
})

describe('api 进程', () => {
  it('配置缺失时启动失败：退出码 1，日志的错误码为 CONFIG_INVALID，并列出变量名（应用进程另要求本机密钥的主密钥，M3-P6 设计 §3.4）', async () => {
    const api = start({})
    expect((await api.exited).code).toBe(1)
    const entry = await api.waitForLog(log => log.code === 'CONFIG_INVALID')
    expect(entry).toMatchObject({
      level: 'fatal',
      issues: [{ variable: 'NERVE_DATABASE_URL', problem: '缺少' }, { variable: 'NERVE_PUBLIC_ORIGIN', problem: '缺少' }, { variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: '缺少' }],
    })
  })

  it('启动后开始监听；收到 SIGTERM 后退出，退出码 0', async () => {
    const database = await createTestDatabase()
    databases.push(database)
    const api = start(serverEnvironment(database.url))
    const listening = await api.waitForLog(entry => entry.msg === 'HTTP 服务已启动')
    const response = await fetch(`http://127.0.0.1:${String(listening.port)}/api/health/live`)
    expect(response.status).toBe(200)

    api.kill('SIGTERM')
    expect(await api.exited).toEqual({ code: 0, signal: null })
    await api.waitForLog(entry => entry.msg === '开始退出' && entry.reason === 'SIGTERM')
    await api.waitForLog(entry => entry.msg === '已退出' && entry.result === 'graceful')
  })
})

describe('本机密钥的主密钥（M3-P6 设计 §3.4）：只有应用进程要求它', () => {
  /** 应用拒绝启动：退出码 1，一条 fatal 的 CONFIG_INVALID 恰好列出这些问题，没有开始监听，输出里没有给出的取值 */
  async function expectRefusal(env: Readonly<Record<string, string>>, issues: readonly { variable: string, problem: string }[], secret?: string): Promise<void> {
    const api = start(env)
    expect((await api.exited).code).toBe(1)
    const entry = await api.waitForLog(log => log.code === 'CONFIG_INVALID')
    expect(entry).toMatchObject({ level: 'fatal', issues })
    expect(entry.issues).toHaveLength(issues.length)
    expect(api.output()).not.toContain('HTTP 服务已启动')
    if (secret !== undefined)
      expect(api.output()).not.toContain(secret)
  }

  it('应用缺主密钥（别的都对）：拒绝启动，只列出这个变量"缺少"', async () => {
    const database = await createTestDatabase()
    databases.push(database)
    await expectRefusal(serverEnvironment(database.url, { NERVE_LOCAL_KEYS_MASTER_KEY: '' }), [{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: '缺少' }])
  })

  it('主密钥的写法不对（base64url、缺填充、31 字节、十六进制）：拒绝启动，说明里与整个输出里都没有那个值', async () => {
    const database = await createTestDatabase()
    databases.push(database)
    const random = randomBytes(32)
    for (const value of [random.toString('base64url'), random.toString('base64').slice(0, -1), randomBytes(31).toString('base64'), random.toString('hex')])
      await expectRefusal(serverEnvironment(database.url, { NERVE_LOCAL_KEYS_MASTER_KEY: value }), [{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: MASTER_KEY_PROBLEM }], value)
  })

  it('公开地址是 HTTPS 时拒绝可读的主密钥（开发、测试用的那种）：拒绝启动，输出里没有它；本机的 HTTP 照常', async () => {
    const database = await createTestDatabase()
    databases.push(database)
    const readable = Buffer.from('nerve-office-oops-copied-dev-key').toString('base64')
    const api = start(serverEnvironment(database.url, { NERVE_PUBLIC_ORIGIN: 'https://docs.example.com', NERVE_LOCAL_KEYS_MASTER_KEY: readable }))
    expect((await api.exited).code).toBe(1)
    const entry = await api.waitForLog(log => log.code === 'CONFIG_INVALID')
    expect(entry.issues).toEqual([{ variable: 'NERVE_LOCAL_KEYS_MASTER_KEY', problem: expect.stringContaining('不能用全是可打印字符的主密钥') as unknown }])
    expect(api.output()).not.toContain(readable)
  })

  it('主密钥经 NERVE_LOCAL_KEYS_MASTER_KEY_FILE 从文件读（openssl rand -base64 32 的输出，末尾带换行）：照常启动，启动日志记下主密钥的标识', async () => {
    const database = await createTestDatabase()
    databases.push(database)
    const dir = mkdtempSync(join(tmpdir(), 'nerve-master-key-'))
    try {
      const file = join(dir, 'master-key')
      const key = randomBytes(32).toString('base64')
      writeFileSync(file, `${key}\n`)
      const api = start(serverEnvironment(database.url, { NERVE_LOCAL_KEYS_MASTER_KEY: '', NERVE_LOCAL_KEYS_MASTER_KEY_FILE: file }))
      await api.waitForLog(entry => entry.msg === 'HTTP 服务已启动')
      const ready = await api.waitForLog(entry => entry.msg === '本机密钥的主密钥已就绪')
      expect(ready).toMatchObject({ level: 'info', masterKeyId: expect.stringMatching(/^[\da-f]{32}$/) as unknown, currentKeys: 0 })
      api.kill('SIGTERM')
      expect((await api.exited).code).toBe(0)
      expect(api.output()).not.toContain(key)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('命令行（迁移、初始化管理员、签发重置链接）没有主密钥照常成功：testEnvironment 里本来就没有它', async () => {
    const database = await createTestDatabase({ migrated: false })
    databases.push(database)
    const env = testEnvironment(database.url)
    expect(env).not.toHaveProperty('NERVE_LOCAL_KEYS_MASTER_KEY')
    const migrate = start(env, 'migrate')
    expect((await migrate.exited).code).toBe(0)
    const initAdmin = startApiProcess(env, 'init-admin', { args: ['--username', 'root', '--password-stdin'], stdin: 'correct horse battery staple\n' })
    started.push(initAdmin)
    expect((await initAdmin.exited).code).toBe(0)
    const resetLink = startApiProcess(env, 'reset-link', { args: ['--username', 'root'] })
    started.push(resetLink)
    expect((await resetLink.exited).code).toBe(0)
    expect(resetLink.stdout()).toMatch(/\/reset-password#[\w-]{43}\n$/)
  })
})

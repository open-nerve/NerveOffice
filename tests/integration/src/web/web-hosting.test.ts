// 托管前端产物（P3 设计 §3.8，US-M1-09）：静态文件与入口页的缓存头与安全头、页面路由的回退、/api 不回退。
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication, loadConfig } from '@nerve-office/api'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp, testEnvironment } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'

const INDEX_HTML = '<!doctype html><html><head><title>NerveOffice</title></head><body><div id="root"></div></body></html>'
const CSP_PREFIX = 'default-src \'self\''

let database: TestDatabase
let webRoot: string
let app: TestApp

beforeAll(async () => {
  database = await createTestDatabase()
  // 上级目录以点开头（部署在 ~/.local 之类的目录下）：点文件的检查只能看构建目录之下的路径
  webRoot = join(mkdtempSync(join(tmpdir(), 'nerve-web-')), '.hidden-parent', 'dist')
  mkdirSync(join(webRoot, 'assets'), { recursive: true })
  writeFileSync(join(webRoot, 'index.html'), INDEX_HTML)
  writeFileSync(join(webRoot, 'assets/index-abc123.js'), 'console.log("app")')
  writeFileSync(join(webRoot, 'assets/worker-def456.js'), 'self.onmessage = () => {}')
  writeFileSync(join(webRoot, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(webRoot, '.env'), 'SECRET=1')
  app = await startTestApp({ databaseUrl: database.url, env: { NERVE_WEB_ROOT: webRoot } })
})

afterAll(async () => {
  await app.close()
  await database.drop()
  rmSync(join(webRoot, '..', '..'), { recursive: true, force: true })
})

async function get(path: string): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`)
}

describe('US-M1-09 托管前端产物', () => {
  it('入口页：HTML，带定稿的 CSP 与安全头，不缓存', async () => {
    const response = await get('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/html/)
    expect(response.headers.get('content-security-policy')).toMatch(new RegExp(`^${CSP_PREFIX}`))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(INDEX_HTML)
  })

  it('页面路由（没有扩展名的路径）回退到入口页', async () => {
    for (const path of ['/login', '/documents/0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', '/no-such-page']) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect(await response.text()).toBe(INDEX_HTML)
    }
  })

  it('带哈希的资源：长期缓存，同样带 CSP（Worker 脚本内生效的是它自己响应上的策略）', async () => {
    for (const path of ['/assets/index-abc123.js', '/assets/worker-def456.js']) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/javascript/)
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('content-security-policy')).toMatch(new RegExp(`^${CSP_PREFIX}`))
    }
  })

  it('其他静态文件：不缓存', async () => {
    const response = await get('/favicon.svg')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('找不到的文件、点开头的文件：统一的 404 错误响应，不回退到入口页', async () => {
    for (const path of ['/assets/missing.js', '/.env', '/missing.png']) {
      const response = await get(path)
      expect(response.status, path).toBe(404)
      expect(errorResponseSchema.parse(await response.json()).error.code).toBe('NOT_FOUND')
    }
  })

  it('/api 下的地址从不回退到入口页', async () => {
    for (const path of ['/api', '/api/no-such-endpoint']) {
      const response = await get(path)
      expect(response.status, path).toBe(404)
      expect(response.headers.get('content-type')).toMatch(/json/)
    }
  })

  it('只处理 GET 与 HEAD；/api 以外的其他请求得到统一的 404 错误响应', async () => {
    const head = await fetch(`${app.baseUrl}/login`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    const post = await fetch(`${app.baseUrl}/login`, { method: 'POST', headers: { origin: 'http://127.0.0.1:4100' } })
    expect(post.status).toBe(404)
    expect(errorResponseSchema.parse(await post.json()).error.code).toBe('NOT_FOUND')
  })
})

describe('没有配置或配置错了', () => {
  it('不设 NERVE_WEB_ROOT：只提供接口，页面地址得到统一的 404 错误响应', async () => {
    const apiOnly = await startTestApp({ databaseUrl: database.url })
    try {
      const page = await fetch(`${apiOnly.baseUrl}/`)
      expect(page.status).toBe(404)
      expect(errorResponseSchema.parse(await page.json()).error.code).toBe('NOT_FOUND')
      expect((await fetch(`${apiOnly.baseUrl}/api/health/live`)).status).toBe(200)
    }
    finally {
      await apiOnly.close()
    }
  })

  it('目录里没有入口页：启动失败，说明原因', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'nerve-web-empty-'))
    try {
      const config = loadConfig(testEnvironment(database.url, { NERVE_WEB_ROOT: empty }))
      await expect(createApplication(config)).rejects.toThrow(/没有入口页 index\.html/)
    }
    finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

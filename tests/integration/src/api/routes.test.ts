// 每个接口都要求登录，公开的只有写明的几个（规范 §6：每个请求都在服务端认证、默认拒绝；M2-P6 第 6 片复核 S5）。
// 接口从运行中的应用的路由表列出（support/routes.ts），不手写清单：新加的接口自动在列。没有 @Public() 的接口，未登录（不带会话 Cookie）
// 一律回 401 UNAUTHENTICATED——会话守卫是全局守卫，排在 CSRF、Origin 检查与输入校验之前，所以不必给每个接口造合法的请求。
// 公开的接口只有 PUBLIC_ROUTES 这几个：新加一个公开接口（或者给已有的接口加 @Public()）要在这里写明，审查时看得到；
// 清单里的接口不再公开（未登录回 401）时同样失败，清单不会过时
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { Route } from '../support/routes.ts'
import { randomUUID } from 'node:crypto'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { routesOf } from '../support/routes.ts'

/** 公开的接口（@Public()）：登录、存活与就绪探针、一次性链接（邀请与重置密码，凭链接里的令牌） */
const PUBLIC_ROUTES: readonly string[] = [
  'GET /api/health/live',
  'GET /api/health/ready',
  'POST /api/auth/invitations/accept',
  'POST /api/auth/invitations/inspect',
  'POST /api/auth/login',
  'POST /api/auth/password-resets/complete',
  'POST /api/auth/password-resets/inspect',
]

let database: TestDatabase
let app: TestApp
let routes: Route[]

beforeAll(async () => {
  database = await createTestDatabase()
  app = await startTestApp({ databaseUrl: database.url })
  routes = routesOf(app)
})

afterAll(async () => {
  await app.close()
  await database.drop()
})

const nameOf = (route: Route): string => `${route.method} ${route.path}`

/** 不带会话发这个接口：路径里的参数换成随机的 UUID；写操作带上合法的 Origin 与空的 JSON 请求体 */
async function anonymous(route: Route): Promise<{ status: number, code: string | undefined }> {
  const path = route.path.replaceAll(/:\w+/g, () => randomUUID())
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(route.method)
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: route.method,
    headers: write ? { 'content-type': 'application/json', 'origin': TEST_PUBLIC_ORIGIN } : {},
    ...(write ? { body: '{}' } : {}),
  })
  const text = await response.text()
  const parsed = errorResponseSchema.safeParse(text === '' ? undefined : JSON.parse(text))
  return { status: response.status, code: parsed.success ? parsed.data.error.code : undefined }
}

describe('全部接口的认证：没有 @Public() 的都要求登录，公开的只有写明的几个（规范 §6，M2-P6 第 6 片复核 S5）', () => {
  it('路由表列得出全部接口：业务的各个模块都在，公开清单里的每一项都是真实的接口', () => {
    const names = routes.map(nameOf)
    expect(names.length).toBeGreaterThan(40)
    for (const prefix of ['/api/admin/', '/api/auth/', '/api/documents', '/api/folders', '/api/health/', '/api/search', '/api/spaces', '/api/trash', '/api/users'])
      expect(names.some(name => name.split(' ')[1]?.startsWith(prefix)), prefix).toBe(true)
    expect(names).toEqual(expect.arrayContaining([...PUBLIC_ROUTES]))
  })

  it('未登录：公开清单之外的每个接口都回 401 UNAUTHENTICATED；清单里的接口不回它', async () => {
    const wrong: string[] = []
    for (const route of routes) {
      const { status, code } = await anonymous(route)
      const rejected = status === 401 && code === 'UNAUTHENTICATED'
      if (PUBLIC_ROUTES.includes(nameOf(route)) === rejected)
        wrong.push(`${nameOf(route)}：${status} ${code ?? ''}${rejected ? '（写在公开清单里，却要求登录）' : '（不在公开清单里，未登录却没有被拒绝）'}`)
    }
    expect(wrong).toEqual([])
  })
})

// 每个接口都要求登录，公开的只有写明的几个（规范 §6：每个请求都在服务端认证、默认拒绝；M2-P6 第 6 片复核 S5）。
// 接口从运行中的应用的路由表列出（support/routes.ts），不手写清单：新加的接口自动在列。没有 @Public() 的接口，未登录（不带会话 Cookie）
// 一律回 401 UNAUTHENTICATED——会话守卫是全局守卫，排在 CSRF、Origin 检查与输入校验之前，所以不必给每个接口造合法的请求。
// 公开的接口只有 PUBLIC_ROUTES 这几个：新加一个公开接口（或者给已有的接口加 @Public()）要在这里写明，审查时看得到；
// 清单里的接口不再公开（未登录回 401）时同样失败，清单不会过时。
// 后台请求（@BackgroundRequest()，不顺延登录的空闲过期）同样按接口逐个列出、写明清单（BACKGROUND_ROUTES，M3-P2 复核 B5）：
// 误标到用户的操作上（例如保存），编辑中的人到了空闲期限就掉登录；只按接口逐个测"顺延或不顺延"时，要当时也去改那条用例才发现得了
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import type { Route } from '../support/routes.ts'
import { randomUUID } from 'node:crypto'
import { BACKGROUND_REQUEST_ROUTE } from '@nerve-office/api/testing'
import { errorResponseSchema } from '@nerve-office/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestApp, TEST_PUBLIC_ORIGIN } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { controllerRoutesOf, routesOf } from '../support/routes.ts'

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

/**
 * 后台请求（@BackgroundRequest()，M3-P2 设计 §3.2，DEF-043）：页面在后台定时发的，只有阅读页每 30 秒读一次编辑状态与编辑时每 10 秒的心跳。
 * 申请、释放编辑权与保存都是用户的操作，照常顺延登录；P4 的自动保存是编辑的结果，同样要顺延，不能标它
 */
const BACKGROUND_ROUTES: readonly string[] = [
  'GET /api/documents/:id/edit-lease',
  'PUT /api/documents/:id/edit-lease',
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
    for (const prefix of ['/api/admin/', '/api/auth/', '/api/documents', '/api/folders', '/api/health/', '/api/search', '/api/shared', '/api/spaces', '/api/trash', '/api/users'])
      expect(names.some(name => name.split(' ')[1]?.startsWith(prefix)), prefix).toBe(true)
    expect(names).toEqual(expect.arrayContaining([...PUBLIC_ROUTES]))
    // 分享的接口（M2-P5）都在路由表里：下面的未登录核对因此覆盖它们
    expect(names).toEqual(expect.arrayContaining(['GET /api/documents/:id/grants', 'PUT /api/documents/:id/grants/:userId', 'DELETE /api/documents/:id/grants/:userId', 'GET /api/shared']))
    // 编辑权的四个接口（M3-P1）同样在路由表里
    expect(names).toEqual(expect.arrayContaining(['GET /api/documents/:id/edit-lease', 'POST /api/documents/:id/edit-lease', 'PUT /api/documents/:id/edit-lease', 'DELETE /api/documents/:id/edit-lease']))
    // 另存为副本（M3-P2）：未登录同样一律 401
    expect(names).toContain('POST /api/documents/:id/conflict-copies')
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

describe('后台请求：标了 @BackgroundRequest() 的接口恰好是编辑状态与心跳（M3-P2 设计 §3.2，复核 B5）', () => {
  it('从控制器的元数据列出的接口与路由表相同；按会话守卫的读法（方法上的覆盖控制器上的）带着这个标记的，恰好是写明的两个', () => {
    const handled = controllerRoutesOf(app)
    expect(handled.map(nameOf)).toEqual(routes.map(nameOf))
    expect(handled.filter(route => route.metadata(BACKGROUND_REQUEST_ROUTE) === true).map(nameOf)).toEqual([...BACKGROUND_ROUTES])
  })
})

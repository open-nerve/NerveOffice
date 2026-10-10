// 崩溃工具的重开（M4-P1 设计 §3.7）：浏览器被结束时会话 Cookie 不一定已经落盘，重开时走两条确定的路——restore（崩溃之前存下的加回去，
// 模拟已落盘：同一次登录接着有效）、clear（清掉，模拟没落盘：没有登录，重新登录之后照常）。P3 的恢复要分别对"同一次登录"与"新的登录"成立。
// 浏览器被结束之后实际留下了哪些 Cookie 由工具记成附件（不带值），不断言。clear 那条先正常关闭再打开一次，让浏览器把登录落了盘
// （重开之后自己就带着它），被结束之后重开时磁盘上一定有这份——clear 要确实把它清掉（Chromium 系与 macOS 的 WebKit 被结束时还没落盘，
// 不这样做 clear 就测不到）
import { sessionResponseSchema } from '@nerve-office/contracts'
import { expect, expectCrashed, test } from '../../support/browser-crash.ts'
import { createUser } from '../../support/database.ts'
import { loginThroughApi } from '../../support/session.ts'

test.describe('崩溃工具：以同一个目录重开时的 Cookie', () => {
  test('restore：崩溃之前的登录接着有效', async ({ crashTool }) => {
    const user = await createUser('crash-restore')
    const launch = await crashTool.launch()
    await loginThroughApi(launch.page, user)
    const before = sessionResponseSchema.parse(await (await launch.page.request.get('/api/auth/session')).json())
    const report = await crashTool.crash(launch)
    expectCrashed(report)

    const reopened = await crashTool.relaunch(launch, report, { cookies: 'restore' })
    const session = await reopened.page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect(sessionResponseSchema.parse(await session.json()).user.id).toBe(before.user.id)
  })

  test('clear：浏览器自己留着的登录也清掉，重新登录之后照常', async ({ crashTool }) => {
    const user = await createUser('crash-clear')
    const first = await crashTool.launch()
    await loginThroughApi(first.page, user)
    // 正常关闭再打开：浏览器把会话 Cookie 落了盘，打开之后自己就带着它
    const launch = await crashTool.reopen(first)
    expect((await launch.page.request.get('/api/auth/session')).status()).toBe(200)
    const report = await crashTool.crash(launch)
    expectCrashed(report)

    const reopened = await crashTool.relaunch(launch, report, { cookies: 'clear' })
    expect((await reopened.page.request.get('/api/auth/session')).status()).toBe(401)
    await loginThroughApi(reopened.page, user)
    const session = await reopened.page.request.get('/api/auth/session')
    expect(session.status()).toBe(200)
    expect(sessionResponseSchema.parse(await session.json()).user.username).toBe(user.username)
  })
})

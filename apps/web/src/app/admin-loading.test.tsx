// 直接打开按需加载的管理界面（审查 B5）：路由要先下载它的代码才开始渲染，这期间显示确认登录的骨架屏，不是整页空白。
// 管理界面的代码由测试决定何时"下载完"：它的模块在测试放行之前一直加载不完（这个文件里只加载一次）。
import { screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { listPage, ROOT, session, settle } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const adminCode = vi.hoisted(() => {
  let release: () => void = () => {}
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  return { loaded, release: () => release() }
})

vi.mock('../features/admin/index.ts', async (importOriginal) => {
  await adminCode.loaded
  return importOriginal()
})

// 真实的管理界面模块先加载好（转换与求值在慢机器上可能要好几秒）：放行之后只剩渲染，不受机器快慢影响（复验 N1）
beforeAll(async () => {
  await vi.importActual('../features/admin/index.ts')
})

describe('直接打开管理界面', () => {
  it('下载代码期间显示确认登录的骨架屏；下载完之后照常确认登录、打开账户页', async () => {
    const api = installFakeApi({
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/users': () => json(200, listPage([ROOT])),
    })
    renderApp('/admin/users')
    expect(screen.getByRole('status', { name: '正在确认登录状态…' })).toBeInTheDocument()
    await settle()
    expect(screen.getByRole('status', { name: '正在确认登录状态…' })).toBeInTheDocument()
    // 还没开始渲染需要登录的外层路由：会话也还没有查
    expect(api.requests).toEqual([])

    adminCode.release()
    expect(await screen.findByRole('table', { name: '账户列表' }, { timeout: 5_000 })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: '正在确认登录状态…' })).toBeNull()
  })
})

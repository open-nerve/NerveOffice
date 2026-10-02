// 登录后的页面框架：页头在单页切到按需加载的页面时显示进行中（审查 B5）；窄屏时只有名字收窄（审查 B11）。
// 管理界面的代码由测试决定何时"下载完"：它的模块在测试放行之前一直加载不完（这个文件里只加载一次）。
import type { SessionResponse } from '@nerve-office/contracts'
import { fireEvent, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { personIn, plainName } from '../shared/testing/people.test-support.ts'
import { documentsKey, spaceRoutes } from '../shared/testing/spaces.test-support.ts'
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

const LONG_NAME = '一个名字很长很长的系统管理员'
const SESSION: SessionResponse = {
  user: { id: '0199a2c4-0000-7000-8000-000000000001', username: 'root', displayName: LONG_NAME, systemRole: 'admin' },
  personalSpace: { id: '0199a2c4-0000-7000-8000-0000000000aa', name: LONG_NAME },
  csrfToken: 'csrf-1',
}

describe('页头', () => {
  it('当前用户的名字：显示名与登录名分开呈现（M2-P6 复核 M2）；窄屏时收窄成一行省略号，完整的名字在 title 里；入口与按钮不收窄（审查 B11）', async () => {
    installFakeApi({
      ...spaceRoutes(SESSION),
      'GET /api/auth/session': () => json(200, SESSION),
      [documentsKey(SESSION)]: () => json(200, { items: [], nextCursor: null }),
    })
    renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    const name = personIn(screen.getByRole('banner'), LONG_NAME, 'root')
    expect(name).toHaveAttribute('title', plainName(LONG_NAME, 'root'))
    expect(name).toHaveClass('min-w-0', 'truncate')
    // 名字所在的一组可以收窄，产品名称与"管理"一组不收窄
    expect(name.parentElement).toHaveClass('min-w-0')
    expect(screen.getByRole('link', { name: 'NerveOffice' }).parentElement).toHaveClass('shrink-0')
  })

  it('单页里第一次点"管理"：下载管理界面的代码期间页头显示进行中、内容区标为忙碌，下载完之后恢复（审查 B5）', async () => {
    installFakeApi({
      ...spaceRoutes(SESSION),
      'GET /api/auth/session': () => json(200, SESSION),
      [documentsKey(SESSION)]: () => json(200, { items: [], nextCursor: null }),
      'GET /api/admin/users': () => json(200, { items: [], nextCursor: null }),
    })
    renderApp('/')
    await screen.findByRole('heading', { name: '我的空间' })
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'false')

    fireEvent.click(screen.getByRole('link', { name: '管理' }))
    expect(await screen.findByRole('progressbar', { name: '正在打开页面…' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')
    // 下载期间原来的页面还在
    expect(screen.getByRole('heading', { name: '我的空间' })).toBeInTheDocument()

    adminCode.release()
    expect(await screen.findByText('没有符合条件的账户', undefined, { timeout: 5_000 })).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'false')
  })
})

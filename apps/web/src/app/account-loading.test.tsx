import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

const accountCode = vi.hoisted(() => ({ loaded: Promise.resolve(), release: () => {} }))

vi.mock('../shared/lib/chunk-load.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../shared/lib/chunk-load.ts')>()
  return {
    ...original,
    loadChunk: async <T,>(load: () => Promise<T>): Promise<T> => {
      await accountCode.loaded
      return original.loadChunk(load)
    },
  }
})

beforeEach(() => {
  accountCode.loaded = new Promise<void>((resolve) => {
    accountCode.release = resolve
  })
})

describe('账户页面按需加载', () => {
  it.each([
    ['/invite', 'invitations'],
    ['/reset-password', 'password-resets'],
  ])('%s 下载期间说明正在打开，令牌保持到页面接管，再正常核对链接', async (path, endpoint) => {
    const token = 't'.repeat(43)
    const api = installFakeApi({
      [`POST /api/auth/${endpoint}/inspect`]: () => json(200, { username: 'amy', displayName: '艾米', expiresAt: '2026-10-20T00:00:00.000Z' }),
    })
    const app = renderApp(`${path}#${token}`)
    try {
      expect(screen.getByRole('status', { name: '正在打开页面…' })).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: '正在确认登录状态…' })).toBeNull()
      expect(api.requests).toEqual([])
      expect(app.router.state.location.hash).toBe(`#${token}`)
      accountCode.release()
      expect(await screen.findByText('amy')).toBeInTheDocument()
      expect(app.router.state.location.hash).toBe('')
      expect(api.requests.map(request => [request.key, request.body])).toEqual([[`POST /api/auth/${endpoint}/inspect`, { token }]])
    }
    finally {
      accountCode.release()
    }
  })
})

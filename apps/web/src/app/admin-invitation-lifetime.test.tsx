// 邀请页的有效期说明来自 contracts 的常量（M2-P6 复核 S-2）：这里把常量换成别的天数，界面跟着变，说明没有写死。
// 单独一个文件：vi.mock 作用于整个文件，不影响其他用例用真实的常量。
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { installFakeApi, json } from '../shared/testing/fake-api.test-support.ts'
import { listPage, session, SPACES } from './admin.test-support.ts'
import { renderApp } from './render-app.test-support.tsx'

vi.mock('@nerve-office/contracts', async importOriginal => ({ ...await importOriginal<typeof import('@nerve-office/contracts')>(), INVITATION_LIFETIME_DAYS: 9 }))

describe('邀请页的有效期说明', () => {
  it('按 contracts 的 INVITATION_LIFETIME_DAYS 显示天数', async () => {
    installFakeApi({
      ...SPACES,
      'GET /api/auth/session': () => json(200, session('admin')),
      'GET /api/admin/invitations': () => json(200, listPage([])),
    })
    renderApp('/admin/invitations')
    expect(await screen.findByText(/生成一次性链接（9 天内有效）/)).toBeInTheDocument()
  })
})

// 一次性链接的公开页面：与路由的匹配一样，不区分大小写、不管末尾的斜杠。
import { describe, expect, it } from 'vitest'
import { isOneTimeLinkPage } from './paths.ts'

describe('isOneTimeLinkPage', () => {
  it('接受邀请与重置密码的页面', () => {
    expect(isOneTimeLinkPage('/invite')).toBe(true)
    expect(isOneTimeLinkPage('/reset-password')).toBe(true)
    expect(isOneTimeLinkPage('/Invite/')).toBe(true)
    expect(isOneTimeLinkPage('/RESET-PASSWORD//')).toBe(true)
  })

  it('其他页面', () => {
    expect(isOneTimeLinkPage('/')).toBe(false)
    expect(isOneTimeLinkPage('/login')).toBe(false)
    expect(isOneTimeLinkPage('/invite/x')).toBe(false)
    expect(isOneTimeLinkPage('/admin/invitations')).toBe(false)
  })
})

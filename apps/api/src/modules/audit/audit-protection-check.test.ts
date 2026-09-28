import type { AuditRepository, AuditTableAccess } from './audit.repository.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { AUDIT_BYPASS_WARNING, AuditProtectionCheck, canBypassAppendOnly, PROTECTION_CHECK_WAIT_MS } from './audit-protection-check.ts'

function setup(access: AuditTableAccess | Error | Promise<AuditTableAccess>) {
  const repository = {
    currentAccess: vi.fn(async () => {
      if (access instanceof Error)
        throw access
      return access
    }),
  }
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const info = vi.spyOn(AppLogger.prototype, 'info')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  return { check: new AuditProtectionCheck(repository as unknown as AuditRepository, logger), warn, info }
}

afterEach(() => {
  vi.restoreAllMocks()
})

const APP_ROLE: AuditTableAccess = { role: 'nerve_app', superuser: false, ownsTable: false }

describe('canBypassAppendOnly', () => {
  it('超级用户或审计表的所有者关得掉触发器；受限的应用角色关不掉', () => {
    expect(canBypassAppendOnly({ role: 'postgres', superuser: true, ownsTable: true })).toBe(true)
    expect(canBypassAppendOnly({ role: 'nerve_owner', superuser: false, ownsTable: true })).toBe(true)
    expect(canBypassAppendOnly(APP_ROLE)).toBe(false)
    expect(canBypassAppendOnly({ role: 'nerve_app', superuser: false, ownsTable: undefined })).toBe(false)
  })
})

describe('AuditProtectionCheck', () => {
  it('能绕过只追加的保护：启动时告警，带着角色与原因', async () => {
    const { check, warn } = setup({ role: 'nerve_owner', superuser: false, ownsTable: true })
    await check.onApplicationBootstrap()
    expect(warn).toHaveBeenCalledWith(AUDIT_BYPASS_WARNING, { role: 'nerve_owner', superuser: false, ownsAuditTable: true })
  })

  it('受限的应用角色：只记一条说明，不告警', async () => {
    const { check, warn, info } = setup(APP_ROLE)
    await check.onApplicationBootstrap()
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith('数据库角色关不掉审计表的触发器', { role: 'nerve_app', superuser: false, ownsAuditTable: false })
  })

  it('审计表还不存在：说明没有检查所有者', async () => {
    const { check, warn } = setup({ role: 'nerve_app', superuser: false, ownsTable: undefined })
    await check.onApplicationBootstrap()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('审计表还不存在'), expect.objectContaining({ ownsAuditTable: undefined }))
  })

  it('查询失败（例如数据库不可达）：记一条告警后跳过，不影响启动', async () => {
    const { check, warn } = setup(new Error('连接被拒绝'))
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没能检查'), expect.objectContaining({ err: expect.any(Error) as unknown }))
  })

  it('查询很慢（例如数据库连接超时）：最多等 2 秒就照常启动，有了结果再记（审查 A4）', async () => {
    vi.useFakeTimers()
    try {
      let answer: (access: AuditTableAccess) => void = () => {}
      const { check, warn } = setup(new Promise<AuditTableAccess>((resolve) => {
        answer = resolve
      }))
      let started = false
      const bootstrap = check.onApplicationBootstrap().then(() => {
        started = true
      })
      await vi.advanceTimersByTimeAsync(PROTECTION_CHECK_WAIT_MS - 1)
      expect(started).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await bootstrap
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('超过 2000 毫秒'))
      expect(warn).not.toHaveBeenCalledWith(AUDIT_BYPASS_WARNING, expect.anything())

      answer({ role: 'postgres', superuser: true, ownsTable: true })
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(AUDIT_BYPASS_WARNING, { role: 'postgres', superuser: true, ownsAuditTable: true }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('2 秒之后才失败的查询：有了结果再记"没能检查"', async () => {
    vi.useFakeTimers()
    try {
      let fail: (error: Error) => void = () => {}
      const { check, warn } = setup(new Promise<AuditTableAccess>((_resolve, reject) => {
        fail = reject
      }))
      const bootstrap = check.onApplicationBootstrap()
      await vi.advanceTimersByTimeAsync(PROTECTION_CHECK_WAIT_MS)
      await bootstrap
      fail(new Error('连接超时'))
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('没能检查'), expect.objectContaining({ err: expect.any(Error) as unknown })))
    }
    finally {
      vi.useRealTimers()
    }
  })
})

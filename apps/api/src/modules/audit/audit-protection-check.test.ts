import type { AuditRepository, AuditTableAccess } from './audit.repository.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { AUDIT_BYPASS_WARNING, AuditProtectionCheck, canBypassAppendOnly } from './audit-protection-check.ts'

function setup(access: AuditTableAccess | Error) {
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
})

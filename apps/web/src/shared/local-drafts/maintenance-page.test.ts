import { describe, expect, it } from 'vitest'
import { DOCUMENT_ID } from '../outbox/draft-record.test-support.ts'
import { maintenanceIncludes } from './maintenance-page.ts'

describe('后台维护尊重当前页的前台恢复所有者', () => {
  it('普通平台入口处理全部记录；编辑器仅跳过当前文档，仍检查其它文档', () => {
    expect(maintenanceIncludes('/', DOCUMENT_ID)).toBe(true)
    expect(maintenanceIncludes(`/documents/${DOCUMENT_ID}`, DOCUMENT_ID)).toBe(false)
    expect(maintenanceIncludes('/documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DOCUMENT_ID)).toBe(true)
  })
  it('本机草稿页的前台目录独自负责本人列表，后台不创建第二个操作所有者', () => {
    expect(maintenanceIncludes('/local-drafts', DOCUMENT_ID)).toBe(false)
    expect(maintenanceIncludes('/local-drafts/', DOCUMENT_ID)).toBe(false)
    expect(maintenanceIncludes('/logout', DOCUMENT_ID)).toBe(true)
  })
})

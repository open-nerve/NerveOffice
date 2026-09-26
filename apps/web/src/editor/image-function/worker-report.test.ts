import { describe, expect, it } from 'vitest'
import { IMAGE_POLICY_MESSAGE_TYPE, imagePolicyReport, readImagePolicyReport } from './worker-report.ts'

describe('Worker 回报 IMAGE() 的安装结果', () => {
  it('回报是对象，type 用字符串：Univer 的 RPC 只认数值型的 type，会忽略它', () => {
    expect(imagePolicyReport(true)).toEqual({ type: 'nerve:image-policy', ok: true })
    expect(typeof imagePolicyReport(false).type).toBe('string')
  })

  it('认出自己的回报', () => {
    expect(readImagePolicyReport({ type: IMAGE_POLICY_MESSAGE_TYPE, ok: true })).toEqual({ type: IMAGE_POLICY_MESSAGE_TYPE, ok: true })
    expect(readImagePolicyReport({ type: IMAGE_POLICY_MESSAGE_TYPE, ok: false })).toEqual({ type: IMAGE_POLICY_MESSAGE_TYPE, ok: false })
  })

  it.each([
    // RPC 的请求与响应（type 是数值：rpc.service.ts:136-186）
    { type: 50, seq: 1 },
    { type: 0, seq: 1, data: {} },
    null,
    undefined,
    'nerve:image-policy',
    42,
    { type: IMAGE_POLICY_MESSAGE_TYPE },
    { type: IMAGE_POLICY_MESSAGE_TYPE, ok: 'true' },
    { type: 'nerve:other', ok: true },
  ])('其他消息不是回报：%j', (data) => {
    expect(readImagePolicyReport(data)).toBeNull()
  })
})

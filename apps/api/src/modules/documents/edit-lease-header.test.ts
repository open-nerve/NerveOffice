// 请求头里的编辑租约令牌（M3-P1 设计 §3.2）：没带是 undefined（按没有租约处理），格式不对 400，不回显取值。
import type { Request } from 'express'
import { EDIT_LEASE_HEADER } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { editLeaseTokenOf } from './edit-lease-header.ts'

const TOKEN = `${'a'.repeat(41)}-_`

/** 只带这些请求头的请求（Node 收到的请求头名都是小写） */
function request(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request
}

function failure(run: () => unknown): AppError {
  try {
    run()
  }
  catch (error) {
    if (error instanceof AppError)
      return error
    throw error
  }
  throw new Error('期望抛出 AppError')
}

describe('editLeaseTokenOf', () => {
  it('请求头名是小写的 x-edit-lease：带了合法的令牌就取出来', () => {
    expect(EDIT_LEASE_HEADER).toBe('x-edit-lease')
    expect(editLeaseTokenOf(request({ 'x-edit-lease': TOKEN }))).toBe(TOKEN)
  })

  it('没带：undefined（按"没有租约"处理，由有效条件给出 none）；别的请求头不算', () => {
    expect(editLeaseTokenOf(request({}))).toBeUndefined()
    expect(editLeaseTokenOf(request({ 'x-csrf-token': TOKEN, 'authorization': TOKEN }))).toBeUndefined()
  })

  it.each([
    ['空值', ''],
    ['短了一个字符', TOKEN.slice(1)],
    ['多了一个字符', `${TOKEN}a`],
    ['带填充', `${TOKEN.slice(1)}=`],
    ['不是 base64url 的字符', `${TOKEN.slice(1)}+`],
    ['重复的请求头合成的一串', `${TOKEN}, ${TOKEN}`],
  ])('格式不对（%s）：400 REQUEST_INVALID，说明里只有请求头的名字、不回显取值', (_case, value) => {
    const error = failure(() => editLeaseTokenOf(request({ 'x-edit-lease': value })))
    expect([error.code, error.status, error.message]).toEqual(['REQUEST_INVALID', 400, '请求参数不合法：x-edit-lease'])
    if (value !== '')
      expect(error.message).not.toContain(value)
  })

  it('请求头是数组（不该出现）同样按格式不对处理', () => {
    expect(failure(() => editLeaseTokenOf(request({ 'x-edit-lease': [TOKEN, TOKEN] }))).code).toBe('REQUEST_INVALID')
  })
})

import { describe, expect, it } from 'vitest'
import { ApiError, NetworkError } from './client.ts'
import { describeError } from './describe-error.ts'

describe('describeError', () => {
  it('登记过的错误码：用前端的文字，带请求标识', () => {
    expect(describeError(new ApiError(401, 'INVALID_CREDENTIALS', '服务端的说明', { requestId: 'r1' }))).toEqual({ message: '用户名或密码错误', requestId: 'r1' })
  })

  it('尝试次数过多：按 Retry-After 换算成分钟（向上取整）', () => {
    expect(describeError(new ApiError(429, 'TOO_MANY_ATTEMPTS', 'x', { retryAfterSeconds: 61 })).message).toBe('尝试次数过多，请 2 分钟后再试')
    expect(describeError(new ApiError(429, 'TOO_MANY_ATTEMPTS', 'x')).message).toBe('尝试次数过多，请稍后再试')
  })

  it('前端还不认识的错误码：用服务端的说明；不是约定的格式：通用说明', () => {
    expect(describeError(new ApiError(409, 'DOCUMENT_LOCKED', '文档正被别人编辑')).message).toBe('文档正被别人编辑')
    expect(describeError(new ApiError(502, 'UNKNOWN', 'x')).message).toBe('出了点问题，请稍后重试')
  })

  it('看得到却不能做（PERMISSION_DENIED）：原因取决于服务端的状态，用服务端这次的说明（ADR-008 的例外，M2-P6 复核 S5）', () => {
    expect(describeError(new ApiError(403, 'PERMISSION_DENIED', '空间已归档，只能查看', { requestId: 'r2' }))).toEqual({ message: '空间已归档，只能查看', requestId: 'r2' })
    expect(describeError(new ApiError(403, 'PERMISSION_DENIED', '编辑者只能删除自己创建的文档')).message).toBe('编辑者只能删除自己创建的文档')
  })

  it('每个错误码都有前端的文字（M2-P6 复核 G3）：文件夹的层数与成环不再落到服务端的说明', () => {
    expect(describeError(new ApiError(409, 'FOLDER_DEPTH_EXCEEDED', '文件夹的层级超过上限')).message).toBe('文件夹最多 10 层：这样新建或移动会超过层数上限（移动时连同里面的子文件夹一起算）')
    expect(describeError(new ApiError(409, 'FOLDER_CYCLE', '服务端的说明')).message).toBe('不能把文件夹移动到它自己或它的子文件夹里')
  })

  it('页面拿着的令牌过时（CSRF_TOKEN_INVALID）：全局处理已经换上新令牌，说再试一次就行，不叫人刷新（刷新会丢掉输入，M2-P6 复核 G3）', () => {
    const message = describeError(new ApiError(403, 'CSRF_TOKEN_INVALID', '请求已失效，请刷新页面后重试')).message
    expect(message).toBe('登录状态刚刚更新，这次操作没有完成，请再试一次')
    expect(message).not.toContain('刷新')
  })

  it('网络失败与其他异常', () => {
    expect(describeError(new NetworkError('x')).message).toBe('网络连接失败，请检查网络后重试')
    expect(describeError(new Error('x')).message).toBe('出了点问题，请稍后重试')
  })
})

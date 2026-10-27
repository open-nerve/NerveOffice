import { describe, expect, it } from 'vitest'
import { inspectProcessOperation, processDiagnostic, processFailureSchema } from './e2e-diagnostics.ts'

describe('CI 进程检查诊断不吞掉故障，也不记录第三方正文', () => {
  it('正常结果原样返回', () => {
    const value = { pid: 42 }
    expect(inspectProcessOperation('read-process', () => value, 42)).toBe(value)
  })

  it.each(['EIO', 'EACCES', 'ENOENT', 'ESRCH'])('保留系统错误码 %s、操作与 PID，拒绝命令行/环境/路径正文', (code) => {
    const source = Object.assign(new Error('secret command and token'), { code, path: '/private/secret', env: { TOKEN: 'secret' } })
    let caught: unknown
    try {
      inspectProcessOperation('read-environment', () => {
        throw source
      }, 42)
    }
    catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect(processDiagnostic(caught)).toEqual({ operation: 'read-environment', pid: 42, code })
    expect(JSON.stringify(processDiagnostic(caught))).not.toContain('secret')
    // 上层原有 ENOENT/ESRCH/EACCES 策略仍能判断系统错误码；诊断包装本身不放行。
    expect(caught).toHaveProperty('code', code)
  })

  it('任意异常消息与伪造错误码不进入诊断', () => {
    expect(processDiagnostic(new Error('secret'))).toEqual({ operation: 'unclassified', code: 'UNKNOWN' })
    let caught: unknown
    try {
      inspectProcessOperation('parse-process', () => {
        throw Object.assign(new Error('secret'), { code: 'SECRET_TOKEN' })
      }, 7)
    }
    catch (error) { caught = error }
    expect(processDiagnostic(caught)).toEqual({ operation: 'parse-process', pid: 7, code: 'UNKNOWN' })
  })

  it('静态快照只接受系统已定义的错误码，外来字符串不能借 code 字段输出', () => {
    const value = { at: 1, stage: 'run', operation: 'read-process', code: 'EIO' }
    expect(processFailureSchema.safeParse(value).success).toBe(true)
    expect(processFailureSchema.safeParse({ ...value, code: 'ESECRET' }).success).toBe(false)
    expect(processFailureSchema.safeParse({ ...value, operation: 'private command' }).success).toBe(false)
  })

  it('嵌套检查保留最早失败的准确操作', () => {
    let caught: unknown
    try {
      inspectProcessOperation('list-processes', () => inspectProcessOperation('stat-process', () => {
        throw Object.assign(new Error('synthetic failure'), { code: 'EIO' })
      }, 17))
    }
    catch (error) { caught = error }
    expect(processDiagnostic(caught)).toEqual({ operation: 'stat-process', pid: 17, code: 'EIO' })
  })
})

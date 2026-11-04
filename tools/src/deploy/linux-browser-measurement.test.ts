import { Buffer } from 'node:buffer'
import process from 'node:process'
import { expect, it } from 'vitest'
import { measurementCommand, measurementFailureDetail, recordMeasurementFailure } from './linux-browser-measurement.ts'

it('保留具体采样阶段、退出码和缺失项线索，但不记录输出正文或任意异常字段', () => {
  const stderr = 'du: cannot access /owned/private-fixture: No such file or directory\n'
  const result = measurementFailureDetail('volume-size', Object.assign(new Error('secret error message'), {
    code: 1,
    stderr,
    stdout: 'secret stdout',
    privateToken: 'secret token',
  }))
  expect(result.stage).toBe('volume-size')
  expect(result.reason).toBe('command-failed')
  expect(result.exitCode).toBe(1)
  expect(result.stderr.bytes).toBe(Buffer.byteLength(stderr))
  expect(result.stderr.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.stderr.mentionsMissingEntry).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/private-fixture|secret|cannot access/)
})

it('超时、信号及已知解析错误可以区分，不能把采样失败写成容量超限', () => {
  const timed = measurementFailureDetail('container-stats', Object.assign(new Error('hidden'), { code: 'ETIMEDOUT', signal: 'SIGKILL', killed: true }))
  expect(timed).toMatchObject({ stage: 'container-stats', reason: 'command-failed', errorCode: 'ETIMEDOUT', signal: 'SIGKILL', killed: true })
  expect(measurementFailureDetail('volume-size', new Error('linux-volume-measurement')).reason).toBe('linux-volume-measurement')
  expect(measurementFailureDetail('container-size', { name: 'ZodError' }).reason).toBe('output-schema-invalid')
  expect(measurementFailureDetail('budget', new Error('environment-budget')).reason).toBe('environment-budget')
})

it('退出零但有 stderr 仍留下线索，超大或未知字段只保留有界摘要', () => {
  const result = measurementFailureDetail('scratch-size', Object.assign(new Error('linux-measurement-stderr'), {
    stderr: 'Permission denied\n',
    code: 'UNTRUSTED_SECRET',
    signal: 'UNTRUSTED_SIGNAL',
    stdout: 'x'.repeat(100_000),
  }))
  expect(result).toMatchObject({ reason: 'linux-measurement-stderr', errorCode: null, signal: null })
  expect(result.stderr.mentionsPermissionDenied).toBe(true)
  expect(result.stdout).toMatchObject({ bytes: 100_000, hashedBytes: 65536, truncated: true })
  expect(JSON.stringify(result).length).toBeLessThan(1500)
  expect(JSON.stringify(result)).not.toContain('UNTRUSTED')
})

it.each([false, true])('诊断写入失败（%s）也必须停止，本轮不因取证问题继续跑', (writeFails) => {
  const events: string[] = []
  const saved = recordMeasurementFailure('daemon', new Error('linux-daemon-changed'), () => {
    events.push('write')
    if (writeFails)
      throw new Error('disk unavailable')
  }, () => { events.push('stop') })
  expect(saved).toBe(!writeFails)
  expect(events).toEqual(['write', 'stop'])
})

it('真实采样子进程正常退出时仍返回原来的去空白输出', async () => {
  expect(await measurementCommand(process.execPath, ['-e', 'process.stdout.write(" 1234\\n")'])).toBe('1234')
})

it.each([0, 7])('真实采样子进程退出 %i 且有 stderr 时保留可判定元数据', async (exitCode) => {
  const script = `process.stdout.write('secret fixture output'); process.stderr.write('Permission denied: private-fixture'); process.exitCode=${exitCode}`
  await measurementCommand(process.execPath, ['-e', script]).then(() => {
    throw new Error('采样错误被错误接受')
  }, (error: unknown) => {
    const detail = measurementFailureDetail('volume-size', error)
    expect(detail).toMatchObject({
      reason: exitCode === 0 ? 'linux-measurement-stderr' : 'command-failed',
      exitCode,
      stderr: { mentionsPermissionDenied: true },
    })
    expect(detail.stdout.bytes).toBe(21)
    expect(JSON.stringify(detail)).not.toMatch(/secret|private-fixture/)
  })
})

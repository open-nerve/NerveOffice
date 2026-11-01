import type { PathLike } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { processDiagnostic } from './e2e-diagnostics.ts'
import { parseProcessStat, readProcess } from './e2e-process.ts'

// 只替换 /proc 的底层 I/O；reader、parser、错误包装均为生产实现。
interface Observation { bytes?: Buffer, uid?: number, error?: string, elapsed?: number, statError?: string, readError?: string, closeError?: string, chunk?: number }
const io = vi.hoisted(() => ({
  sequence: [] as Observation[],
  index: 0,
  now: 0,
  clock: [] as number[],
  descriptors: new Map<number, { observation: Observation, offset: number }>(),
  nextFd: 900_000,
  closed: [] as number[],
  readBytes: 0,
}))

vi.mock('node:perf_hooks', () => ({ performance: { now: () => io.clock.shift() ?? io.now } }))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  const proc = (path: PathLike) => typeof path === 'string' && /^\/proc\/\d+\/stat$/.test(path)
  function next(): Observation {
    const value = io.sequence[io.index++]
    if (value === undefined)
      throw new Error('测试 reader 超过已提供的观察序列')
    io.now += value.elapsed ?? 0
    if (value.error !== undefined)
      throw Object.assign(new Error('synthetic-private-path'), { code: value.error })
    return value
  }
  return {
    ...original,
    // 保留旧 reader 的同级边界，使 RED 在原函数体上运行，而不是 import/替身失败。
    statSync: (path: PathLike) => proc(path) ? { uid: io.sequence[io.index]?.uid ?? 501 } : original.statSync(path),
    readFileSync: (path: PathLike, encoding?: BufferEncoding) => {
      if (!proc(path))
        return encoding === undefined ? original.readFileSync(path) : original.readFileSync(path, encoding)
      const bytes = next().bytes ?? Buffer.alloc(0)
      return encoding === undefined ? bytes : bytes.toString(encoding)
    },
    openSync: (path: PathLike, flags: string | number) => {
      if (!proc(path))
        return original.openSync(path, flags)
      const observation = next()
      const fd = io.nextFd++
      io.descriptors.set(fd, { observation, offset: 0 })
      return fd
    },
    fstatSync: (fd: number) => {
      const descriptor = io.descriptors.get(fd)
      if (descriptor === undefined)
        return original.fstatSync(fd)
      if (descriptor.observation.statError !== undefined)
        throw Object.assign(new Error('synthetic-private-path'), { code: descriptor.observation.statError })
      return { uid: descriptor.observation.uid ?? 501 }
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      const descriptor = io.descriptors.get(fd)
      if (descriptor === undefined)
        return original.readSync(fd, buffer, offset, length, position)
      if (descriptor.observation.readError !== undefined)
        throw Object.assign(new Error('synthetic-private-path'), { code: descriptor.observation.readError })
      const bytes = descriptor.observation.bytes ?? Buffer.alloc(0)
      const count = bytes.copy(buffer, offset, descriptor.offset, descriptor.offset + Math.min(length, descriptor.observation.chunk ?? length))
      descriptor.offset += count
      io.readBytes += count
      return count
    },
    closeSync: (fd: number) => {
      if (!io.descriptors.has(fd))
        return original.closeSync(fd)
      const code = io.descriptors.get(fd)!.observation.closeError
      io.descriptors.delete(fd)
      io.closed.push(fd)
      if (code !== undefined)
        throw Object.assign(new Error('synthetic-private-path'), { code })
    },
  }
})

function stat(overrides: { state?: string, parent?: string, group?: string, session?: string, threads?: string, start?: string, comm?: string } = {}): Buffer {
  // Linux /proc/<pid>/stat 的全部 52 项；第 3 项 state 之后均为数字。
  const fields = Array.from<string>({ length: 50 }).fill('0')
  fields[0] = overrides.state ?? 'S'
  fields[1] = overrides.parent ?? '400'
  fields[2] = overrides.group ?? '421'
  fields[3] = overrides.session ?? '421'
  fields[5] = '-1'
  fields[15] = '20'
  fields[17] = overrides.threads ?? '1'
  fields[19] = overrides.start ?? '987654'
  return Buffer.from(`421 (${overrides.comm ?? 'worker (a)'}) ${fields.join(' ')}\n`)
}
function sentinel(): Buffer {
  return stat({ parent: '0', group: '-1', session: '-1', threads: '0' })
}
function failure(action: () => unknown): ReturnType<typeof processDiagnostic> {
  try {
    action()
  }
  catch (error) { return processDiagnostic(error) }
  throw new Error('预期 reader 拒绝，实际返回成功')
}

beforeEach(() => {
  io.sequence = []
  io.index = 0
  io.now = 0
  io.clock = []
  io.closed = []
  io.readBytes = 0
  io.descriptors.clear()
})
afterEach(() => {
  expect(io.descriptors.size).toBe(0)
})

describe('Linux stat 退出消歧：真实 reader 与可控内核 I/O', () => {
  it.each(['ENOENT', 'ESRCH'])('exit_sentinel_then_absent：后续 %s 才证明消失', (code) => {
    io.sequence = [{ bytes: sentinel() }, { error: code }]
    expect(readProcess(421, 501)).toBeUndefined()
    expect(io.index).toBe(2)
  })

  it('exit_sentinel_then_valid_identity：只返回后续完整身份，不继承旧启动 tick', () => {
    io.sequence = [{ bytes: sentinel() }, { bytes: stat({ group: '700', start: '987999' }) }]
    expect(readProcess(421, 501)).toEqual({ pid: 421, uid: 501, parent: 400, group: 700, start: '987999', state: 'S' })
  })

  it('persistent_sentinel_blocks：三次仍未知，不能转换成空扫描', () => {
    io.sequence = Array.from({ length: 3 }, () => ({ bytes: sentinel() }))
    expect(failure(() => readProcess(421, 501))).toMatchObject({ operation: 'parse-process', code: 'UNKNOWN', stat: { reason: 'exit-unresolved' } })
    expect(io.index).toBe(3)
  })

  it.each(['?', 'Q'])('invalid_state_and_group_zero_block：零组不能绕过坏状态 %s', (state) => {
    io.sequence = [{ bytes: stat({ group: '0', state }) }]
    expect(() => readProcess(421, 501)).toThrow()
  })

  it('budget_does_not_restart：哨兵之后多次观察共用一个截止时间', () => {
    io.sequence = [{ bytes: sentinel() }, { bytes: sentinel(), elapsed: 20 }, { bytes: stat(), elapsed: 5 }]
    expect(failure(() => readProcess(421, 501))).toMatchObject({ stat: { reason: 'observation-deadline' } })
    expect(io.index).toBe(3)
  })

  it('diagnostic_does_not_expose_comm：坏记录只导出脱敏数字字段与原字节摘要', () => {
    const bytes = stat({ state: '?', comm: 'synthetic-secret-token' })
    io.sequence = [{ bytes }]
    const diagnostic = failure(() => readProcess(421, 501))
    expect(diagnostic).toMatchObject({ operation: 'parse-process', pid: 421, stat: {
      reason: 'invalid-state',
      observations: [{ sha256: createHash('sha256').update(bytes).digest('hex'), state: 'invalid', bytes: bytes.length }],
    } })
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-secret-token')
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(2048)
  })

  it('正常首次读取不受新消歧窗口影响，首次哨兵之后才开始计时', () => {
    io.sequence = [{ bytes: stat(), elapsed: 100 }]
    expect(readProcess(421, 501)?.start).toBe('987654')
    io.sequence.push({ bytes: sentinel(), elapsed: 100 }, { bytes: stat({ start: '999' }), elapsed: 24 })
    expect(readProcess(421, 501)?.start).toBe('999')
    expect(io.index).toBe(3)
  })

  it.each(['ENOENT', 'ESRCH'])('消歧后续 %s 在截止时返回也不能当消失', (error) => {
    io.sequence = [{ bytes: sentinel() }, { error, elapsed: 25 }]
    expect(failure(() => readProcess(421, 501))).toMatchObject({ stat: { reason: 'observation-deadline' } })
    expect(io.index).toBe(2)
  })

  it('观察前已到截止就拒绝，不继续打开第二个 stat', () => {
    io.sequence = [{ bytes: sentinel() }]
    io.clock = [0, 25]
    expect(failure(() => readProcess(421, 501))).toMatchObject({ stat: { reason: 'observation-deadline' } })
    expect(io.index).toBe(1)
  })

  it.each([
    { group: '-2' },
    { group: '-1', session: '421', parent: '0', threads: '0' },
    { group: '-1', session: '-1', parent: '400', threads: '0' },
    { group: '-1', session: '-1', parent: '0', threads: '1' },
    { session: '-1' },
    { group: '0', start: 'not-a-tick' },
    { group: '0', parent: '-1' },
    { group: '0', threads: '-1' },
  ])('非精确负形态或零组坏字段拒绝，不尝试重读：%j', (fields) => {
    io.sequence = [{ bytes: stat(fields) }]
    expect(() => readProcess(421, 501)).toThrow()
    expect(io.index).toBe(1)
  })

  it('完整零组内核记录仍过滤，损坏结构及 PID 不符不能过滤', () => {
    expect(parseProcessStat(stat({ group: '0' }), 501, 421)).toBeUndefined()
    const bytes = stat({ group: '0' })
    expect(() => parseProcessStat(bytes.subarray(0, bytes.length - 3), 501, 421)).toThrow()
    expect(() => parseProcessStat(bytes, 501, 422)).toThrow()
    expect(() => parseProcessStat(sentinel(), 501, 421)).toThrow()
  })

  it('PID 内容必须匹配打开路径，不能把其他完整身份借给本 PID', () => {
    io.sequence = [{ bytes: Buffer.from(stat().toString().replace(/^421 /, '422 ')) }]
    expect(failure(() => readProcess(421, 501))).toMatchObject({ pid: 421, stat: { reason: 'pid-mismatch', observations: [{ pid: 422, pidMatches: false }] } })
  })

  it('复用 PID 后按同一 FD 的新 UID 过滤，不沿用旧 UID；无 UID 筛选时返回新完整身份', () => {
    io.sequence = [{ bytes: sentinel() }, { bytes: stat(), uid: 502 }]
    expect(readProcess(421, 501)).toBeUndefined()
    expect(io.readBytes).toBe(sentinel().length)
    io.sequence.push({ bytes: stat({ start: '999' }), uid: 502 })
    expect(readProcess(421)).toMatchObject({ pid: 421, uid: 502, start: '999' })
    expect(io.closed).toHaveLength(3)
  })

  it('短读仍从同一 FD 取完整身份，comm 非 UTF-8 与换行括号不影响尾部', () => {
    const bytes = Buffer.concat([Buffer.from('421 (worker\n('), Buffer.from([0xFF, 0x80]), Buffer.from(') )'), stat().subarray(stat().lastIndexOf(0x29) + 1)])
    io.sequence = [{ bytes, chunk: 7 }]
    expect(readProcess(421, 501)).toEqual({ pid: 421, uid: 501, parent: 400, group: 421, start: '987654', state: 'S' })
    expect(io.closed).toHaveLength(1)
    expect(io.readBytes).toBe(bytes.length)
  })

  it('非 ASCII 尾部不能在解码时变成合法身份字段', () => {
    const bytes = stat()
    bytes[0] = 0xB4 // latin1 的 0xb4 不能以 ascii 解码冒充字符 4。
    expect(() => parseProcessStat(bytes, 501, 421)).toThrow()
  })

  it('NUL comm 与超过内核整数范围的尾字段不能伪装成完整记录', () => {
    expect(() => parseProcessStat(stat({ comm: 'bad\0name' }), 501, 421)).toThrow()
    const bytes = stat().toString().replace(/ 0\n$/, ' 99999999999999999999\n')
    expect(() => parseProcessStat(bytes, 501, 421)).toThrow()
  })

  it('记录上限允许完整 4096 B；超限只读 4097 B 且摘要明确是 overflow 前缀', () => {
    const original = stat({ comm: '' })
    const valid = stat({ comm: 'x'.repeat(4096 - original.length) })
    io.sequence = [{ bytes: valid }]
    expect(readProcess(421, 501)?.pid).toBe(421)
    expect(io.readBytes).toBe(4096)
    const oversized = Buffer.concat([valid, Buffer.alloc(16_384, 120)])
    io.sequence.push({ bytes: oversized })
    const diagnostic = failure(() => readProcess(421, 501))
    expect(diagnostic).toMatchObject({ stat: { reason: 'record-too-large', observations: [{ bytes: 4097, overflow: true, sha256: createHash('sha256').update(oversized.subarray(0, 4097)).digest('hex') }] } })
    expect(io.readBytes).toBe(4096 + 4097)
    expect(io.closed).toHaveLength(2)
  })

  it.each([
    ['open-process', { error: 'EACCES' }],
    ['stat-process', { bytes: stat(), statError: 'EIO' }],
    ['read-process', { bytes: stat(), readError: 'EIO' }],
    ['close-process', { bytes: stat(), closeError: 'ENOENT' }],
  ] as const)('%s 的 I/O 故障阻断，已打开 FD 都进入关闭路径', (operation, observation) => {
    io.sequence = [observation]
    expect(failure(() => readProcess(421, 501))).toMatchObject({ operation, code: 'error' in observation ? 'EACCES' : 'closeError' in observation ? 'ENOENT' : 'EIO' })
    expect(io.closed).toHaveLength(operation === 'open-process' ? 0 : 1)
  })

  it('解析失败关闭 FD；后续 I/O 失败不能掩盖已观察的退出形态', () => {
    io.sequence = [{ bytes: sentinel() }, { readError: 'EIO' }]
    expect(failure(() => readProcess(421, 501))).toMatchObject({ operation: 'read-process', code: 'EIO', stat: { reason: 'observation-io', observations: [{ group: -1, session: -1, threads: 0 }] } })
    expect(io.closed).toHaveLength(2)
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])('无效请求 PID %s 在 I/O 前被拒绝', (pid) => {
    expect(failure(() => readProcess(pid, 501))).toMatchObject({ stat: { reason: 'invalid-identity' } })
    expect(io.index).toBe(0)
  })
})

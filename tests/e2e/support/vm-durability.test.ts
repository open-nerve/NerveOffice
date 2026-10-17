import { describe, expect, it, vi } from 'vitest'
import { createVmDurabilityRound, isVmFrozenReceipt } from './vm-durability.ts'

const RUN = '7f1f40c3-1579-4657-9902-9f1f804fdde1'
const FIRST = '8f1f40c3-1579-4657-9902-9f1f804fdde1'
const NEXT = '9f1f40c3-1579-4657-9902-9f1f804fdde1'
const hash = (seq: number): string => seq.toString(16).padStart(64, '0')
const before = { resourceId: RUN, pid: 1234, uid: 501, startedAt: 'first', guestBootId: 'guest-first', disk: { path: '/owned/disk.img', device: 1, inode: 9 } }
const after = { ...before, pid: 1235, startedAt: 'second', guestBootId: 'guest-second' }
const proof = () => ({ before, after, signal: 'SIGKILL' as const, exited: true as const })
const boot = (bootId = FIRST) => ({ kind: 'boot', runId: RUN, bootId })
const completed = (seq: number) => ({ ...boot(), kind: 'completed', requested: 'strict', actual: 'strict', seq, digest: hash(seq), completedAt: 100 + seq })
const read = (seq = 10) => ({ ...boot(NEXT), kind: 'read', record: { runId: RUN, requested: 'strict', actual: 'strict', seq, digest: hash(seq), bodyDigest: hash(seq) } })

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(options: { append?: (value: unknown) => Promise<void>, mode?: 'vm-power-cut' | 'reload-calibration' | 'control' } = {}) {
  const journal: unknown[] = []
  const append = options.append ?? (async (value: unknown) => {
    journal.push(structuredClone(value))
  })
  const round = createVmDurabilityRound({ runId: RUN, durability: 'strict', cutAtSeq: 10, digestFor: hash, append, mode: options.mode ?? 'vm-power-cut', before, now: () => 200 })
  return { round, journal }
}

async function ready(options: Parameters<typeof setup>[0] = {}) {
  const h = setup(options)
  expect(await h.round.receive(boot())).toEqual({ kind: 'write' })
  for (let seq = 1; seq <= 10; seq += 1)
    expect(await h.round.receive(completed(seq))).toEqual({ kind: seq === 10 ? 'wait' : 'write' })
  return h
}

describe('VM 完成证据：宿主落档、冻结与实际重启', () => {
  it('完整冻结与重启后回读通过；快照修改和伪造对象不能授予信号资格', async () => {
    const { round, journal } = await ready()
    const frozen = await round.freeze()
    expect(frozen).toMatchObject({ runId: RUN, mode: 'vm-power-cut', completed: { seq: 10 }, before })
    expect(isVmFrozenReceipt(frozen)).toBe(true)
    expect(isVmFrozenReceipt(structuredClone(frozen))).toBe(false)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(journal.at(-1)).toMatchObject({ kind: 'frozen', completed: { seq: 10 } })
    expect(await round.beginRecovery(proof())).toBe(true)
    expect(await round.receive(boot(NEXT))).toEqual({ kind: 'read' })
    expect(await round.receive(read())).toEqual({ kind: 'done' })
    expect(round.snapshot()).toMatchObject({ phase: 'passed', mode: 'vm-power-cut', completed: { seq: 10 }, recovered: { record: { seq: 10 } } })
    const copy = round.snapshot()
    copy.problems.push('外部修改')
    expect(round.snapshot().problems).toEqual([])
  })

  it('末次完成的 fsync 未结束之前没有冻结凭证，冻结本身也须落档', async () => {
    const last = deferred()
    const freeze = deferred()
    const entered = deferred()
    const append = vi.fn(async (value: unknown) => {
      const event = value as { kind: string, completed?: { seq: number } }
      if (event.kind === 'completed' && event.completed?.seq === 10) {
        entered.resolve()
        await last.promise
      }
      if (event.kind === 'frozen')
        await freeze.promise
    })
    const { round } = setup({ append })
    await round.receive(boot())
    for (let seq = 1; seq < 10; seq += 1)
      await round.receive(completed(seq))
    const pending = round.receive(completed(10))
    await entered.promise
    let receipt: unknown
    const frozen = round.freeze().then((value) => {
      receipt = value
    })
    expect(receipt).toBeUndefined()
    expect(round.snapshot()).toMatchObject({ completed: { seq: 9 } })
    last.resolve()
    await pending
    await vi.waitFor(() => expect(append).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'frozen' })))
    expect(receipt).toBeUndefined()
    freeze.resolve()
    await frozen
    expect(isVmFrozenReceipt(receipt)).toBe(true)
  })

  it.each(['completed', 'frozen'])('写 %s journal 失败不能给 VM 信号资格', async (failOn) => {
    const append = async (value: unknown): Promise<void> => {
      if ((value as { kind: string }).kind === failOn)
        throw new Error('本机空间不足')
    }
    const { round } = setup({ append })
    await round.receive(boot())
    for (let seq = 1; seq <= 10; seq += 1)
      await round.receive(completed(seq))
    expect(await round.freeze()).toBeUndefined()
    expect(round.snapshot().phase).toBe('failed')
    expect(await round.beginRecovery(proof())).toBe(false)
  })

  it.each([
    { runId: NEXT },
    { bootId: NEXT },
    { digest: hash(99) },
    { seq: 0 },
    { seq: 2 },
    { actual: 'default' },
    { requested: 'default' },
    { completedAt: Number.NaN },
    { secret: '不得留档' },
  ])('错误的完成证据不会进入已确认序号：%j', async (change) => {
    const { round, journal } = setup()
    await round.receive(boot())
    expect(await round.receive({ ...completed(1), ...change })).toEqual({ kind: 'stop' })
    expect(round.snapshot().completed).toBeUndefined()
    expect(await round.freeze()).toBeUndefined()
    expect(JSON.stringify(journal)).not.toContain('不得留档')
  })

  it('重放完成与冻结后迟到报告不改最后完成记录', async () => {
    const { round } = setup()
    await round.receive(boot())
    await round.receive(completed(1))
    expect(await round.receive(completed(1))).toEqual({ kind: 'stop' })
    const h = await ready()
    const receipt = await h.round.freeze()
    expect(await h.round.receive(completed(11))).toEqual({ kind: 'stop' })
    expect(await h.round.receive(boot())).toEqual({ kind: 'stop' })
    expect(h.round.snapshot().completed?.seq).toBe(10)
    expect(await h.round.freeze()).toBe(receipt)
  })

  it.each([
    { signal: 'SIGTERM' },
    { exited: false },
    { before: { ...before, pid: 9999 } },
    { after: { ...after, guestBootId: before.guestBootId } },
    { after: { ...after, pid: before.pid } },
    { after: { ...after, resourceId: NEXT } },
    { after: { ...after, disk: { ...before.disk, inode: 10 } } },
    { after: { ...after, disk: { ...before.disk, path: '/different/disk.img' } } },
  ])('不把非真实突停或不同磁盘当成重启：%j', async (change) => {
    const { round } = await ready()
    await round.freeze()
    expect(await round.beginRecovery({ ...proof(), ...change })).toBe(false)
    expect(await round.receive(boot(NEXT))).toEqual({ kind: 'stop' })
    expect(round.snapshot().phase).not.toBe('passed')
  })

  it.each([
    { record: null },
    { record: { ...read().record, seq: 9, digest: hash(9), bodyDigest: hash(9) } },
    { record: { ...read().record, bodyDigest: hash(99) } },
    { record: { ...read().record, runId: NEXT } },
    { record: { ...read().record, requested: 'default' } },
  ])('回读缺失、回退或内容不符记录为丢失/损坏：%j', async (change) => {
    const { round } = await ready()
    await round.freeze()
    await round.beginRecovery(proof())
    await round.receive(boot(NEXT))
    expect(await round.receive({ ...read(), ...change })).toEqual({ kind: 'stop' })
    expect(round.snapshot().phase).toBe('lost')
  })

  it('更高的未报告序号可保留，但也须验证其确定性正文', async () => {
    const { round } = await ready()
    await round.freeze()
    await round.beginRecovery(proof())
    await round.receive(boot(NEXT))
    expect(await round.receive(read(11))).toEqual({ kind: 'done' })
    expect(round.snapshot()).toMatchObject({ phase: 'passed', completed: { seq: 10 }, recovered: { record: { seq: 11 } } })
  })

  it('浏览器读取异常单独记为 unreadable，不能混成协议错误、丢失或通过', async () => {
    const { round, journal } = await ready()
    await round.freeze()
    await round.beginRecovery(proof())
    await round.receive(boot(NEXT))
    const failure = { ...boot(NEXT), kind: 'failed', stage: 'read-transaction', errorName: 'UnknownError' }
    expect(await round.receive(failure)).toEqual({ kind: 'stop' })
    expect(round.snapshot()).toMatchObject({ phase: 'unreadable', readFailure: failure, completed: { seq: 10 } })
    expect(journal.at(-1)).toMatchObject({ kind: 'page-failure', failure })
    expect(await round.receive(read())).toEqual({ kind: 'stop' })
    expect(round.snapshot().phase).toBe('unreadable')
  })

  it.each([
    { stage: 'unknown' },
    { errorName: '不得留档' },
    { secret: '不得留档' },
  ])('错误报告也必须严格校验，不保留额外或未知内容：%j', async (change) => {
    const { round, journal } = await ready()
    await round.freeze()
    await round.beginRecovery(proof())
    await round.receive(boot(NEXT))
    await round.receive({ ...boot(NEXT), kind: 'failed', stage: 'read-transaction', errorName: 'UnknownError', ...change })
    expect(round.snapshot().phase).toBe('failed')
    expect(JSON.stringify([journal, round.snapshot()])).not.toContain('不得留档')
  })

  it('控制网络或写入失败不能归到存储无法读取', async () => {
    const { round } = setup()
    await round.receive(boot())
    await round.receive({ ...boot(), kind: 'failed', stage: 'write-transaction', errorName: 'QuotaExceededError' })
    expect(round.snapshot()).toMatchObject({ phase: 'failed', readFailure: undefined })
    expect(await round.freeze()).toBeUndefined()
  })

  it.each(['control', 'reload-calibration'] as const)('%s 不签发真实 VM 信号资格，也不能接收 VM 停止证明', async (mode) => {
    const { round } = await ready({ mode })
    const frozen = await round.freeze()
    expect(isVmFrozenReceipt(frozen)).toBe(false)
    expect(await round.beginRecovery(proof())).toBe(false)
    expect(await round.beginCalibrationRecovery()).toBe(true)
    expect(await round.receive(boot(NEXT))).toEqual({ kind: 'read' })
    expect(await round.receive(read())).toEqual({ kind: 'done' })
    expect(round.snapshot()).toMatchObject({ phase: 'passed', mode })
  })
})

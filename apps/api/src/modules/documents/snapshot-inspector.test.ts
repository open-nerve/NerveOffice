import type { FakeTask } from '../../shared/process-pool-fakes.test-support.ts'
import type { SnapshotInspectionSettings } from './snapshot-inspector.ts'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODES, sheetSnapshotFor, SNAPSHOT_RULES, snapshotInvalidDetailsSchema } from '@nerve-office/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { RELEASE_FILE, STARTED_PREFIX } from '../../shared/process-pool-fakes.test-support.ts'
import { AppLogger, createRootLogger, RequestContextStore } from '../logging/index.ts'
import { SNAPSHOT_MAX_ENTRIES } from './snapshot-checks.ts'
import { inspectSnapshot } from './snapshot-inspection.ts'
import { inspectionChildEntry, INSPECTIONS_PER_ACCOUNT, SnapshotInspector, snapshotInvalid } from './snapshot-inspector.ts'

const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
/** 发起检查的账户（检查池按账户限份数，审查 A2） */
const AMY = '0199a2c4-0000-7000-8000-00000000000a'
const BEN = '0199a2c4-0000-7000-8000-00000000000b'
const SETTINGS: SnapshotInspectionSettings = { processes: 2, queue: { maxWaiting: 8, maxWaitMs: 2_500 }, timeoutMs: 10_000, heapMb: 512 }
/** 假的子进程入口：按交来的字节（一个假任务的 JSON）做假的工作，用来核对子进程池的失败怎样换成回答 */
const FAKE_ENTRY = { script: new URL('../../shared/process-pool-fake-child.test-support.ts', import.meta.url), execArgv: [] }
const MIB = 1024 * 1024
/** 用例起真的子进程：慢机器上（CI 比本机慢几倍）加载要更久，留足余量 */
const SPAWNING = { timeout: 30_000 }

const inspectors: SnapshotInspector[] = []
const gates: string[] = []

function setup(settings: Partial<SnapshotInspectionSettings> = {}, entry = inspectionChildEntry()) {
  const warn = vi.spyOn(AppLogger.prototype, 'warn')
  const error = vi.spyOn(AppLogger.prototype, 'error')
  const logger = new AppLogger(createRootLogger({ level: 'silent' }), new RequestContextStore())
  const inspector = new SnapshotInspector({ ...SETTINGS, ...settings }, logger, entry)
  inspectors.push(inspector)
  return { inspector, warn, error }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of gates)
    writeFileSync(join(directory, RELEASE_FILE), '')
  await Promise.all(inspectors.splice(0).map(async inspector => inspector.onApplicationShutdown()))
  for (const directory of gates.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** 跨进程的闸门（与 process-pool.test.ts 相同）：挡住的假任务在目录里放 started-<pid>，出现 release 文件之后放行 */
function gate(): { readonly directory: string, readonly started: () => number, readonly release: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-inspector-gate-'))
  gates.push(directory)
  return {
    directory,
    started: () => readdirSync(directory).filter(name => name.startsWith(STARTED_PREFIX)).length,
    release: () => writeFileSync(join(directory, RELEASE_FILE), ''),
  }
}

function fake(task: FakeTask): Buffer {
  return Buffer.from(JSON.stringify(task), 'utf8')
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof AppError))
    throw new Error(`期望 AppError，得到 ${String(error)}`)
  return error
}

describe('SnapshotInspector：在子进程里检查（源码运行：入口是 .ts，按源码条件解析 contracts）', SPAWNING, () => {
  it('模板通过，结果与在主进程里检查的相同（哈希是 32 字节的 Uint8Array）；子进程按需创建', async () => {
    const { inspector } = setup()
    expect(inspector.liveProcesses).toBe(0)
    const raw = Buffer.from(sheetSnapshotFor(UNIT_ID), 'utf8')
    const outcome = await inspector.inspect(raw, 'sheet@1', AMY)
    expect(outcome).toEqual(inspectSnapshot(raw, 'sheet@1'))
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.contentHash).toBeInstanceOf(Uint8Array)
    expect(outcome.ok && outcome.contentHash.byteLength).toBe(32)
    expect(inspector.liveProcesses).toBe(1)
  })

  it('不合格的快照给出规则；极深的嵌套在子进程里按规则拒绝', async () => {
    const { inspector } = setup()
    expect(await inspector.inspect(Buffer.from('{"id":"x","sheetOrder":["a"],"sheets":{}}'), 'sheet@1', AMY)).toEqual({ ok: false, rule: 'structure' })
    expect(await inspector.inspect(Buffer.from(`{"a":${'['.repeat(300_000)}${']'.repeat(300_000)}}`), 'sheet@1', AMY)).toEqual({ ok: false, rule: 'depth' })
  })

  it('多份同时提交（各是不同的人）：每份各自得到自己的结果', async () => {
    const { inspector } = setup({ processes: 2 })
    const raws = ['a', 'b', 'c', 'd', 'e'].map(suffix => Buffer.from(sheetSnapshotFor(`${UNIT_ID.slice(0, -1)}${suffix}`), 'utf8'))
    const outcomes = await Promise.all(raws.map(async (raw, index) => inspector.inspect(raw, 'sheet@1', `account-${index}`)))
    expect(outcomes.map(outcome => (outcome.ok ? outcome.unitId : outcome.rule))).toEqual(['a', 'b', 'c', 'd', 'e'].map(suffix => `${UNIT_ID.slice(0, -1)}${suffix}`))
    expect(inspector.liveProcesses).toBeLessThanOrEqual(2)
  })

  it('在工作线程上让整个进程中止的形状（数量上限之内的空对象，JSON.parse 里撞上堆上限）：只结束子进程，这份按 too-complex 拒绝，之后照常检查', async () => {
    // S3 实测：堆上限 64 MiB 的工作线程解析它时 Node 结束不了线程，整个进程以 SIGABRT 退出
    const { inspector, warn } = setup({ processes: 1, heapMb: 64 })
    const objects = Buffer.from(`{"id":"${UNIT_ID}","sheetOrder":[],"sheets":{},"resources":[],"a":[${Array.from({ length: SNAPSHOT_MAX_ENTRIES - 64 }).fill('{}').join(',')}]}`, 'utf8')
    expect(await inspector.inspect(objects, 'sheet@1', AMY)).toEqual({ ok: false, rule: 'too-complex' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too-complex'), { rawBytes: objects.byteLength })
    const raw = Buffer.from(sheetSnapshotFor(UNIT_ID), 'utf8')
    expect(await inspector.inspect(raw, 'sheet@1', AMY)).toEqual(inspectSnapshot(raw, 'sheet@1'))
  })
})

describe('子进程的入口', () => {
  it('与这个模块同一个目录、同一个扩展名：源码运行时是 .ts 并按源码条件解析，构建产物里是 .js', () => {
    expect(inspectionChildEntry('file:///app/src/modules/documents/snapshot-inspector.ts')).toEqual({
      script: new URL('file:///app/src/modules/documents/snapshot-inspection.child.ts'),
      execArgv: ['--conditions=@nerve-office/source'],
    })
    expect(inspectionChildEntry('file:///app/dist/modules/documents/snapshot-inspector.js?v=1')).toEqual({
      script: new URL('file:///app/dist/modules/documents/snapshot-inspection.child.js'),
      execArgv: [],
    })
  })

  it('入口不存在时建不起来（启动即失败），不退回主进程', () => {
    expect(() => setup({}, { script: new URL('./missing.child.ts', import.meta.url), execArgv: [] })).toThrow(/子进程入口不存在/)
  })
})

describe('子进程池没有给出结果时的回答', SPAWNING, () => {
  it('子进程的堆超过上限：这份快照按 too-complex 拒绝（记 warn），子进程被结束', async () => {
    const { inspector, warn } = setup({ processes: 1, heapMb: 64 }, FAKE_ENTRY)
    // 配置的堆上限确实加在子进程上（老生代 64 MiB，加上新生代）
    const limit = await inspector.inspect(fake({ kind: 'heap-limit' }), 'sheet@1', AMY) as unknown as number
    expect(limit).toBeGreaterThanOrEqual(64 * MIB)
    expect(limit).toBeLessThanOrEqual(128 * MIB)
    expect(await inspector.inspect(fake({ kind: 'allocate' }), 'sheet@1', AMY)).toEqual({ ok: false, rule: 'too-complex' })
    const [message, fields] = warn.mock.calls[0] ?? []
    expect(message).toContain('too-complex')
    expect(fields?.rawBytes).toBe(JSON.stringify({ kind: 'allocate' }).length)
    expect(inspector.liveProcesses).toBe(0)
  })

  it('子进程在检查期间被系统结束（SIGKILL，多半是容器的内存用尽、内核的 OOM killer，审查 A4）：这份按 too-complex 拒绝（不回 503：同一份重发多半还是这样），记 error、指向部署说明的内存规则；之后照常检查', async () => {
    const { inspector, error: logged } = setup({ processes: 1 }, FAKE_ENTRY)
    const task = fake({ kind: 'sigkill' })
    expect(await inspector.inspect(task, 'sheet@1', AMY)).toEqual({ ok: false, rule: 'too-complex' })
    const [message, fields] = logged.mock.calls[0] ?? []
    expect(message).toContain('多半是容器的内存不够')
    expect(message).toContain('部署说明')
    expect(fields?.rawBytes).toBe(task.byteLength)
    expect((fields?.err as { reason?: string } | undefined)?.reason).toBe('killed')
    expect(inspector.liveProcesses).toBe(0)
    expect(await inspector.inspect(fake({ kind: 'echo', value: 'next' }), 'sheet@1', AMY)).toBe('next')
  })

  it('排队满了：503 带 Retry-After（排队等待的时限，向上取整到秒）', async () => {
    const { inspector } = setup({ processes: 1, queue: { maxWaiting: 0, maxWaitMs: 2_500 } }, FAKE_ENTRY)
    const running = inspector.inspect(fake({ kind: 'spin' }), 'sheet@1', AMY).catch((error: unknown) => error)
    await vi.waitFor(() => expect(inspector.liveProcesses).toBe(1))
    const error = await rejection(inspector.inspect(fake({ kind: 'echo', value: 1 }), 'sheet@1', AMY))
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.status).toBe(ERROR_CODES.SERVICE_UNAVAILABLE.status)
    expect(error.headers).toEqual({ 'Retry-After': '3' })
    await inspector.onApplicationShutdown()
    expect(await running).toBeInstanceOf(AppError)
  })

  it('子进程出错：503 带 Retry-After，记 error（带原因）', async () => {
    const { inspector, error: logged } = setup({ processes: 1 }, FAKE_ENTRY)
    const error = await rejection(inspector.inspect(fake({ kind: 'throw' }), 'sheet@1', AMY))
    expect(error.code).toBe('SERVICE_UNAVAILABLE')
    expect(error.headers['Retry-After']).toBe('3')
    const [message, fields] = logged.mock.calls[0] ?? []
    expect(message).toContain('子进程出错')
    expect(fields?.err).toBeInstanceOf(Error)
  })

  it('子进程意外退出：503，记 error（cause 带退出码）', async () => {
    const { inspector, error: logged } = setup({ processes: 1 }, FAKE_ENTRY)
    expect((await rejection(inspector.inspect(fake({ kind: 'exit' }), 'sheet@1', AMY))).code).toBe('SERVICE_UNAVAILABLE')
    const [, fields] = logged.mock.calls[0] ?? []
    expect(((fields?.err as Error).cause as { exitCode: number }).exitCode).toBe(3)
  })

  it('超过时限：503，记 warn；下一份照常检查', async () => {
    // 时限从交给加载好的子进程算起；加载另有同样的时限，留足慢机器上加载的余量
    const { inspector, warn } = setup({ processes: 1, timeoutMs: 2_000 }, FAKE_ENTRY)
    expect((await rejection(inspector.inspect(fake({ kind: 'spin' }), 'sheet@1', AMY))).code).toBe('SERVICE_UNAVAILABLE')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('超过时限'), expect.anything())
    expect(await inspector.inspect(fake({ kind: 'echo', value: 'next' }), 'sheet@1', AMY)).toBe('next')
  })

  it('应用退出：子进程都结束，之后的检查 503', async () => {
    const { inspector } = setup()
    await inspector.inspect(Buffer.from(sheetSnapshotFor(UNIT_ID), 'utf8'), 'sheet@1', AMY)
    await inspector.onApplicationShutdown()
    expect(inspector.liveProcesses).toBe(0)
    expect((await rejection(inspector.inspect(Buffer.from('{}'), 'sheet@1', AMY))).code).toBe('SERVICE_UNAVAILABLE')
  })

  it('Retry-After 至少 1 秒', async () => {
    const { inspector } = setup({ processes: 1, queue: { maxWaiting: 0, maxWaitMs: 100 } }, FAKE_ENTRY)
    void inspector.inspect(fake({ kind: 'spin' }), 'sheet@1', AMY).catch(() => undefined)
    await vi.waitFor(() => expect(inspector.liveProcesses).toBe(1))
    expect((await rejection(inspector.inspect(fake({ kind: 'echo', value: 1 }), 'sheet@1', AMY))).headers).toEqual({ 'Retry-After': '1' })
  })
})

describe('同一个账户在检查池里的份数（审查 A2）', SPAWNING, () => {
  it(`一个人在执行与排队里合计至多 ${INSPECTIONS_PER_ACCOUNT} 份：多出来的立即 503（带 Retry-After，记 warn），不进池子；别人照常排进来、拿到结果；有了结果就交回份数`, async () => {
    expect(INSPECTIONS_PER_ACCOUNT).toBe(2)
    // 一个子进程、排队 8 个：艾米的两份一份在执行、一份在排队，都挡在闸门上
    const { inspector, warn } = setup({ processes: 1, queue: { maxWaiting: 8, maxWaitMs: 2_500 } }, FAKE_ENTRY)
    const blocking = gate()
    const held = [inspector.inspect(fake({ kind: 'block', gate: blocking.directory }), 'sheet@1', AMY), inspector.inspect(fake({ kind: 'block', gate: blocking.directory }), 'sheet@1', AMY)]
    await vi.waitFor(() => expect(blocking.started()).toBe(1))
    // 第三份：只对艾米 503，立即（不等排队的时限），与池子繁忙同一个回答
    const started = performance.now()
    const error = await rejection(inspector.inspect(fake({ kind: 'echo', value: 'third' }), 'sheet@1', AMY))
    expect([error.code, error.status, error.headers]).toEqual(['SERVICE_UNAVAILABLE', ERROR_CODES.SERVICE_UNAVAILABLE.status, { 'Retry-After': '3' }])
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('份数已满'), { limit: INSPECTIONS_PER_ACCOUNT, rawBytes: fake({ kind: 'echo', value: 'third' }).byteLength })
    // 别人照常排进来：本的这一份排在艾米的两份之后，放开之后拿到自己的结果
    const bens = inspector.inspect(fake({ kind: 'echo', value: 'ben' }), 'sheet@1', BEN)
    blocking.release()
    expect(await Promise.all(held)).toEqual(['released', 'released'])
    expect(await bens).toBe('ben')
    // 有了结果就交回份数：艾米又能提交两份
    expect(await Promise.all([inspector.inspect(fake({ kind: 'echo', value: 1 }), 'sheet@1', AMY), inspector.inspect(fake({ kind: 'echo', value: 2 }), 'sheet@1', AMY)])).toEqual([1, 2])
  })

  it('没有通过的（子进程出错、退出、堆超限、被系统结束）同样交回份数：之后这个人照常同时提交两份', async () => {
    // 交回在 finally 里，与结局无关；超过时限的那一种不在这里（加载另有同样的时限，负载高时会把别的结局也变成超时），见上面"超过时限"
    const { inspector } = setup({ processes: 1, heapMb: 64 }, FAKE_ENTRY)
    for (const task of [{ kind: 'throw' }, { kind: 'exit' }] as const)
      expect((await rejection(inspector.inspect(fake(task), 'sheet@1', AMY))).code).toBe('SERVICE_UNAVAILABLE')
    for (const task of [{ kind: 'allocate' }, { kind: 'sigkill' }] as const)
      expect(await inspector.inspect(fake(task), 'sheet@1', AMY)).toEqual({ ok: false, rule: 'too-complex' })
    expect(await Promise.all([inspector.inspect(fake({ kind: 'echo', value: 'a' }), 'sheet@1', AMY), inspector.inspect(fake({ kind: 'echo', value: 'b' }), 'sheet@1', AMY)])).toEqual(['a', 'b'])
  })
})

describe('SNAPSHOT_INVALID 的错误（snapshotInvalid）', () => {
  it.each(SNAPSHOT_RULES)('%s：422，details 是规则（契约能解析），说明不空', (rule) => {
    const error = snapshotInvalid(rule)
    expect(error.code).toBe('SNAPSHOT_INVALID')
    expect(error.status).toBe(422)
    expect(error.details).toEqual({ rule })
    expect(snapshotInvalidDetailsSchema.parse(error.details)).toEqual({ rule })
    expect(error.message.length).toBeGreaterThan(0)
  })

  it('三条链接的规则说法相同（页面按规则给出自己的说法）', () => {
    expect(new Set(['link-structure', 'link-address', 'link-range-id'].map(rule => snapshotInvalid(rule as 'link-address').message)).size).toBe(1)
  })
})

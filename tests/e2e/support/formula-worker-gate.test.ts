import type { FormulaWorkerGate } from './formula-worker-gate.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FORMULA_WORKER_NAME, installFormulaWorkerGate } from './formula-worker-gate.ts'

const GATE = '__testFormulaWorkerGate'

/** 页面里 Worker 的替身：只要 EventTarget 与构造参数里的 name */
class FakeWorker extends EventTarget {
  readonly name: string | undefined
  constructor(_url: string | URL, options?: WorkerOptions) {
    super()
    this.name = options?.name
  }

  /** 模拟 Worker 回包到达主线程 */
  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function setup() {
  vi.stubGlobal('Worker', FakeWorker)
  installFormulaWorkerGate({ gate: GATE, worker: FORMULA_WORKER_NAME })
  const gate = (globalThis as unknown as Record<string, FormulaWorkerGate>)[GATE]!
  const formula = new Worker('formula.js', { name: FORMULA_WORKER_NAME }) as unknown as FakeWorker
  const received: unknown[] = []
  // 应用的监听器（rpc 的 createWebWorkerMessagePortOnMain）在 Worker 建好之后才挂上
  formula.addEventListener('message', event => received.push((event as MessageEvent).data))
  return { gate, formula, received }
}

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(globalThis, GATE)
})

describe('公式 Worker 回包的闸（M5R-M-08 的确定性 E2E）', () => {
  it('没扣住时回包照常送到；扣住时截下、应用收不到，放行按原顺序送达并返回条数', () => {
    const { gate, formula, received } = setup()
    formula.reply('before')
    gate.hold()
    formula.reply('validation-1')
    formula.reply('validation-2')
    expect(received).toEqual(['before'])
    expect(gate.held()).toBe(2)
    expect(gate.release()).toBe(2)
    expect(received).toEqual(['before', 'validation-1', 'validation-2'])
    expect(gate.held()).toBe(0)
    formula.reply('after')
    expect(received).toEqual(['before', 'validation-1', 'validation-2', 'after'])
  })

  it('只管名为 nerve-formula 的 Worker；重复安装不叠加', () => {
    const { gate } = setup()
    installFormulaWorkerGate({ gate: GATE, worker: FORMULA_WORKER_NAME })
    const other = new Worker('outbox.js', { name: 'nerve-outbox' }) as unknown as FakeWorker
    const received: unknown[] = []
    other.addEventListener('message', event => received.push((event as MessageEvent).data))
    gate.hold()
    other.reply('outbox')
    expect(received).toEqual(['outbox'])
    expect(gate.held()).toBe(0)
  })
})

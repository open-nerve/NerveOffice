import type { Page } from '@playwright/test'

// 公式 Worker 回包的闸（M5R-M-08 的确定性 E2E，P7-S14）：自定义公式的“拒绝输入”校验在公式 Worker 里异步完成，撤销要赶在结果之前
// 才会取消校验任务。按键经过 CDP 一来一回，校验有时先到、弹出拒绝提示——原用例因此时过时不过（S14 本机定向 E2E 实测一次失败）。
// 这里在页面里给名为 nerve-formula 的 Worker（apps/web 的 sheet-editor.ts 创建时给的名字）抢先挂一个 message 监听器：扣住期间截下回包
// （stopImmediatePropagation，RPC 与图片策略的监听器都收不到），放行时按原顺序同步重新派发。只用于测试构建的 E2E，不改应用代码。
// 扣住期间公式计算的结果同样被截下：放行之前不要等公式结果、不要保存；编辑器就绪之前不要扣住（就绪要等 Worker 的回包）。

const GATE = '__nerveFormulaWorkerGate' as const
export const FORMULA_WORKER_NAME = 'nerve-formula'

export interface FormulaWorkerGate {
  readonly hold: () => void
  /** 放行：按原顺序重新派发截下的回包，返回条数 */
  readonly release: () => number
  /** 现在截下了多少条 */
  readonly held: () => number
}

type GateScope = typeof globalThis & { [GATE]?: FormulaWorkerGate, Worker: typeof Worker }

/** 在页面里执行（addInitScript），也供单测直接调用：不能引用外面的变量，名称经参数传入 */
export function installFormulaWorkerGate(names: { readonly gate: string, readonly worker: string }): void {
  const scope = globalThis as unknown as Record<string, unknown> & { Worker: typeof Worker }
  if (scope[names.gate] !== undefined)
    return
  const Native = scope.Worker
  const queue: { readonly target: EventTarget, readonly data: unknown }[] = []
  let holding = false
  let passing = false
  const gate: FormulaWorkerGate = {
    hold: () => {
      holding = true
    },
    release: () => {
      holding = false
      const pending = queue.splice(0)
      passing = true
      try {
        for (const { target, data } of pending)
          target.dispatchEvent(new MessageEvent('message', { data }))
      }
      finally {
        passing = false
      }
      return pending.length
    },
    held: () => queue.length,
  }
  scope[names.gate] = gate
  scope.Worker = class extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      if (options?.name !== names.worker)
        return
      // 构造时挂上：排在 RPC（rpc 的 createWebWorkerMessagePortOnMain）与图片策略的监听器之前
      this.addEventListener('message', (event) => {
        if (passing || !holding)
          return
        event.stopImmediatePropagation()
        queue.push({ target: this, data: event.data })
      })
    }
  }
}

/** 打开页面之前调用：之后每次载入都装上闸（不扣住） */
export async function addFormulaWorkerGate(page: Page): Promise<void> {
  await page.addInitScript(installFormulaWorkerGate, { gate: GATE, worker: FORMULA_WORKER_NAME })
}

async function control<T>(page: Page, action: 'hold' | 'release' | 'held'): Promise<T> {
  return page.evaluate(({ gate, action }) => {
    const installed = (globalThis as GateScope)[gate as typeof GATE]
    if (installed === undefined)
      throw new Error('公式 Worker 的闸没有装上：打开页面之前调用 addFormulaWorkerGate')
    return installed[action]()
  }, { gate: GATE, action }) as Promise<T>
}

export async function holdFormulaWorker(page: Page): Promise<void> {
  await control(page, 'hold')
}

export async function releaseFormulaWorker(page: Page): Promise<number> {
  return control(page, 'release')
}

export async function heldFormulaMessages(page: Page): Promise<number> {
  return control(page, 'held')
}

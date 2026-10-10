import type { ItemVerdict } from './probe-verdicts.ts'

/**
 * 真实浏览器复核的一步在 CI 里该有的判定（support/probe-verdicts.ts）：这一步负责的各项数据都齐（不是 missing）；与时间无关的几项（回滚、
 * IndexedDB 的基本行为、密钥交给 Worker、Web Locks）通过。与时间有关的项与持久保存、配额（非持久的上下文里 IndexedDB 在内存里）只要求数据齐
 */
const PROBE_ITEMS: Readonly<Record<string, readonly string[]>> = {
  'storage': ['1', '2', '3', '5', '6', '8'],
  'key-transfer': ['7'],
  'worker-stall': ['9'],
  'outbox-stall': ['9-production'],
  'capture-cost': ['10'],
  'outbox-pipeline': ['11'],
  'perf-baseline': ['12'],
}

const SEMANTIC_ITEMS: ReadonlySet<string> = new Set(['5', '6', '7', '8'])

/** 一步的判定的要点：各项的结论（与时间无关的几项）或者数据齐不齐 */
export function probeCalibrationSummary(scenario: string, verdicts: readonly ItemVerdict[]): unknown {
  const statusOf = (verdict: ItemVerdict): string => SEMANTIC_ITEMS.has(verdict.id) || verdict.status === 'missing' ? verdict.status : 'complete'
  return (PROBE_ITEMS[scenario] ?? []).map((id) => {
    const verdict = verdicts.find(entry => entry.id === id)
    if (verdict === undefined)
      return { id, status: '没有这一项', missing: [], lines: [] }
    const status = statusOf(verdict)
    // 说明与校准后的结论一致：小样本的数据齐全即可；语义失败与缺数据仍保留原始原因。
    return { id, status, missing: verdict.missing, lines: status === 'fail' || status === 'missing' ? verdict.lines : [] }
  })
}

export function probeCalibrationPassed(scenario: string): unknown {
  return (PROBE_ITEMS[scenario] ?? []).map(id => ({ id, status: SEMANTIC_ITEMS.has(id) ? 'pass' : 'complete', missing: [], lines: [] }))
}

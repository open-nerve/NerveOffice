export interface ProbeRecord {
  schemaVersion: 1
  runId: string
  caseId: string
  pageId: string
  buildId: string
  sdkVersion: string
  userAgent: string
  mode: 'default' | 'diagnostic'
  method: 'native-ui' | 'synthetic' | 'protocol'
  seq: number
  at: string
  type: string
  target: string
  isTrusted: boolean | null
  defaultPrevented: boolean
  types: string[]
  files: { type: string, size: number, sha256: string | null }[]
  drawingCount: number | null
  error: string | null
  details?: Record<string, unknown>
}

export interface NativeActionReceipt {
  method: 'cua'
  runId: string
  caseId: string
  pageId: string
  buildId: string
  sdkVersion: string
  userAgent: string
  mode: 'default' | 'diagnostic'
  startedAt: string
  finishedAt: string
  actionRef: string
  source: { kind: 'generated-fixture' | 'controlled-page' | 'controlled-sheet', fixtureIds: string[], proof: string }
  eventSequences: number[]
}

const identityKeys = ['runId', 'caseId', 'pageId', 'buildId', 'sdkVersion', 'userAgent', 'mode'] as const
const nativeInputTypes = new Set(['paste', 'copy', 'drop'])
const sourceKinds = new Set(['generated-fixture', 'controlled-page', 'controlled-sheet'])

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 只判断事件可否引用为原生输入证据，不判断粘贴/复制/插入成功。
 * 回执由本轮 CUA 操作生成；动作原件和样本清单仍须在汇总时逐一核验。
 */
export function nativeEvidenceOf(records: readonly unknown[], receipt: unknown): { eligible: boolean, reasons: string[] } {
  const reasons: string[] = []
  if (!object(receipt))
    return { eligible: false, reasons: ['缺少原生动作回执'] }

  if (receipt.method !== 'cua' || !nonEmpty(receipt.actionRef))
    reasons.push('缺少 CUA 原生动作引用')
  if (receipt.sdkVersion !== '1.0.1')
    reasons.push('SDK 版本不是本轮锁定的 1.0.1')
  if (identityKeys.some(key => !nonEmpty(receipt[key])) || !['default', 'diagnostic'].includes(String(receipt.mode)))
    reasons.push('动作身份不完整')

  const source = receipt.source
  if (!object(source) || !sourceKinds.has(String(source.kind)) || !nonEmpty(source.proof)
    || !Array.isArray(source.fixtureIds) || source.fixtureIds.length === 0 || !source.fixtureIds.every(nonEmpty))
    reasons.push('没有完整受控样本来源')

  const start = typeof receipt.startedAt === 'string' ? Date.parse(receipt.startedAt) : Number.NaN
  const end = typeof receipt.finishedAt === 'string' ? Date.parse(receipt.finishedAt) : Number.NaN
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    reasons.push('原生动作时间区间无效')

  const sequences = receipt.eventSequences
  if (!Array.isArray(sequences) || sequences.length === 0
    || !sequences.every(seq => Number.isSafeInteger(seq) && seq > 0)
    || new Set(sequences).size !== sequences.length) {
    reasons.push('关联的事件序号无效')
  }
  else {
    for (const seq of sequences) {
      const matching = records.filter(value => object(value) && value.seq === seq
        && identityKeys.every(key => value[key] === receipt[key]))
      if (matching.length !== 1) {
        reasons.push(`事件 ${seq} 缺失、身份不符或重复`)
        continue
      }
      const event = matching[0] as Record<string, unknown>
      if (event.schemaVersion !== 1 || event.method !== 'native-ui' || event.isTrusted !== true
        || !nativeInputTypes.has(String(event.type)))
        reasons.push(`事件 ${seq} 不是本协议的原生可信输入`)
      const at = typeof event.at === 'string' ? Date.parse(event.at) : Number.NaN
      if (!Number.isFinite(at) || at < start || at > end)
        reasons.push(`事件 ${seq} 不在动作区间内`)
    }
  }
  return { eligible: reasons.length === 0, reasons }
}

// 测试构建与宿主共用的测量事实、严格判定及最近秩统计；不引用其他模块。
export interface LocalSaveConfig {
  readonly sample: '1m' | '5m' | 'perf-50k'
  readonly network: 'online' | 'offline'
  readonly rounds: number
}

export interface LocalSaveIdentity {
  readonly userId: string
  readonly documentId: string
  readonly writeEpoch: number
  readonly writerId: string
  readonly writtenBy: string
}

export interface LocalSaveSample extends LocalSaveIdentity {
  readonly round: number
  readonly cold: boolean
  readonly wallStartedAt: number
  readonly checkedAt: number
  readonly startedAt: number
  readonly savedAt: number
  readonly localSavedMs: number
  readonly commandMs: number
  readonly formulaSettledMs: number
  readonly editorSeq: number
  readonly draftSeq: number
  readonly baseRevision: number
  readonly captureMs: number
  readonly captureAt: number
  readonly captureSeq: number
  readonly workerSentAt: number
  readonly workerReceivedAt: number
  readonly workerMs: number
  readonly workerConfirmed: boolean
  readonly rawBytes: number
  readonly snapshotHash: string
  readonly contentChecked: boolean
  readonly formulasPending: boolean
  readonly cloudChecked: boolean
  readonly cloudRevision: number | null
  readonly visible: boolean
}

export interface LocalSaveDistribution {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

export interface LocalSaveSummary {
  readonly all: LocalSaveDistribution | null
  readonly eligible: LocalSaveDistribution | null
  readonly capture: LocalSaveDistribution | null
  readonly worker: LocalSaveDistribution | null
  readonly formula: LocalSaveDistribution | null
  readonly outsideFormulaCondition: readonly number[]
}

const NUMBERS = ['writeEpoch', 'round', 'wallStartedAt', 'checkedAt', 'startedAt', 'savedAt', 'localSavedMs', 'commandMs', 'formulaSettledMs', 'editorSeq', 'draftSeq', 'baseRevision', 'captureMs', 'captureAt', 'captureSeq', 'workerSentAt', 'workerReceivedAt', 'workerMs', 'rawBytes'] as const
const INTEGERS = ['writeEpoch', 'round', 'editorSeq', 'draftSeq', 'baseRevision', 'captureSeq', 'rawBytes'] as const
const STRINGS = ['userId', 'documentId', 'writerId', 'writtenBy', 'snapshotHash'] as const
const BOOLEANS = ['cold', 'workerConfirmed', 'contentChecked', 'formulasPending', 'cloudChecked', 'visible'] as const
const FIELDS = new Set<string>([...NUMBERS, ...STRINGS, ...BOOLEANS, 'cloudRevision'])

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 只接收指定的有限结构；失败事实另外保存，不允许把未知内容带入成功报告。 */
export function readLocalSaveSample(value: unknown): LocalSaveSample | undefined {
  if (!object(value) || Object.keys(value).length !== FIELDS.size || Object.keys(value).some(key => !FIELDS.has(key))
    || NUMBERS.some(key => !finite(value[key]))
    || INTEGERS.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
    || STRINGS.some(key => typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 128)
    || BOOLEANS.some(key => typeof value[key] !== 'boolean')
    || typeof value.snapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.snapshotHash)
    || (value.cloudRevision !== null && (!Number.isSafeInteger(value.cloudRevision) || Number(value.cloudRevision) < 1))) {
    return undefined
  }
  return value as unknown as LocalSaveSample
}

export function localSaveProblems(value: unknown, config: LocalSaveConfig, identity: LocalSaveIdentity): string[] {
  return validateLocalSaves(value, config, identity, true)
}

/** 单轮交回时的前缀核对，不能用于宣告整组完成。 */
export function localSavePrefixProblems(value: unknown, config: LocalSaveConfig, identity: LocalSaveIdentity): string[] {
  return validateLocalSaves(value, config, identity, false)
}

function validateLocalSaves(value: unknown, config: LocalSaveConfig, identity: LocalSaveIdentity, complete: boolean): string[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(config.rounds) || config.rounds < 2 || config.rounds > 20 || value.length < 1 || value.length > config.rounds || (complete && value.length !== config.rounds))
    return ['测量轮数或样本集合不完整']
  const problems: string[] = []
  let previous: LocalSaveSample | undefined
  let base: number | undefined
  value.forEach((item: unknown, index) => {
    const row = readLocalSaveSample(item)
    if (row === undefined) {
      problems.push(`第 ${index + 1} 轮结构或数值无效`)
      return
    }
    base ??= row.baseRevision
    if (row.round !== index + 1 || row.cold !== (index === 0) || Object.entries(identity).some(([key, expected]) => row[key as keyof LocalSaveIdentity] !== expected))
      problems.push(`第 ${index + 1} 轮身份或编号不符`)
    if (!row.workerConfirmed || !row.contentChecked || row.formulasPending || !row.visible || row.captureSeq !== row.editorSeq)
      problems.push(`第 ${index + 1} 轮缺少完整持久证据`)
    if (row.wallStartedAt <= 0 || row.checkedAt < row.wallStartedAt || row.savedAt <= row.startedAt
      || Math.abs(row.savedAt - row.startedAt - row.localSavedMs) > 0.1
      || row.commandMs > row.localSavedMs || row.formulaSettledMs > row.localSavedMs || row.captureMs > row.localSavedMs
      || row.captureAt < row.startedAt || row.captureAt > row.savedAt
      || row.workerSentAt < row.startedAt || row.workerReceivedAt < row.workerSentAt || row.workerReceivedAt > row.savedAt
      || Math.abs(row.workerReceivedAt - row.workerSentAt - row.workerMs) > 0.1) {
      problems.push(`第 ${index + 1} 轮时序不符`)
    }
    if (previous !== undefined && (row.draftSeq <= previous.draftSeq || row.editorSeq <= previous.editorSeq || row.startedAt < previous.savedAt || row.wallStartedAt < previous.checkedAt))
      problems.push(`第 ${index + 1} 轮重用了旧序号或重叠计时`)
    if (config.network === 'online') {
      if (!row.cloudChecked || row.cloudRevision !== row.baseRevision + 1 || (previous !== undefined && row.baseRevision !== previous.cloudRevision))
        problems.push(`第 ${index + 1} 轮未逐轮确认云端正文与修订`)
    }
    else if (row.cloudChecked || row.cloudRevision !== null || row.baseRevision !== base) {
      problems.push(`第 ${index + 1} 轮离线条件不符`)
    }
    previous = row
  })
  return problems
}

function distribution(values: readonly number[]): LocalSaveDistribution | null {
  if (values.length === 0 || values.some(value => !finite(value)))
    return null
  const sorted = [...values].sort((a, b) => a - b)
  const min = sorted[0]
  const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  const max = sorted.at(-1)
  return min === undefined || p50 === undefined || p95 === undefined || max === undefined ? null : { n: sorted.length, min, p50, p95, max }
}

export function summarizeLocalSaves(samples: readonly LocalSaveSample[]): LocalSaveSummary {
  return {
    all: distribution(samples.map(row => row.localSavedMs)),
    eligible: distribution(samples.filter(row => row.formulaSettledMs <= 900).map(row => row.localSavedMs)),
    capture: distribution(samples.map(row => row.captureMs)),
    worker: distribution(samples.map(row => row.workerMs)),
    formula: distribution(samples.map(row => row.formulaSettledMs)),
    outsideFormulaCondition: samples.filter(row => row.formulaSettledMs > 900).map(row => row.round),
  }
}

export function localSaveTargets(samples: readonly LocalSaveSample[], config: LocalSaveConfig): string[] {
  const summary = summarizeLocalSaves(samples)
  const target = summary.eligible ?? summary.all
  const problems: string[] = []
  if (target === null || target.p95 > 2000)
    problems.push('修改到本机完成 p95 未满足 2000 ms')
  if (config.sample === '1m' && (summary.capture === null || summary.capture.p95 > 100))
    problems.push('约 1 MiB 同步捕获 p95 未满足 100 ms')
  return problems
}

export function localSaveSnapshotProblems(text: string, edit: { readonly cell: string, readonly value: string | number, readonly sheet?: string, readonly formula: boolean }): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!object(parsed))
      return ['正文不是快照对象']
    const book = object(parsed.snapshot) ? parsed.snapshot : parsed
    if (!object(book.sheets))
      return ['正文缺少工作表']
    const sheets = book.sheets
    const id = edit.sheet === undefined
      ? (Array.isArray(book.sheetOrder) ? book.sheetOrder[0] as unknown : undefined)
      : Object.keys(sheets).find(id => object(sheets[id]) && sheets[id].name === edit.sheet)
    if (typeof id !== 'string' || !object(sheets[id]) || !object(sheets[id].cellData))
      return ['正文缺少本轮工作表']
    const position = /^([A-Z]+)([1-9]\d*)$/.exec(edit.cell)
    if (position === null)
      return ['修改坐标无效']
    const rowNumber = Number(position[2])
    const column = [...(position[1] ?? '')].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1
    const row = sheets[id].cellData[String(rowNumber - 1)]
    const cell = object(row) ? row[String(column)] : undefined
    if (!object(cell) || cell.v !== edit.value)
      return ['正文没有本轮修改值']
    if (edit.formula) {
      const values = [3, 4, 5, 6, 7, 8].map((column) => {
        const cell = object(row) ? row[String(column)] : undefined
        return object(cell) ? cell.v : undefined
      })
      const formula = object(row) ? row['9'] : undefined
      if (values.some(value => typeof value !== 'number' || !Number.isFinite(value)) || !object(formula)
        || formula.f !== `=SUM(D${rowNumber}:I${rowNumber})` || typeof formula.v !== 'number' || !Number.isFinite(formula.v)
        || Math.abs(formula.v - values.reduce<number>((sum, value) => sum + Number(value), 0)) > 0.000001) {
        return ['正文的本轮公式或缓存不符']
      }
    }
    return []
  }
  catch { return ['正文无法按快照解读'] }
}

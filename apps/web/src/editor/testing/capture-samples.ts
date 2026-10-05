// 捕获时机复核的样本（M3-P4 设计 §3.15，DEF-003 的其余部分）：E2E 的生成器（tests/e2e/support/capture-samples.ts）按这里写库，
// 页面自检（./selftest-capture.ts）按这里推算公式该有的值、认出大表。两边用同一份定义，样本与核对不会各自漂移。
// - 公式样本：M0-P3 V07 的 formula-scenarios（spikes/m0/src/experiments/p3-samples/sheet-builders.ts 的 buildFormulaScenarios）——
//   依赖链、大范围聚合、跨表、SUMPRODUCT 的慢计算、易变函数；公式不带缓存值（打开时 SDK 只算没有结果的公式，打开即全部算一遍）。
//   规模按自检的时限缩放（FORMULA_SAMPLE 的注释）；
// - 大表：5 万行的一列文字（自动行高的迟到、大表复制）。
// 这个文件不引用任何模块：E2E 经模块边界的例外引用它（eslint.config.ts 的 SELFTEST_SHARED_FILES），Playwright 的进程里不能带进 Univer。

/** 快照里的单元格（只写用到的字段）：v 值、t 类型（1 文字、2 数值）、f 公式 */
export interface SampleCell {
  v?: number | string | boolean
  t?: number
  f?: string
}

export type SampleCells = Record<number, Record<number, SampleCell>>

/** 生成器换进模板的一张表 */
export interface SampleSheet {
  readonly id: string
  readonly name: string
  readonly rowCount: number
  readonly columnCount: number
  readonly cellData: SampleCells
}

/** 单元格的值的类型（Univer 的 CellValueType）：1 文字，2 数值 */
const TEXT = 1
const NUMBER = 2

/** mulberry32（与 M0 的样本同一个发生器）：32 位状态，[0, 1) */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- 公式样本 ----

/**
 * 公式样本的规模。M0 的是：链 200 层、聚合 2 万行、200 个 2 万行的 SUMPRODUCT（一次牵动它们的修改在 M0 的本机上 Chromium 约 1.2–1.4 秒、
 * WebKit 不到 1 秒）。自检在编辑时要做十来次牵动 SUMPRODUCT 的修改（两种公式模式各一遍），CI 比本机慢好几倍，场景的总时限 180 秒，
 * 所以 SUMPRODUCT 缩到 100 个 × 1 万行（每轮的计算量是 M0 的四分之一）、阈值的步长 10（阈值仍覆盖 0–990）；聚合随之 1 万行；链与易变函数不变。
 * "计算进行中再改一次"按信号触发（看到这一轮开始、还没有结果时立即改第二处，selftest-capture.ts），不靠计算慢于固定的 300 毫秒，
 * 缩小之后照样落在计算中；自检交回每轮的时间线，看得到每轮实际算了多久
 */
export const FORMULA_SAMPLE = {
  chain: { id: 'f-chain', name: '链', length: 200 },
  aggregate: { id: 'f-aggregate', name: '聚合', rows: 10_000 },
  cross: { id: 'f-cross', name: '跨表' },
  slow: { id: 'f-slow', name: '慢', count: 100, step: 10 },
  volatile: { id: 'f-volatile', name: '易变' },
} as const

/** 聚合表 B 列的值：0–1000 的整数（固定的种子，每次生成的字节相同） */
export function aggregateValues(): number[] {
  const random = mulberry32(7)
  return Array.from({ length: FORMULA_SAMPLE.aggregate.rows }, () => Math.floor(random() * 1001))
}

/** 聚合表 B 列的范围（A1 写法的行号从 1 起） */
function aggregateRange(absolute: boolean): string {
  const rows = FORMULA_SAMPLE.aggregate.rows
  return absolute ? `$B$1:$B$${rows}` : `B1:B${rows}`
}

/** 引用另一张表的写法：表名带引号（中文表名） */
function sheetRef(name: string, range: string): string {
  return `'${name}'!${range}`
}

/** 公式样本的五张表（公式都不带缓存值） */
export function formulaSampleSheets(): SampleSheet[] {
  const { chain, aggregate, cross, slow, volatile } = FORMULA_SAMPLE
  const chainCells: SampleCells = { 0: { 0: { v: 1, t: NUMBER } } }
  for (let row = 1; row < chain.length; row += 1)
    chainCells[row] = { 0: { f: `=A${row}+1` } }

  const values = aggregateValues()
  const aggregateCells: SampleCells = {}
  values.forEach((value, row) => {
    aggregateCells[row] = { 1: { v: value, t: NUMBER } }
  })
  const range = aggregateRange(false)
  const formulas = [`=SUM(${range})`, `=AVERAGE(${range})`, `=COUNTIF(${range},">500")`, `=MAX(${range})`]
  formulas.forEach((formula, row) => {
    aggregateCells[row] = { ...aggregateCells[row], 2: { f: formula } }
  })

  const crossCells: SampleCells = {
    0: { 0: { f: `=${sheetRef(chain.name, `A${chain.length}`)}*2` } },
    1: { 0: { f: `=SUM(${sheetRef(aggregate.name, range)})+${sheetRef(chain.name, 'A1')}` } },
    2: { 0: { f: `=${sheetRef(aggregate.name, 'C1')}-${sheetRef(aggregate.name, 'B1')}` } },
  }

  const slowCells: SampleCells = {}
  const absolute = sheetRef(aggregate.name, aggregateRange(true))
  for (let index = 0; index < slow.count; index += 1)
    slowCells[index] = { 0: { f: `=SUMPRODUCT((${absolute}>${index * slow.step})*${absolute})` } }

  const volatileCells: SampleCells = {
    0: { 0: { f: '=NOW()' } },
    1: { 0: { f: '=TODAY()' } },
    2: { 0: { f: '=RAND()' } },
    3: { 0: { f: '=RANDBETWEEN(1,1000000)' } },
    4: { 0: { f: '=A3*2' } },
  }

  return [
    { id: chain.id, name: chain.name, rowCount: chain.length + 20, columnCount: 5, cellData: chainCells },
    { id: aggregate.id, name: aggregate.name, rowCount: aggregate.rows + 100, columnCount: 5, cellData: aggregateCells },
    { id: cross.id, name: cross.name, rowCount: 20, columnCount: 5, cellData: crossCells },
    { id: slow.id, name: slow.name, rowCount: slow.count + 20, columnCount: 5, cellData: slowCells },
    { id: volatile.id, name: volatile.name, rowCount: 20, columnCount: 5, cellData: volatileCells },
  ]
}

/** 快照里用到的部分 */
interface SnapshotCells {
  readonly sheets: Readonly<Record<string, { readonly cellData?: Readonly<Record<string, Readonly<Record<string, SampleCell>>>> } | undefined>>
}

function cellOf(snapshot: SnapshotCells, sheetId: string, row: number, column: number): SampleCell | undefined {
  return snapshot.sheets[sheetId]?.cellData?.[row]?.[column]
}

function numberOf(cell: SampleCell | undefined): number | undefined {
  return typeof cell?.v === 'number' ? cell.v : undefined
}

/** 两个数相等（AVERAGE 这类除法的结果按相对误差比较） */
function close(actual: number | undefined, expected: number): boolean {
  return actual !== undefined && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected))
}

/** 一处核对：单元格的写法（"表名!A1"）与对不对 */
interface FormulaCheck {
  readonly cell: string
  readonly ok: boolean
}

/** 按定义核对的结果：核对了几个公式、哪些与定义不同（最多列出 limit 个），各类各错了几个 */
export interface FormulaVerdict {
  readonly checked: number
  readonly stale: readonly string[]
  readonly staleCount: number
  /** 各类的"错了几个/核对了几个"：链、聚合、跨表、慢、易变 */
  readonly byKind: Readonly<Record<'chain' | 'aggregate' | 'cross' | 'slow' | 'volatile', string>>
}

/**
 * 按公式的定义从快照里的输入（链!A1、聚合!B 列）独立推算每个公式的值，与快照里存下的值（v）比较（M0-P3 报告 §3.2 的第一层判定）。
 * 易变函数只能核对内部一致：A5 = A3 × 2、RAND 在 [0, 1)、RANDBETWEEN 是 1–1000000 的整数。不依赖 SDK
 */
export function verifyFormulaSnapshot(snapshotText: string, limit = 8): FormulaVerdict {
  const snapshot = JSON.parse(snapshotText) as SnapshotCells
  const { chain, aggregate, cross, slow, volatile } = FORMULA_SAMPLE
  const kinds: Record<keyof FormulaVerdict['byKind'], FormulaCheck[]> = { chain: [], aggregate: [], cross: [], slow: [], volatile: [] }

  const start = numberOf(cellOf(snapshot, chain.id, 0, 0)) ?? 0
  for (let row = 1; row < chain.length; row += 1)
    kinds.chain.push({ cell: `${chain.name}!A${row + 1}`, ok: close(numberOf(cellOf(snapshot, chain.id, row, 0)), start + row) })

  // 聚合表 B 列的数值（空格与非数值不参与 SUM、AVERAGE、COUNTIF、MAX）
  const values: number[] = []
  for (let row = 0; row < aggregate.rows; row += 1) {
    const value = numberOf(cellOf(snapshot, aggregate.id, row, 1))
    if (value !== undefined)
      values.push(value)
  }
  const sum = values.reduce((total, value) => total + value, 0)
  const expectedAggregate = [sum, values.length === 0 ? 0 : sum / values.length, values.filter(value => value > 500).length, values.length === 0 ? 0 : Math.max(...values)]
  expectedAggregate.forEach((expected, row) => {
    kinds.aggregate.push({ cell: `${aggregate.name}!C${row + 1}`, ok: close(numberOf(cellOf(snapshot, aggregate.id, row, 2)), expected) })
  })

  const chainEnd = start + chain.length - 1
  const firstAggregate = numberOf(cellOf(snapshot, aggregate.id, 0, 1)) ?? 0
  const expectedCross = [chainEnd * 2, sum + start, sum - firstAggregate]
  expectedCross.forEach((expected, row) => {
    kinds.cross.push({ cell: `${cross.name}!A${row + 1}`, ok: close(numberOf(cellOf(snapshot, cross.id, row, 0)), expected) })
  })

  for (let index = 0; index < slow.count; index += 1) {
    const threshold = index * slow.step
    const expected = values.filter(value => value > threshold).reduce((total, value) => total + value, 0)
    kinds.slow.push({ cell: `${slow.name}!A${index + 1}`, ok: close(numberOf(cellOf(snapshot, slow.id, index, 0)), expected) })
  }

  const rand = numberOf(cellOf(snapshot, volatile.id, 2, 0))
  const between = numberOf(cellOf(snapshot, volatile.id, 3, 0))
  const doubled = numberOf(cellOf(snapshot, volatile.id, 4, 0))
  kinds.volatile.push(
    { cell: `${volatile.name}!A1`, ok: numberOf(cellOf(snapshot, volatile.id, 0, 0)) !== undefined },
    { cell: `${volatile.name}!A2`, ok: numberOf(cellOf(snapshot, volatile.id, 1, 0)) !== undefined },
    { cell: `${volatile.name}!A3`, ok: rand !== undefined && rand >= 0 && rand < 1 },
    { cell: `${volatile.name}!A4`, ok: between !== undefined && Number.isInteger(between) && between >= 1 && between <= 1_000_000 },
    { cell: `${volatile.name}!A5`, ok: rand !== undefined && close(doubled, rand * 2) },
  )

  const all = Object.values(kinds).flat()
  const stale = all.filter(check => !check.ok).map(check => check.cell)
  const byKind = Object.fromEntries(Object.entries(kinds).map(([kind, checks]) => [kind, `${checks.filter(check => !check.ok).length}/${checks.length}`])) as FormulaVerdict['byKind']
  return { checked: all.length, stale: stale.slice(0, limit), staleCount: stale.length, byKind }
}

/** 易变函数里 RAND() 的值（"修改无关的单元格之后 RAND 重算了"用） */
export function randOf(snapshotText: string): number | undefined {
  return numberOf(cellOf(JSON.parse(snapshotText) as SnapshotCells, FORMULA_SAMPLE.volatile.id, 2, 0))
}

// ---- 大表 ----

/**
 * 5 万行的大表（M0-P3 V06 的"5 万行改字号"与大表复制）：A 列每行一段文字，共 5 万格。工作表 26 列（与 M0 的"数据"表相同）：
 * 改字号的命令里只同步计算视口附近的 ceil(10000 / 列数) 行的自动行高（约 385 行），其余交给空闲任务、每轮 500 行，行高变化迟到
 * （sheets 的 commands/commands/util.ts 的 getSuitableRangesInView；sheets-ui 的 auto-height.service.ts，M0-P3 报告 §2.3 第 1 条）
 */
export const BIG_SHEET = { id: 'big', name: '大表', rows: 50_000, columnCount: 26 } as const

export function bigSheet(): SampleSheet {
  const cellData: SampleCells = {}
  for (let row = 0; row < BIG_SHEET.rows; row += 1)
    cellData[row] = { 0: { v: `第 ${row + 1} 行`, t: TEXT } }
  return { id: BIG_SHEET.id, name: BIG_SHEET.name, rowCount: BIG_SHEET.rows + 100, columnCount: BIG_SHEET.columnCount, cellData }
}

/** 快照里一张表的单元格数 */
export function cellCount(snapshotText: string, sheetId: string): number {
  const snapshot = JSON.parse(snapshotText) as SnapshotCells
  return Object.values(snapshot.sheets[sheetId]?.cellData ?? {}).reduce((count, row) => count + Object.keys(row).length, 0)
}

// 捕获时机复核的样本（M3-P4 设计 §3.15，DEF-003 的其余部分）：E2E 的生成器（tests/e2e/support/capture-samples.ts）按这里写库，
// 页面自检（./selftest-capture.ts）按这里推算公式该有的值、认出大表。两边用同一份定义，样本与核对不会各自漂移。
// - 公式样本：M0-P3 V07 的 formula-scenarios（spikes/m0/src/experiments/p3-samples/sheet-builders.ts 的 buildFormulaScenarios）——
//   依赖链、大范围聚合、跨表、SUMPRODUCT 的慢计算、易变函数；公式不带缓存值（打开时 SDK 只算没有结果的公式，打开即全部算一遍）。
//   规模按自检的时限缩放（FORMULA_SAMPLE 的注释）；生成与核对都可以另给一个规模（FormulaSample：US-M3-03 的 E2E 用更小的一份，
//   tests/e2e/support/capture-samples.ts 的 AUTOSAVE_FORMULA_SAMPLE），"重"表的公式个数为 0 时不生成它；
// - 大表：5 万行的一列文字（自动行高的迟到、大表复制）；
// - 真实浏览器的前置复核（M4-P1 S1，设计 §3.6 第 9、10、12 项）：按字节数生成的明细表（M0-P3 的 big-1m、big-5m：捕获成本与
//   Worker 停顿的负载），与性能基线的 perf-50k（5 万格、1,000 个公式，带缓存值：与保存过的文档一样，打开时不算）。
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

/** 公式样本的规模：各张表的 id、名称与大小（FORMULA_SAMPLE 是自检用的那一份） */
export interface FormulaSample {
  readonly chain: { readonly id: string, readonly name: string, readonly length: number }
  readonly aggregate: { readonly id: string, readonly name: string, readonly rows: number }
  readonly cross: { readonly id: string, readonly name: string }
  readonly slow: { readonly id: string, readonly name: string, readonly count: number, readonly step: number }
  readonly volatile: { readonly id: string, readonly name: string }
  /** 公式个数为 0 时没有这张表 */
  readonly heavy: { readonly id: string, readonly name: string, readonly rows: number, readonly count: number, readonly step: number }
}

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
  heavy: { id: 'f-heavy', name: '重', rows: 10_000, count: 500, step: 2 },
} as const satisfies FormulaSample

/**
 * "计算进行中重建"的那一轮计算（formula-timing 的 formula.rebuild-during-calc，主会话 2026-10-05 追加：主线程模式下 Univer 实例销毁时
 * 正在算的那一轮会继续跑完、把只会得出 #NAME? 的语法树写进模块级的缓存，之后同一页里新建的实例命中它们——S1 核实成立，S5 规避）："重"表 A 列 1 万个数、
 * C 列 500 个 SUMPRODUCT，**带缓存值**：打开时不算（WHEN_EMPTY 只算没有结果的），formula-timing 的各项修改也不牵动它；只在强制重算时
 * 与别的公式一起算，让那一轮在各浏览器里都长过 1 秒（自检在这一轮开始 1 秒之后才点"编辑"，避开 sheets-formula 的 1 秒进度计时器，
 * 那是另一个已修的问题，main 的 f755729），重建发生在计算中
 */
export function heavyValues(rows: number = FORMULA_SAMPLE.heavy.rows): number[] {
  const random = mulberry32(11)
  return Array.from({ length: rows }, () => Math.floor(random() * 1001))
}

/** 一组数里大于 threshold 的之和（SUMPRODUCT((range>threshold)*range) 的定义） */
function sumAbove(values: readonly number[], threshold: number): number {
  return values.filter(value => value > threshold).reduce((total, value) => total + value, 0)
}

/** 聚合表 B 列的值：0–1000 的整数（固定的种子，每次生成的字节相同；行数少的是同一串的前面几个） */
export function aggregateValues(rows: number = FORMULA_SAMPLE.aggregate.rows): number[] {
  const random = mulberry32(7)
  return Array.from({ length: rows }, () => Math.floor(random() * 1001))
}

/** 聚合表 B 列的范围（A1 写法的行号从 1 起） */
function aggregateRange(rows: number, absolute: boolean): string {
  return absolute ? `$B$1:$B$${rows}` : `B1:B${rows}`
}

/** 引用另一张表的写法：表名带引号（中文表名） */
function sheetRef(name: string, range: string): string {
  return `'${name}'!${range}`
}

/** 公式样本的六张表（"重"表之外的公式都不带缓存值；"重"表的公式个数为 0 时只有五张） */
export function formulaSampleSheets(sample: FormulaSample = FORMULA_SAMPLE): SampleSheet[] {
  const { chain, aggregate, cross, slow, volatile, heavy } = sample
  const chainCells: SampleCells = { 0: { 0: { v: 1, t: NUMBER } } }
  for (let row = 1; row < chain.length; row += 1)
    chainCells[row] = { 0: { f: `=A${row}+1` } }

  const values = aggregateValues(aggregate.rows)
  const aggregateCells: SampleCells = {}
  values.forEach((value, row) => {
    aggregateCells[row] = { 1: { v: value, t: NUMBER } }
  })
  const range = aggregateRange(aggregate.rows, false)
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
  const absolute = sheetRef(aggregate.name, aggregateRange(aggregate.rows, true))
  for (let index = 0; index < slow.count; index += 1)
    slowCells[index] = { 0: { f: `=SUMPRODUCT((${absolute}>${index * slow.step})*${absolute})` } }

  const volatileCells: SampleCells = {
    0: { 0: { f: '=NOW()' } },
    1: { 0: { f: '=TODAY()' } },
    2: { 0: { f: '=RAND()' } },
    3: { 0: { f: '=RANDBETWEEN(1,1000000)' } },
    4: { 0: { f: '=A3*2' } },
  }

  const heavyData = heavyValues(heavy.rows)
  const heavyCells: SampleCells = {}
  heavyData.forEach((value, row) => {
    heavyCells[row] = { 0: { v: value, t: NUMBER } }
  })
  const heavyRange = `$A$1:$A$${heavy.rows}`
  for (let index = 0; index < heavy.count; index += 1) {
    const threshold = index * heavy.step
    heavyCells[index] = { ...heavyCells[index], 2: { f: `=SUMPRODUCT((${heavyRange}>${threshold})*${heavyRange})`, v: sumAbove(heavyData, threshold), t: NUMBER } }
  }

  return [
    { id: chain.id, name: chain.name, rowCount: chain.length + 20, columnCount: 5, cellData: chainCells },
    { id: aggregate.id, name: aggregate.name, rowCount: aggregate.rows + 100, columnCount: 5, cellData: aggregateCells },
    { id: cross.id, name: cross.name, rowCount: 20, columnCount: 5, cellData: crossCells },
    { id: slow.id, name: slow.name, rowCount: slow.count + 20, columnCount: 5, cellData: slowCells },
    { id: volatile.id, name: volatile.name, rowCount: 20, columnCount: 5, cellData: volatileCells },
    ...(heavy.count > 0 ? [{ id: heavy.id, name: heavy.name, rowCount: heavy.rows + 100, columnCount: 5, cellData: heavyCells }] : []),
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
  /** 各类的"错了几个/核对了几个"：链、聚合、跨表、慢、易变、重 */
  readonly byKind: Readonly<Record<'chain' | 'aggregate' | 'cross' | 'slow' | 'volatile' | 'heavy', string>>
  /** 错了的格里不是数的值（例如 #NAME?）：写法与个数 */
  readonly errors: Readonly<Record<string, number>>
}

/** 快照里一列的数值（空格与非数值不参与 SUM、AVERAGE、COUNTIF、MAX、SUMPRODUCT 的比较） */
function columnValues(snapshot: SnapshotCells, sheetId: string, rows: number, column: number): number[] {
  const values: number[] = []
  for (let row = 0; row < rows; row += 1) {
    const value = numberOf(cellOf(snapshot, sheetId, row, column))
    if (value !== undefined)
      values.push(value)
  }
  return values
}

/**
 * 按公式的定义从快照里的输入（链!A1、聚合!B 列、重!A 列）独立推算每个公式的值，与快照里存下的值（v）比较（M0-P3 报告 §3.2 的第一层判定）。
 * 易变函数只能核对内部一致：A5 = A3 × 2、RAND 在 [0, 1)、RANDBETWEEN 是 1–1000000 的整数。不依赖 SDK。
 * 错了的格里不是数的值（公式出错时是 #NAME? 这样的写法）另外按写法计数
 */
export function verifyFormulaSnapshot(snapshotText: string, limit = 8, sample: FormulaSample = FORMULA_SAMPLE): FormulaVerdict {
  const snapshot = JSON.parse(snapshotText) as SnapshotCells
  const { chain, aggregate, cross, slow, volatile, heavy } = sample
  const kinds: Record<keyof FormulaVerdict['byKind'], FormulaCheck[]> = { chain: [], aggregate: [], cross: [], slow: [], volatile: [], heavy: [] }
  const errors: Record<string, number> = {}
  /** 核对一格：kind 这一类、label 是给人看的写法；不对而且不是数时记下它的写法 */
  const verify = (kind: keyof FormulaVerdict['byKind'], label: string, cell: SampleCell | undefined, ok: boolean): void => {
    if (!ok && cell !== undefined && typeof cell.v === 'string')
      errors[cell.v] = (errors[cell.v] ?? 0) + 1
    kinds[kind].push({ cell: label, ok })
  }
  const formula = (sheetId: string, row: number, column: number, expected: number): [SampleCell | undefined, boolean] => {
    const cell = cellOf(snapshot, sheetId, row, column)
    return [cell, close(numberOf(cell), expected)]
  }

  const start = numberOf(cellOf(snapshot, chain.id, 0, 0)) ?? 0
  for (let row = 1; row < chain.length; row += 1)
    verify('chain', `${chain.name}!A${row + 1}`, ...formula(chain.id, row, 0, start + row))

  const values = columnValues(snapshot, aggregate.id, aggregate.rows, 1)
  const sum = values.reduce((total, value) => total + value, 0)
  const expectedAggregate = [sum, values.length === 0 ? 0 : sum / values.length, values.filter(value => value > 500).length, values.length === 0 ? 0 : Math.max(...values)]
  expectedAggregate.forEach((expected, row) => verify('aggregate', `${aggregate.name}!C${row + 1}`, ...formula(aggregate.id, row, 2, expected)))

  const chainEnd = start + chain.length - 1
  const firstAggregate = numberOf(cellOf(snapshot, aggregate.id, 0, 1)) ?? 0
  const expectedCross = [chainEnd * 2, sum + start, sum - firstAggregate]
  expectedCross.forEach((expected, row) => verify('cross', `${cross.name}!A${row + 1}`, ...formula(cross.id, row, 0, expected)))

  for (let index = 0; index < slow.count; index += 1)
    verify('slow', `${slow.name}!A${index + 1}`, ...formula(slow.id, index, 0, sumAbove(values, index * slow.step)))

  const heavyData = columnValues(snapshot, heavy.id, heavy.rows, 0)
  for (let index = 0; index < heavy.count; index += 1)
    verify('heavy', `${heavy.name}!C${index + 1}`, ...formula(heavy.id, index, 2, sumAbove(heavyData, index * heavy.step)))

  const cells = [0, 1, 2, 3, 4].map(row => cellOf(snapshot, volatile.id, row, 0))
  const [now, today, rand, between, doubled] = cells.map(numberOf)
  verify('volatile', `${volatile.name}!A1`, cells[0], now !== undefined)
  verify('volatile', `${volatile.name}!A2`, cells[1], today !== undefined)
  verify('volatile', `${volatile.name}!A3`, cells[2], rand !== undefined && rand >= 0 && rand < 1)
  verify('volatile', `${volatile.name}!A4`, cells[3], between !== undefined && Number.isInteger(between) && between >= 1 && between <= 1_000_000)
  verify('volatile', `${volatile.name}!A5`, cells[4], rand !== undefined && close(doubled, rand * 2))

  const all = Object.values(kinds).flat()
  const stale = all.filter(check => !check.ok).map(check => check.cell)
  const byKind = Object.fromEntries(Object.entries(kinds).map(([kind, checks]) => [kind, `${checks.filter(check => !check.ok).length}/${checks.length}`])) as FormulaVerdict['byKind']
  return { checked: all.length, stale: stale.slice(0, limit), staleCount: stale.length, byKind, errors }
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

// ---- 按字节数生成的明细表（M4-P1 S1）----

/** 明细表与 perf-50k 的类别（M0-P3 的 CATEGORIES） */
const CATEGORIES = ['华东', '华南', '华北', '西南', '西北', '东北', '华中', '海外', '线上', '其他'] as const

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 从 0 开始的列号的字母写法（只用到 A–Z） */
function columnLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

/** 明细表（M0-P3 的 big-1m、big-5m）：工作表的 id 与名称、20 列，按目标的字节数生成行，留出工作簿其余部分的余量 */
export const BULK_SHEET = { id: 'bulk', name: '明细', columns: 20, fill: 0.97 } as const

/**
 * 按目标的字节数生成明细表（M0-P3 的 buildBig，同样的种子与列，按 JSON 文字的字节数估算）：表头一行；之后每行编号、名称、类别、
 * 16 个两位小数的数值，最后一列每 10 行一个行合计的公式（带缓存值，打开时不算），其余是数值。捕获成本（capture-cost）按它的大小
 * 分两档（约 1 MiB 与约 5 MiB）；worker-stall 拿同一个生成器在页面里造约 5 MiB 的负载（类表格的 JSON，gzip 之后约四分之一，与快照相近）
 */
export function bulkSheet(targetBytes: number): SampleSheet {
  const random = mulberry32(20_260_924)
  const { columns } = BULK_SHEET
  const last = columns - 1
  const cellData: SampleCells = {}
  const header: Record<number, SampleCell> = {}
  ;['编号', '名称', '类别', ...Array.from({ length: columns - 4 }, (_, index) => `指标${index + 1}`), '合计'].forEach((text, column) => {
    header[column] = { v: text, t: TEXT }
  })
  cellData[0] = header
  const encoder = new TextEncoder()
  let bytes = encoder.encode(JSON.stringify(cellData)).length
  let row = 1
  while (bytes < targetBytes * BULK_SHEET.fill) {
    const cells: Record<number, SampleCell> = {
      0: { v: row, t: NUMBER },
      1: { v: `项目-${String(row).padStart(6, '0')}`, t: TEXT },
      2: { v: CATEGORIES[Math.floor(random() * CATEGORIES.length)] ?? CATEGORIES[0], t: TEXT },
    }
    let total = 0
    for (let column = 3; column < last; column += 1) {
      const value = round2(random() * 10_000)
      cells[column] = { v: value, t: NUMBER }
      total += value
    }
    cells[last] = row % 10 === 0
      ? { f: `=SUM(D${row + 1}:${columnLetter(last - 1)}${row + 1})`, v: round2(total), t: NUMBER }
      : { v: round2(random() * 10_000), t: NUMBER }
    cellData[row] = cells
    bytes += encoder.encode(JSON.stringify(cells)).length + String(row).length + 4
    row += 1
  }
  return { id: BULK_SHEET.id, name: BULK_SHEET.name, rowCount: row + 100, columnCount: columns, cellData }
}

/** 捕获成本的两档样本的目标字节数（M0-P3：1 MiB 与 5 MiB；5 MiB 一档仍在快照的上限之内，见 BULK_SHEET.fill） */
export const BULK_SAMPLE_BYTES = { small: 1024 * 1024, large: 5 * 1024 * 1024 } as const

// ---- perf-50k（M4-P1 S1 的性能基线，M0-P3 V10）----

/**
 * 性能基线的样本（M0-P3 的 buildPerf50k，00 号计划书 §12.1 的表格样本）："数据表"表头加 5,000 行 × 10 列（50,010 格，前 600 行的合计是公式）
 * 与"汇总"400 个公式（分类统计 40、列统计 60、VLOOKUP 300，连同标签与查找的编号 716 格），共 1,000 个公式。公式带缓存值（与保存过的文档一样，打开时不算）；
 * 增量计算改数据表的 D 列（incrementalCell）：牵动约 320 个公式——这一行的合计、D 列的分类与列统计、300 个 VLOOKUP（范围含 D 列）
 */
export const PERF_SAMPLE = {
  data: { id: 'perf-data', name: '数据表', rows: 5_000, formulaRows: 600 },
  summary: { id: 'perf-summary', name: '汇总', lookups: 300 },
  formulas: 1_000,
} as const

/** 增量计算的第 index 次改哪一格（数据表 D 列，从第 2 行起，M0 的 D2、D3……）与写什么 */
export function perfIncrementalEdit(index: number): { readonly sheet: string, readonly cell: string, readonly value: number } {
  return { sheet: PERF_SAMPLE.data.name, cell: `D${index + 2}`, value: 500 + index }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** 样本标准差（STDEV） */
function sampleStdev(values: readonly number[]): number {
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  return Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1))
}

/** 列统计的十个函数（M0 的顺序）：PRODUCT 只取前 10 行，免得溢出 */
const COLUMN_FUNCTIONS = ['SUM', 'AVERAGE', 'MAX', 'MIN', 'COUNT', 'MEDIAN', 'STDEV', 'SUMSQ', 'COUNTA', 'PRODUCT'] as const

function columnStat(name: (typeof COLUMN_FUNCTIONS)[number], values: readonly number[]): number {
  switch (name) {
    case 'SUM':
      return values.reduce((total, value) => total + value, 0)
    case 'AVERAGE':
      return values.reduce((total, value) => total + value, 0) / values.length
    case 'MAX':
      return Math.max(...values)
    case 'MIN':
      return Math.min(...values)
    case 'COUNT':
    case 'COUNTA':
      return values.length
    case 'MEDIAN':
      return median(values)
    case 'STDEV':
      return sampleStdev(values)
    case 'SUMSQ':
      return values.reduce((total, value) => total + value * value, 0)
    case 'PRODUCT':
      return values.slice(0, 10).reduce((total, value) => total * value, 1)
  }
}

/** perf-50k 的两张表（公式带按定义算出的缓存值） */
export function perfSampleSheets(): SampleSheet[] {
  const { data, summary } = PERF_SAMPLE
  const random = mulberry32(12)
  const dataCells: SampleCells = {}
  const header: Record<number, SampleCell> = {}
  ;['编号', '名称', '类别', '销量', '单价', '成本', '费用', '退货', '库存', '合计'].forEach((text, column) => {
    header[column] = { v: text, t: TEXT }
  })
  dataCells[0] = header
  /** 每一行的类别与 D–I 列的值（汇总的缓存值按它们算） */
  const rows: { readonly name: string, readonly category: string, readonly values: readonly number[] }[] = []
  for (let row = 1; row <= data.rows; row += 1) {
    const name = `商品-${String(row).padStart(5, '0')}`
    const category = CATEGORIES[row % CATEGORIES.length] ?? CATEGORIES[0]
    const cells: Record<number, SampleCell> = { 0: { v: row, t: NUMBER }, 1: { v: name, t: TEXT }, 2: { v: category, t: TEXT } }
    const values: number[] = []
    for (let column = 3; column <= 8; column += 1) {
      const value = round2(random() * 1000)
      cells[column] = { v: value, t: NUMBER }
      values.push(value)
    }
    cells[9] = row <= data.formulaRows
      ? { f: `=SUM(D${row + 1}:I${row + 1})`, v: round2(values.reduce((total, value) => total + value, 0)), t: NUMBER }
      : { v: round2(random() * 6000), t: NUMBER }
    dataCells[row] = cells
    rows.push({ name, category, values })
  }

  const last = data.rows + 1
  const ref = (column: string): string => `'${data.name}'!$${column}$2:$${column}$${last}`
  const summaryCells: SampleCells = {}
  CATEGORIES.forEach((category, index) => {
    const matching = rows.filter(row => row.category === category)
    const sales = matching.map(row => row.values[0] ?? 0)
    const prices = matching.map(row => row.values[1] ?? 0)
    const costs = matching.map(row => row.values[2] ?? 0)
    summaryCells[index] = {
      0: { v: category, t: TEXT },
      1: { f: `=SUMIF(${ref('C')},A${index + 1},${ref('D')})`, v: sales.reduce((total, value) => total + value, 0), t: NUMBER },
      2: { f: `=AVERAGEIF(${ref('C')},A${index + 1},${ref('E')})`, v: prices.reduce((total, value) => total + value, 0) / prices.length, t: NUMBER },
      3: { f: `=COUNTIF(${ref('C')},A${index + 1})`, v: matching.length, t: NUMBER },
      4: { f: `=MAXIFS(${ref('F')},${ref('C')},A${index + 1})`, v: Math.max(...costs), t: NUMBER },
    }
  })
  ;['D', 'E', 'F', 'G', 'H', 'I'].forEach((column, offset) => {
    const values = rows.map(row => row.values[offset] ?? 0)
    const cells: Record<number, SampleCell> = { 0: { v: `列 ${column}`, t: TEXT } }
    COLUMN_FUNCTIONS.forEach((name, index) => {
      const formula = name === 'PRODUCT' ? `=PRODUCT('${data.name}'!$${column}$2:$${column}$11)` : `=${name}(${ref(column)})`
      cells[index + 1] = { f: formula, v: columnStat(name, values), t: NUMBER }
    })
    summaryCells[12 + offset] = cells
  })
  for (let index = 0; index < summary.lookups; index += 1) {
    const id = 1 + ((index * 16) % data.rows)
    summaryCells[20 + index] = {
      0: { v: id, t: NUMBER },
      1: { f: `=VLOOKUP(A${21 + index},'${data.name}'!$A$2:$J$${last},2,FALSE)`, v: rows[id - 1]?.name ?? '', t: TEXT },
    }
  }
  return [
    { id: data.id, name: data.name, rowCount: data.rows + 200, columnCount: 12, cellData: dataCells },
    { id: summary.id, name: summary.name, rowCount: 400, columnCount: 12, cellData: summaryCells },
  ]
}

/** 快照里一张表的公式个数（perf-50k 的核对：1,000 个） */
export function formulaCount(snapshotText: string): number {
  const snapshot = JSON.parse(snapshotText) as SnapshotCells
  return Object.values(snapshot.sheets).reduce((count, sheet) => count + Object.values(sheet?.cellData ?? {})
    .reduce((rowCount, row) => rowCount + Object.values(row).filter(cell => typeof cell.f === 'string').length, 0), 0)
}

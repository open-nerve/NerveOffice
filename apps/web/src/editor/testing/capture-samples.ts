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
  heavy: { id: 'f-heavy', name: '重', rows: 10_000, count: 500, step: 2 },
} as const

/**
 * "计算进行中重建"的那一轮计算（formula-timing 的 formula.rebuild-during-calc，主会话 2026-10-05 追加：主线程模式下 Univer 实例销毁时
 * 正在算的那一轮会继续跑完、把只会得出 #NAME? 的语法树写进模块级的缓存，之后同一页里新建的实例命中它们——S1 核实成立，S5 规避）："重"表 A 列 1 万个数、
 * C 列 500 个 SUMPRODUCT，**带缓存值**：打开时不算（WHEN_EMPTY 只算没有结果的），formula-timing 的各项修改也不牵动它；只在强制重算时
 * 与别的公式一起算，让那一轮在各浏览器里都长过 1 秒（自检在这一轮开始 1 秒之后才点"编辑"，避开 sheets-formula 的 1 秒进度计时器，
 * 那是另一个已修的问题，main 的 f755729），重建发生在计算中
 */
export function heavyValues(): number[] {
  const random = mulberry32(11)
  return Array.from({ length: FORMULA_SAMPLE.heavy.rows }, () => Math.floor(random() * 1001))
}

/** 一组数里大于 threshold 的之和（SUMPRODUCT((range>threshold)*range) 的定义） */
function sumAbove(values: readonly number[], threshold: number): number {
  return values.filter(value => value > threshold).reduce((total, value) => total + value, 0)
}

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

/** 公式样本的六张表（"重"表之外的公式都不带缓存值） */
export function formulaSampleSheets(): SampleSheet[] {
  const { chain, aggregate, cross, slow, volatile, heavy } = FORMULA_SAMPLE
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

  const heavyData = heavyValues()
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
    { id: heavy.id, name: heavy.name, rowCount: heavy.rows + 100, columnCount: 5, cellData: heavyCells },
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
export function verifyFormulaSnapshot(snapshotText: string, limit = 8): FormulaVerdict {
  const snapshot = JSON.parse(snapshotText) as SnapshotCells
  const { chain, aggregate, cross, slow, volatile, heavy } = FORMULA_SAMPLE
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

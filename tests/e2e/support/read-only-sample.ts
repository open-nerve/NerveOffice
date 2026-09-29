// 只读用例的样本（M2-P3 设计 §4、§7）：由 M0 的综合样本（spikes/m0/fixtures/sheet/sheet-all.json）派生，覆盖 M0 入口清单用到的内容。
// 与 M0 的差别：去掉 SHEET_AuthzIoMockService_PLUGIN（身份替换之后编辑器不再有这项资源，ADR-009）；工作簿 id 写成占位符；
// 两张图片换成 data URL 的 PNG（CSP 的 img-src 允许 data:；编辑器里插入图片的命令在 M5 之前被入口守卫取消，所以样本直接写成快照）。
// 样本已经收敛（与新建的模板一样）：按生产档案打开、把每张表都画一遍之后保存，字节与样本相同，所以"打开不产生改动"可以逐字节比较。
// 收敛时改了三处（都不是内容）：浮动图片 transform 的键的顺序；数据验证里空的规则表（SDK 打开时去掉）；
// 单元格图片（"功能"表 H5）的尺寸 41×41 改为 60×60（SDK 画这一格时按单元格的大小改写模型里的尺寸，sheets-drawing-ui 的
// sheet-cell-image.controller.ts 的 resizeImageByCell，不经 mutation）。
// 写库时换上文档自己的 unitId（与新建的模板相同，database.ts 的 SnapshotFor）。
// 重新收敛（SDK 升级或插件档案变更之后，"打开不产生改动"等用例失败时）：pnpm --filter @nerve-office/e2e run update:read-only-sample
// （tools/update-read-only-sample.spec.ts：打开、把每张表画一遍、保存，直到连续两次保存的字节相同，写回 read-only-sample.json）。
import { readFileSync } from 'node:fs'

/** 样本里的占位 unitId */
export const SAMPLE_UNIT_PLACEHOLDER = '__UNIT_ID__'

/** 样本的原文（紧凑的 JSON：与编辑器保存的写法相同） */
const SAMPLE = JSON.stringify(JSON.parse(readFileSync(new URL('read-only-sample.json', import.meta.url), 'utf8')) as unknown)

/** 按文档的 unitId 生成样本的快照文本 */
export function readOnlySampleFor(unitId: string): string {
  return SAMPLE.replaceAll(SAMPLE_UNIT_PLACEHOLDER, unitId)
}

/** 样本的 5 张工作表：名称与 id（sheetOrder 的顺序） */
export const SAMPLE_SHEETS = {
  /** 打开时的当前表：表头、数值、日期、公式、富文本、合并单元格、冻结首行首列 */
  data: { name: '数据', id: 'sheet-1' },
  /** 引用"数据"的公式 */
  summary: { name: '汇总', id: '3EB0bwApYxHAp_aL_pN0v' },
  /** 隐藏的工作表 */
  hidden: { name: '隐藏', id: 'BosGI6KRewWr9iRx1e2-J' },
  /** 浮动图片（J2，120×80）、单元格图片（H5）、批注（H1）、超链接（H2、H3）、数据验证（G1:G10）、条件格式（A–E 列） */
  features: { name: '功能', id: 'qu7F_0n49etB111SblNln' },
  /** 筛选（A1:C20，第一列只显示"研发""运营"） */
  filter: { name: '筛选', id: '3pom9bUkA1bNL7bRVYpBX' },
} as const

/** 用例核对的内容 */
export const SAMPLE_CELLS = {
  /** "数据"表 A2 的值（复制之后剪贴板里的文字） */
  a2: '苹果',
  /** "功能"表 H1 的批注 */
  note: '综合样本中的备注',
} as const

/** 样本里的公式与它们的结果（缓存值）：同一张表的、跨表的、引用定义名称的 */
export const SAMPLE_FORMULAS = [
  { sheetId: SAMPLE_SHEETS.data.id, cell: 'G2', formula: '=A2&"-"&B2', value: '苹果-12' },
  { sheetId: SAMPLE_SHEETS.data.id, cell: 'B7', formula: '=SUM(B2:B6)', value: 70 },
  { sheetId: SAMPLE_SHEETS.data.id, cell: 'B8', formula: '=AVERAGE(B2:B6)', value: 14 },
  { sheetId: SAMPLE_SHEETS.data.id, cell: 'B9', formula: '=SUM(数量合计区)', value: 70 },
  { sheetId: SAMPLE_SHEETS.summary.id, cell: 'A1', formula: '=SUM(\'数据\'!B2:B6)', value: 70 },
  { sheetId: SAMPLE_SHEETS.summary.id, cell: 'A2', formula: '=\'数据\'!A2', value: '苹果' },
] as const

interface SampleCell { f?: string, v?: unknown, t?: number }
interface SampleWorkbook { sheets: Record<string, { cellData: Record<string, Record<string, SampleCell>> }> }

/**
 * 去掉公式缓存值的样本（P3 审查 B5）：样本本身逐字节比较，不动它，按它派生。打开时 SDK 只计算没有结果的公式
 * （sheets-formula 的 initialFormulaComputing 默认是 WHEN_EMPTY），所以打开之后出现的结果一定是公式 Worker 算出来的
 */
export function sampleWithoutFormulaValuesFor(unitId: string): string {
  const workbook = JSON.parse(readOnlySampleFor(unitId)) as SampleWorkbook
  for (const sheet of Object.values(workbook.sheets)) {
    for (const row of Object.values(sheet.cellData)) {
      for (const cell of Object.values(row)) {
        if (cell.f !== undefined) {
          delete cell.v
          delete cell.t
        }
      }
    }
  }
  return JSON.stringify(workbook)
}

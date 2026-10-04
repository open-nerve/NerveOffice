// 单元格里的链接在命令流里的约定（M3-P3 设计 §3.6，DEF-021）：链接的改写器（profile/link-policy.ts）按它认出要改写的写入。
// mutation 的 id 与链接区间的种类取自 SDK 导出的定义，不手抄；公式结果的执行选项在 SDK 里只是字面量
// （sheets 的 calculate-result-apply.controller.ts:90-97），在这里集中写一次
import { CustomRangeType } from '@univerjs/core'
import { SetRangeValuesMutation } from '@univerjs/sheets'

export const CELL_LINK_PROTOCOL = Object.freeze({
  /**
   * 写单元格的 mutation：键入、编辑栏、表格上与单元格编辑器里的粘贴、公式的结果都经它把内容写进单元格；
   * 参数 cellValue[行][列] 是单元格（ICellData），富文本在 p，链接是 p.body.customRanges 里 rangeType 为链接的区间，地址在 properties.url
   */
  setRangeValuesMutationId: SetRangeValuesMutation.id,
  /** 链接区间的 rangeType（contracts 的 HYPERLINK_RANGE_TYPE 与它相同，单元测试核对） */
  hyperlinkRangeType: CustomRangeType.HYPERLINK,
  /**
   * 公式的结果：写回时的执行选项带它（CalculateResultApplyController 写 onlyLocal、fromFormula、applyFormulaCalculationResult；
   * UpdateFormulaController 把公式写进单元格的嵌套写入也带它，update-formula.controller.ts:166-180，那一条只有 f、si，没有富文本）
   */
  fromFormulaOption: 'fromFormula',
})

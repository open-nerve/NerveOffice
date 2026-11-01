import type { SheetCsv } from '../../editor/index.ts'

/** 原会话/切换用例没有 CSV 场景；若未来路径开始调用它，必须补充真实场景而不是默认成功。 */
export function unusedCsv(): SheetCsv {
  const unexpected = (): never => {
    throw new Error('本用例未配置 CSV 行为')
  }
  return { sheets: unexpected, read: unexpected, insert: unexpected }
}

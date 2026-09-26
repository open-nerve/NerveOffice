// sheet@1 的界面语言：只合并 zhCN（P4 设计 §3.6.2），各包的语言包按档案的插件列出
import type { ILanguagePack } from '@univerjs/core'
import { mergeLocales } from '@univerjs/core'
import DataValidationZhCN from '@univerjs/data-validation/locale/zh-CN'
import DesignZhCN from '@univerjs/design/locale/zh-CN'
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN'
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN'
import EngineFormulaZhCN from '@univerjs/engine-formula/locale/zh-CN'
import FindReplaceZhCN from '@univerjs/find-replace/locale/zh-CN'
import SheetsConditionalFormattingUIZhCN from '@univerjs/sheets-conditional-formatting-ui/locale/zh-CN'
import SheetsConditionalFormattingZhCN from '@univerjs/sheets-conditional-formatting/locale/zh-CN'
import SheetsDataValidationUIZhCN from '@univerjs/sheets-data-validation-ui/locale/zh-CN'
import SheetsDataValidationZhCN from '@univerjs/sheets-data-validation/locale/zh-CN'
import SheetsDrawingUIZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN'
import SheetsFilterUIZhCN from '@univerjs/sheets-filter-ui/locale/zh-CN'
import SheetsFilterZhCN from '@univerjs/sheets-filter/locale/zh-CN'
import SheetsFormulaUIZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN'
import SheetsFormulaZhCN from '@univerjs/sheets-formula/locale/zh-CN'
import SheetsHyperLinkUIZhCN from '@univerjs/sheets-hyper-link-ui/locale/zh-CN'
import SheetsHyperLinkZhCN from '@univerjs/sheets-hyper-link/locale/zh-CN'
import SheetsNoteUIZhCN from '@univerjs/sheets-note-ui/locale/zh-CN'
import SheetsNumfmtUIZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN'
import SheetsSortUIZhCN from '@univerjs/sheets-sort-ui/locale/zh-CN'
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN'
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN'
import UIZhCN from '@univerjs/ui/locale/zh-CN'

export const SHEET_ZH_CN: ILanguagePack = mergeLocales(
  DesignZhCN,
  UIZhCN,
  DocsUIZhCN,
  EngineFormulaZhCN,
  SheetsZhCN,
  SheetsUIZhCN,
  SheetsNumfmtUIZhCN,
  SheetsFormulaZhCN,
  SheetsFormulaUIZhCN,
  DrawingUIZhCN,
  SheetsDrawingUIZhCN,
  SheetsConditionalFormattingZhCN,
  SheetsConditionalFormattingUIZhCN,
  SheetsFilterZhCN,
  SheetsFilterUIZhCN,
  SheetsHyperLinkZhCN,
  SheetsHyperLinkUIZhCN,
  DataValidationZhCN,
  SheetsDataValidationZhCN,
  SheetsDataValidationUIZhCN,
  FindReplaceZhCN,
  SheetsNoteUIZhCN,
  SheetsSortUIZhCN,
)

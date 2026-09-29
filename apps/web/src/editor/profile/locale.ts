// sheet@1 的界面语言：只合并 zhCN（P4 设计 §3.6.2），各包的语言包按档案的插件列出
import type { ILanguagePack, LanguageValue } from '@univerjs/core'
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

/** 只读时被拦下的操作的说法：开头相同，后面按动作 */
const READ_ONLY = '这份文档只能查看，'

/**
 * 权限检查拦下操作时的提示，改成只读的说法（M2-P3 S3 的 E2E 发现之后）。SDK 的原文是给保护区域写的
 * （"该范围已被保护，目前无……权限。如需……，请联系创建者。"），而平台不用 SDK 的保护：保护的入口都隐藏（menu-config.ts），
 * 保护类资源必须为空、写入被拒绝（插件档案 v1 §3），所以这些提示只会在只读时出现（授权服务与只读守卫把权限点设为不允许）。
 * 键名按 1.0.1 的安装包核对（各包 locale/zh-CN 的 permission.dialog）；复制在两种打开方式都允许，
 * copyErr、workbookCopyErr 在平台里走不到，改成中性的说法。筛选与超链接的提示（"你没有权限……"）没有提保护，不改。
 * 只合并这些键，保护面板等其他文字不动
 */
export const READ_ONLY_PERMISSION_TEXTS: ILanguagePack = {
  'sheets': {
    permission: {
      dialog: {
        autoFillErr: `${READ_ONLY}不能自动填充。`,
        editErr: `${READ_ONLY}不能修改。`,
        formulaErr: `${READ_ONLY}不能修改。`,
        insertOrDeleteMoveRangeErr: `${READ_ONLY}不能插入或删除单元格。`,
        insertRowColErr: `${READ_ONLY}不能插入行列。`,
        moveRangeErr: `${READ_ONLY}不能移动单元格。`,
        moveRowColErr: `${READ_ONLY}不能移动行列。`,
        operatorSheetErr: `${READ_ONLY}不能调整工作表。`,
        removeRowColErr: `${READ_ONLY}不能删除行列。`,
        setRowColStyleErr: `${READ_ONLY}不能调整行列。`,
        setStyleErr: `${READ_ONLY}不能修改格式。`,
      },
    },
  },
  'sheets-ui': {
    permission: {
      dialog: {
        alertContent: `${READ_ONLY}不能修改。`,
        commonErr: `${READ_ONLY}不能进行这个操作。`,
        editErr: `${READ_ONLY}不能修改。`,
        pasteErr: `${READ_ONLY}不能粘贴。`,
        setStyleErr: `${READ_ONLY}不能修改格式。`,
        cutErr: `${READ_ONLY}不能剪切。`,
        setRowColStyleErr: `${READ_ONLY}不能调整行列。`,
        copyErr: '不能复制这里的内容。',
        workbookCopyErr: '不能复制这里的内容。',
      },
    },
  },
  'sheets-drawing-ui': { permission: { dialog: { editErr: `${READ_ONLY}不能修改图片。` } } },
  'sheets-conditional-formatting-ui': { permission: { dialog: { setStyleErr: `${READ_ONLY}不能修改条件格式。` } } },
  'sheets-data-validation-ui': { permission: { dialog: { setStyleErr: `${READ_ONLY}不能修改数据验证。` } } },
}

function isPack(value: LanguageValue | undefined): value is ILanguagePack {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深合并语言包：overrides 里的每个叶子覆盖 base 的同一路径，别的不动；base 里没有的路径报错（写错了键名、或 SDK 升级后改了名）。
 * SDK 的 mergeLocales 只合并第一层（Object.assign），覆盖深层的键要自己合并
 */
export function overrideLanguagePack(base: ILanguagePack, overrides: ILanguagePack, path = ''): ILanguagePack {
  const merged: ILanguagePack = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const at = path === '' ? key : `${path}.${key}`
    const original = base[key]
    if (original === undefined)
      throw new Error(`语言包里没有 ${at}：核对 SDK 的键名`)
    if (isPack(value)) {
      if (!isPack(original))
        throw new Error(`语言包里的 ${at} 不是一组文字：核对 SDK 的键名`)
      merged[key] = overrideLanguagePack(original, value, at)
    }
    else {
      merged[key] = value
    }
  }
  return merged
}

export const SHEET_ZH_CN: ILanguagePack = overrideLanguagePack(mergeLocales(
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
), READ_ONLY_PERMISSION_TEXTS)

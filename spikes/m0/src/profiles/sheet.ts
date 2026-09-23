// 表格候选档案（P1）：00 号计划书 §4.2 范围内的全部开源插件，按官方 preset 的顺序组装。
import type { EditorProfile, PluginEntry, ProfileOptions } from './types';

import { mergeLocales } from '@univerjs/core';
import { UniverDataValidationPlugin } from '@univerjs/data-validation';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import { UniverRPCMainThreadPlugin } from '@univerjs/rpc';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsConditionalFormattingPlugin } from '@univerjs/sheets-conditional-formatting';
import { UniverSheetsConditionalFormattingUIPlugin } from '@univerjs/sheets-conditional-formatting-ui';
import { UniverSheetsDataValidationPlugin } from '@univerjs/sheets-data-validation';
import { UniverSheetsDataValidationUIPlugin } from '@univerjs/sheets-data-validation-ui';
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing';
import { UniverSheetsDrawingUIPlugin } from '@univerjs/sheets-drawing-ui';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverSheetsFilterUIPlugin } from '@univerjs/sheets-filter-ui';
import { UniverSheetsFindReplacePlugin } from '@univerjs/sheets-find-replace';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui';
import { UniverSheetsHyperLinkPlugin } from '@univerjs/sheets-hyper-link';
import { UniverSheetsHyperLinkUIPlugin } from '@univerjs/sheets-hyper-link-ui';
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note';
import { UniverSheetsNoteUIPlugin } from '@univerjs/sheets-note-ui';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui';
import { UniverSheetsSortPlugin } from '@univerjs/sheets-sort';
import { UniverSheetsSortUIPlugin } from '@univerjs/sheets-sort-ui';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';
import { UniverUIPlugin } from '@univerjs/ui';

import DataValidationZhCN from '@univerjs/data-validation/locale/zh-CN';
import DesignZhCN from '@univerjs/design/locale/zh-CN';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN';
import FormulaZhCN from '@univerjs/engine-formula/locale/zh-CN';
import FindReplaceZhCN from '@univerjs/find-replace/locale/zh-CN';
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN';
import SheetsCFZhCN from '@univerjs/sheets-conditional-formatting/locale/zh-CN';
import SheetsCFUIZhCN from '@univerjs/sheets-conditional-formatting-ui/locale/zh-CN';
import SheetsDVZhCN from '@univerjs/sheets-data-validation/locale/zh-CN';
import SheetsDVUIZhCN from '@univerjs/sheets-data-validation-ui/locale/zh-CN';
import SheetsDrawingUIZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN';
import SheetsFilterZhCN from '@univerjs/sheets-filter/locale/zh-CN';
import SheetsFilterUIZhCN from '@univerjs/sheets-filter-ui/locale/zh-CN';
import SheetsFormulaZhCN from '@univerjs/sheets-formula/locale/zh-CN';
import SheetsFormulaUIZhCN from '@univerjs/sheets-formula-ui/locale/zh-CN';
import SheetsHyperLinkZhCN from '@univerjs/sheets-hyper-link/locale/zh-CN';
import SheetsHyperLinkUIZhCN from '@univerjs/sheets-hyper-link-ui/locale/zh-CN';
import SheetsNoteUIZhCN from '@univerjs/sheets-note-ui/locale/zh-CN';
import SheetsNumfmtUIZhCN from '@univerjs/sheets-numfmt-ui/locale/zh-CN';
import SheetsSortUIZhCN from '@univerjs/sheets-sort-ui/locale/zh-CN';
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN';
import UIZhCN from '@univerjs/ui/locale/zh-CN';

import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';
import '@univerjs/sheets-formula-ui/lib/index.css';
import '@univerjs/sheets-numfmt-ui/lib/index.css';
import '@univerjs/drawing-ui/lib/index.css';
import '@univerjs/sheets-drawing-ui/lib/index.css';
import '@univerjs/sheets-conditional-formatting-ui/lib/index.css';
import '@univerjs/sheets-data-validation-ui/lib/index.css';
import '@univerjs/sheets-filter-ui/lib/index.css';
import '@univerjs/sheets-sort-ui/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import '@univerjs/sheets-hyper-link-ui/lib/index.css';
import '@univerjs/sheets-note-ui/lib/index.css';

import '@univerjs/ui/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-ui/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-formula-ui/facade';
import '@univerjs/sheets-numfmt/facade';
import '@univerjs/sheets-drawing/facade';
import '@univerjs/sheets-drawing-ui/facade';
import '@univerjs/sheets-conditional-formatting/facade';
import '@univerjs/sheets-data-validation/facade';
import '@univerjs/sheets-filter/facade';
import '@univerjs/sheets-sort/facade';
import '@univerjs/sheets-find-replace/facade';
import '@univerjs/sheets-hyper-link/facade';
import '@univerjs/sheets-hyper-link-ui/facade';
import '@univerjs/sheets-note/facade';

function plugins({ container, createWorker }: ProfileOptions): PluginEntry[] {
    const useWorker = createWorker != null;
    const entries: (PluginEntry | null)[] = [
        // 核心：与 UniverSheetsCorePreset 相同，但不注册 UniverNetworkPlugin（没有任何插件使用它）。
        [UniverDocsPlugin],
        [UniverRenderEnginePlugin],
        [UniverUIPlugin, { container }],
        [UniverDocsUIPlugin],
        useWorker ? [UniverRPCMainThreadPlugin, { workerURL: createWorker() }] : null,
        [UniverFormulaEnginePlugin, { notExecuteFormula: useWorker }],
        [UniverSheetsPlugin, { notExecuteFormula: useWorker, onlyRegisterFormulaRelatedMutations: false }],
        [UniverSheetsUIPlugin],
        [UniverSheetsNumfmtPlugin],
        [UniverSheetsNumfmtUIPlugin],
        [UniverSheetsFormulaPlugin, { notExecuteFormula: useWorker }],
        [UniverSheetsFormulaUIPlugin],
        // 浮动图片与单元格图片
        [UniverDrawingPlugin],
        [UniverDocsDrawingPlugin],
        [UniverDrawingUIPlugin],
        [UniverSheetsDrawingPlugin],
        [UniverSheetsDrawingUIPlugin],
        // 条件格式
        [UniverSheetsConditionalFormattingPlugin],
        [UniverSheetsConditionalFormattingUIPlugin],
        // 筛选
        [UniverSheetsFilterPlugin],
        [UniverSheetsFilterUIPlugin],
        // 超链接
        [UniverSheetsHyperLinkPlugin],
        [UniverSheetsHyperLinkUIPlugin],
        // 数据验证
        [UniverDataValidationPlugin],
        [UniverSheetsDataValidationPlugin],
        [UniverSheetsDataValidationUIPlugin],
        // 查找替换
        [UniverFindReplacePlugin],
        [UniverSheetsFindReplacePlugin],
        // 备注
        [UniverSheetsNotePlugin],
        [UniverSheetsNoteUIPlugin],
        // 排序
        [UniverSheetsSortPlugin],
        [UniverSheetsSortUIPlugin],
    ];
    return entries.filter((e): e is PluginEntry => e != null);
}

export const sheetCandidateProfile: EditorProfile = {
    id: 'sheet@candidate-p1',
    kind: 'sheet',
    worker: 'formula',
    plugins,
    locale: mergeLocales(
        DesignZhCN,
        UIZhCN,
        DocsUIZhCN,
        FormulaZhCN,
        SheetsZhCN,
        SheetsUIZhCN,
        SheetsNumfmtUIZhCN,
        SheetsFormulaZhCN,
        SheetsFormulaUIZhCN,
        DrawingUIZhCN,
        SheetsDrawingUIZhCN,
        SheetsCFZhCN,
        SheetsCFUIZhCN,
        SheetsFilterZhCN,
        SheetsFilterUIZhCN,
        SheetsHyperLinkZhCN,
        SheetsHyperLinkUIZhCN,
        DataValidationZhCN,
        SheetsDVZhCN,
        SheetsDVUIZhCN,
        FindReplaceZhCN,
        SheetsNoteUIZhCN,
        SheetsSortUIZhCN,
    ),
};

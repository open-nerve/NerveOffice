// 表格插件档案 v1 草案（P2）：00 号计划书 §4.2 范围内的全部开源插件，按官方 preset 的顺序组装，按插件组组织。
import type { EditorProfile, PluginGroup } from './types';

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
import { CalculationMode, UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
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
import { sheetUi } from './ui-config';

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

const groups: PluginGroup[] = [
    {
        // 核心：与 UniverSheetsCorePreset 相同，但不注册 UniverNetworkPlugin（没有任何插件使用它）。
        id: 'core',
        resources: [
            'SHEET_AuthzIoMockService_PLUGIN',
            'SHEET_DEFINED_NAME_PLUGIN',
            'SHEET_RANGE_THEME_MODEL_PLUGIN',
            'SHEET_RANGE_PROTECTION_PLUGIN',
            'SHEET_WORKSHEET_PROTECTION_PLUGIN',
            'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
        ],
        removable: false,
        plugins: ({ container, createWorker, ui, largeSheetSplit, formulaIntervalCount }) => {
            const useWorker = createWorker != null;
            return [
                [UniverDocsPlugin],
                [UniverRenderEnginePlugin],
                [UniverUIPlugin, { container, menu: ui.menu, toolbar: ui.toolbar, contextMenu: ui.contextMenu }],
                [UniverDocsUIPlugin],
                useWorker ? [UniverRPCMainThreadPlugin, { workerURL: createWorker() }] : null,
                [UniverFormulaEnginePlugin, { notExecuteFormula: useWorker, intervalCount: formulaIntervalCount }],
                [UniverSheetsPlugin, {
                    notExecuteFormula: useWorker,
                    onlyRegisterFormulaRelatedMutations: false,
                    // 关掉拆分：复制大工作表时全部内容同步执行，不再走 syncOnly + 空闲时 onlyLocal 的懒执行（V06）
                    largeSheetOperation: largeSheetSplit ? undefined : { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER },
                }],
                [UniverSheetsUIPlugin, { footer: { menus: ui.footerMenus, addSheetButtonConfig: { show: ui.addSheetButton } } }],
            ];
        },
    },
    {
        id: 'numfmt',
        resources: [],
        removable: false,
        plugins: () => [[UniverSheetsNumfmtPlugin], [UniverSheetsNumfmtUIPlugin]],
    },
    {
        id: 'formula',
        resources: [],
        removable: false,
        plugins: ({ createWorker, calcMode }) => [
            [UniverSheetsFormulaPlugin, {
                notExecuteFormula: createWorker != null,
                initialFormulaComputing: calcMode === 'forced' ? CalculationMode.FORCED : undefined,
            }],
            [UniverSheetsFormulaUIPlugin],
        ],
    },
    {
        // 浮动图片与单元格图片
        id: 'drawing',
        resources: ['SHEET_DRAWING_PLUGIN'],
        removable: true,
        plugins: () => [
            [UniverDrawingPlugin],
            [UniverDocsDrawingPlugin],
            [UniverDrawingUIPlugin],
            [UniverSheetsDrawingPlugin],
            [UniverSheetsDrawingUIPlugin],
        ],
    },
    {
        id: 'cf',
        resources: ['SHEET_CONDITIONAL_FORMATTING_PLUGIN'],
        removable: true,
        plugins: () => [[UniverSheetsConditionalFormattingPlugin], [UniverSheetsConditionalFormattingUIPlugin]],
    },
    {
        id: 'filter',
        resources: ['SHEET_FILTER_PLUGIN'],
        removable: true,
        plugins: () => [[UniverSheetsFilterPlugin], [UniverSheetsFilterUIPlugin]],
    },
    {
        // 超链接存在单元格富文本的 customRanges 里，不走资源
        id: 'hyperlink',
        resources: [],
        removable: true,
        plugins: () => [[UniverSheetsHyperLinkPlugin], [UniverSheetsHyperLinkUIPlugin]],
    },
    {
        id: 'dv',
        resources: ['SHEET_DATA_VALIDATION_PLUGIN'],
        removable: true,
        plugins: () => [[UniverDataValidationPlugin], [UniverSheetsDataValidationPlugin], [UniverSheetsDataValidationUIPlugin]],
    },
    {
        id: 'find-replace',
        resources: [],
        removable: true,
        plugins: () => [[UniverFindReplacePlugin], [UniverSheetsFindReplacePlugin]],
    },
    {
        id: 'note',
        resources: ['SHEET_NOTE_PLUGIN'],
        removable: true,
        plugins: () => [[UniverSheetsNotePlugin], [UniverSheetsNoteUIPlugin]],
    },
    {
        id: 'sort',
        resources: [],
        removable: true,
        plugins: () => [[UniverSheetsSortPlugin], [UniverSheetsSortUIPlugin]],
    },
];

export const sheetProfile: EditorProfile = {
    id: 'sheet@1-draft',
    kind: 'sheet',
    sdkVersion: '1.0.0',
    worker: 'formula',
    groups,
    ui: sheetUi,
    // V06：类型声明为 MUTATION、实际只清除界面上的图片变换框的命令（不改内容）
    changeDetectionExclude: ['sheet.operation.clear-drawing-transformer'],
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

// 文字文档插件档案 v1 草案（P2）：00 号计划书 §4.3 范围内的开源插件，按官方 preset 的顺序组装，按插件组组织。
import type { EditorProfile, PluginGroup } from './types';

import { mergeLocales } from '@univerjs/core';
import { UniverDocsLayoutWorkerPlugin, UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing';
import { UniverDocsDrawingUIPlugin } from '@univerjs/docs-drawing-ui';
import { UniverDocsFindReplacePlugin } from '@univerjs/docs-find-replace';
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link';
import { UniverDocsHyperLinkUIPlugin } from '@univerjs/docs-hyper-link-ui';
import { UniverDocsTocPlugin } from '@univerjs/docs-toc';
import { UniverDocsTocUIPlugin } from '@univerjs/docs-toc-ui';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import { UniverUIPlugin } from '@univerjs/ui';

import DesignZhCN from '@univerjs/design/locale/zh-CN';
import DocsDrawingUIZhCN from '@univerjs/docs-drawing-ui/locale/zh-CN';
import DocsHyperLinkUIZhCN from '@univerjs/docs-hyper-link-ui/locale/zh-CN';
import DocsTocUIZhCN from '@univerjs/docs-toc-ui/locale/zh-CN';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN';
import FormulaZhCN from '@univerjs/engine-formula/locale/zh-CN';
import FindReplaceZhCN from '@univerjs/find-replace/locale/zh-CN';
import UIZhCN from '@univerjs/ui/locale/zh-CN';

import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/drawing-ui/lib/index.css';
import '@univerjs/docs-drawing-ui/lib/index.css';
import '@univerjs/docs-hyper-link-ui/lib/index.css';
import '@univerjs/find-replace/lib/index.css';
import '@univerjs/docs-toc-ui/lib/index.css';

import '@univerjs/ui/facade';
import '@univerjs/docs/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/docs-drawing/facade';
import '@univerjs/engine-formula/facade';

const groups: PluginGroup[] = [
    {
        // 核心：与 UniverDocsCorePreset 相同，但不注册 UniverNetworkPlugin。
        // 公式引擎在官方 preset 中存在，是否必需在 P5 核实。
        id: 'core',
        resources: ['DOC_WORD_STYLES_PLUGIN', 'DOC_NOTE_PLUGIN', 'SHEET_AuthzIoMockService_PLUGIN'],
        removable: false,
        plugins: ({ container }) => [
            [UniverDocsPlugin],
            [UniverRenderEnginePlugin],
            [UniverUIPlugin, { container }],
            [UniverDocsUIPlugin],
            [UniverFormulaEnginePlugin],
        ],
    },
    {
        // 可选：排版放到 Web Worker（官方示例中单独注册，是否启用由 P5 决定）
        id: 'layout-worker',
        resources: [],
        removable: true,
        plugins: ({ createWorker }) => [
            createWorker != null ? [UniverDocsLayoutWorkerPlugin, { workerFactory: createWorker }] : null,
        ],
    },
    {
        id: 'drawing',
        resources: ['DOC_DRAWING_PLUGIN'],
        removable: true,
        plugins: () => [[UniverDrawingPlugin], [UniverDrawingUIPlugin], [UniverDocsDrawingPlugin], [UniverDocsDrawingUIPlugin]],
    },
    {
        id: 'hyperlink',
        resources: ['DOC_HYPER_LINK_PLUGIN'],
        removable: true,
        plugins: () => [[UniverDocsHyperLinkPlugin], [UniverDocsHyperLinkUIPlugin]],
    },
    {
        id: 'find-replace',
        resources: [],
        removable: true,
        plugins: () => [[UniverFindReplacePlugin], [UniverDocsFindReplacePlugin]],
    },
    {
        // 目录（候选，是否纳入在 P5 决定）
        id: 'toc',
        resources: [],
        removable: true,
        plugins: () => [[UniverDocsTocPlugin], [UniverDocsTocUIPlugin]],
    },
];

export const docProfile: EditorProfile = {
    id: 'doc@1-draft',
    kind: 'doc',
    sdkVersion: '1.0.0',
    worker: 'layout',
    groups,
    locale: mergeLocales(
        DesignZhCN,
        UIZhCN,
        DocsUIZhCN,
        FormulaZhCN,
        DrawingUIZhCN,
        DocsDrawingUIZhCN,
        DocsHyperLinkUIZhCN,
        FindReplaceZhCN,
        DocsTocUIZhCN,
    ),
};

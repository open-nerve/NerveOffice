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
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFindReplacePlugin } from '@univerjs/find-replace';
import { UniverUIPlugin } from '@univerjs/ui';
import { docUi } from './ui-config';
import { docFormulaGroup, docFormulaLocale } from './doc-formula';
import { drawingPluginConfig } from './image-service';

import DesignZhCN from '@univerjs/design/locale/zh-CN';
import DocsDrawingUIZhCN from '@univerjs/docs-drawing-ui/locale/zh-CN';
import DocsHyperLinkUIZhCN from '@univerjs/docs-hyper-link-ui/locale/zh-CN';
import DocsTocUIZhCN from '@univerjs/docs-toc-ui/locale/zh-CN';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';
import DrawingUIZhCN from '@univerjs/drawing-ui/locale/zh-CN';
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

const groups: PluginGroup[] = [
    {
        // 核心：与 UniverDocsCorePreset 相同，但不注册 UniverNetworkPlugin；公式引擎单独成组（P5）。
        id: 'core',
        // 运行时核对（V03）：docs 插件注册 Word 元数据透传的两项与文档权限规则；文字文档不写 SHEET_AuthzIoMockService_PLUGIN
        resources: ['DOC_WORD_STYLES_PLUGIN', 'DOC_NOTE_PLUGIN', 'DOC_OBJECT_PERMISSION_PLUGIN'],
        removable: false,
        plugins: ({ container, ui, outline }) => [
            [UniverDocsPlugin],
            [UniverRenderEnginePlugin],
            [UniverUIPlugin, { container, menu: ui.menu, toolbar: ui.toolbar, contextMenu: ui.contextMenu }],
            // toc：只读的大纲侧栏（按标题导航，不写内容），P5 评估"目录"的两种形态
            [UniverDocsUIPlugin, { toc: outline === true }],
        ],
    },
    // 公式引擎（官方 preset 中存在；P5 核实文字文档不需要它）
    docFormulaGroup,
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
        plugins: ({ imageService }) => [[UniverDrawingPlugin, drawingPluginConfig(imageService)], [UniverDrawingUIPlugin], [UniverDocsDrawingPlugin], [UniverDocsDrawingUIPlugin]],
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
        // 目录块（在正文里插入目录，写入 FIELD、HYPERLINK 区间）：P5 结论为 doc@1 不纳入，"目录"由只读的大纲侧栏提供（docs-ui 的 toc 配置）。
        // 保留这一组只为评估（页面参数 tocblock=1）。
        id: 'toc',
        resources: [],
        removable: true,
        plugins: ({ tocBlock }) => (tocBlock === true ? [[UniverDocsTocPlugin], [UniverDocsTocUIPlugin]] : []),
    },
];

export const docProfile: EditorProfile = {
    id: 'doc@1-draft',
    kind: 'doc',
    sdkVersion: '1.0.0',
    worker: 'layout',
    groups,
    ui: docUi,
    // V06：类型声明为 MUTATION、实际只清除界面上的图片变换框的命令（不改内容）
    changeDetectionExclude: ['doc.operation.clear-drawing-transformer'],
    locale: mergeLocales(
        DesignZhCN,
        UIZhCN,
        DocsUIZhCN,
        docFormulaLocale,
        DrawingUIZhCN,
        DocsDrawingUIZhCN,
        DocsHyperLinkUIZhCN,
        FindReplaceZhCN,
        DocsTocUIZhCN,
    ),
};

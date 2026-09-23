// 文字文档候选档案（P1）：00 号计划书 §4.3 范围内的开源插件，按官方 preset 的顺序组装。
import type { EditorProfile, PluginEntry, ProfileOptions } from './types';

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

function plugins({ container, createWorker }: ProfileOptions): PluginEntry[] {
    const entries: (PluginEntry | null)[] = [
        // 核心：与 UniverDocsCorePreset 相同，但不注册 UniverNetworkPlugin。
        // 公式引擎在官方 preset 中存在，是否必需在 P5 核实。
        [UniverDocsPlugin],
        [UniverRenderEnginePlugin],
        [UniverUIPlugin, { container }],
        [UniverDocsUIPlugin],
        [UniverFormulaEnginePlugin],
        // 可选：排版放到 Web Worker（官方示例中单独注册）。
        createWorker != null ? [UniverDocsLayoutWorkerPlugin, { workerFactory: createWorker }] : null,
        // 图片
        [UniverDrawingPlugin],
        [UniverDrawingUIPlugin],
        [UniverDocsDrawingPlugin],
        [UniverDocsDrawingUIPlugin],
        // 超链接
        [UniverDocsHyperLinkPlugin],
        [UniverDocsHyperLinkUIPlugin],
        // 查找替换
        [UniverFindReplacePlugin],
        [UniverDocsFindReplacePlugin],
        // 目录（候选，是否纳入在 P5 决定）
        [UniverDocsTocPlugin],
        [UniverDocsTocUIPlugin],
    ];
    return entries.filter((e): e is PluginEntry => e != null);
}

export const docCandidateProfile: EditorProfile = {
    id: 'doc@candidate-p1',
    kind: 'doc',
    worker: 'layout',
    plugins,
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

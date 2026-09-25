// 文字文档的公式引擎组（P5）：文字文档启用的插件都不依赖公式引擎，官方 preset 只是顺带注册（P5 报告 §5）。
// 单独成组，用 without=formula 验证去掉它；包体积的差异由 scripts/p5-doc-bundle.ts 另行测量。
import type { PluginGroup } from './types';

import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import FormulaZhCN from '@univerjs/engine-formula/locale/zh-CN';

import '@univerjs/engine-formula/facade';

export const docFormulaGroup: PluginGroup = {
    id: 'formula',
    resources: [],
    removable: true,
    plugins: () => [[UniverFormulaEnginePlugin]],
};

export const docFormulaLocale = FormulaZhCN;

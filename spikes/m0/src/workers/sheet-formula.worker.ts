// 表格公式 Worker：与官方 UniverSheetsCoreWorkerPreset + UniverSheetsFilterWorkerPreset 的插件组合一致。
// P4：IMAGE() 的处理由页面经 Worker 的 name 传入（imagefn=off|restricted），Worker 里的计算用它。
import { LocaleType, LogLevel, Univer } from '@univerjs/core';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRPCWorkerThreadPlugin } from '@univerjs/rpc';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsFilterPlugin } from '@univerjs/sheets-filter';
import { UniverRemoteSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { installImageFunctionPolicy, policyFromWorkerName } from '../harness/image-function-policy';

const univer = new Univer({ locale: LocaleType.ZH_CN, logLevel: LogLevel.WARN });
univer.registerPlugin(UniverSheetsPlugin, { onlyRegisterFormulaRelatedMutations: true });
univer.registerPlugin(UniverFormulaEnginePlugin);
univer.registerPlugin(UniverRPCWorkerThreadPlugin);
univer.registerPlugin(UniverRemoteSheetsFormulaPlugin);
univer.registerPlugin(UniverSheetsFilterPlugin);

installImageFunctionPolicy(univer.__getInjector(), policyFromWorkerName(self.name));

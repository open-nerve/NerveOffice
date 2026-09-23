// 资源加载错误捕获（V04 验证的防护机制原型）：通过依赖注入覆盖 IResourceManagerService，
// 包装每个资源 hook 的 parseJson 与 onLoad。两条加载路径（文档创建时的 loadResources、
// 插件晚注册时的 loadHookResource）调用的都是注册进来的 hook，所以都能覆盖。
// 能识别三种失败：parseJson 抛错、parseJson 把非空输入吞成空值（多数插件的做法）、onLoad 抛错。
import type { IResourceHook } from '@univerjs/core';

import { ILogService, ResourceManagerService, setDependencies } from '@univerjs/core';
import { isEmptyResourceData, isEmptyValue } from './resource-guard';

export interface ResourceLoadFailure {
    name: string;
    kind: 'parse-threw' | 'parse-swallowed' | 'load-threw';
    unitId?: string;
    message: string;
}

export const resourceLoadFailures: ResourceLoadFailure[] = [];

const messageOf = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export class GuardedResourceManagerService extends ResourceManagerService {
    override registerPluginResource<T = unknown>(hook: IResourceHook<T>) {
        const name = hook.pluginName;
        const wrapped: IResourceHook<T> = {
            ...hook,
            parseJson: (json: string) => {
                let value: T;
                try {
                    value = hook.parseJson(json);
                } catch (e) {
                    resourceLoadFailures.push({ name, kind: 'parse-threw', message: messageOf(e) });
                    throw e;
                }
                if (!isEmptyResourceData(json) && isEmptyValue(value)) {
                    resourceLoadFailures.push({ name, kind: 'parse-swallowed', message: `非空输入（${String(json).length} 字符）被解析为空值` });
                }
                return value;
            },
            onLoad: (unitId: string, value: T) => {
                try {
                    hook.onLoad(unitId, value);
                } catch (e) {
                    resourceLoadFailures.push({ name, kind: 'load-threw', unitId, message: messageOf(e) });
                    throw e;
                }
            },
        };
        return super.registerPluginResource(wrapped);
    }
}

// 与父类相同的构造依赖（本文件不使用装饰器）
setDependencies(GuardedResourceManagerService, [ILogService]);

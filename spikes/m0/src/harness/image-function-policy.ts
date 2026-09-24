// IMAGE() 公式的限制（P4，00 号计划书 §11.3）：主线程与公式 Worker 共用（这个模块不依赖 DOM）。
// - default：SDK 原样，任何地址都会被当作图片加载；
// - off：反注册 IMAGE，并从函数说明（自动补全）里去掉；公式得到 #NAME?；
// - restricted：取出原有的 IMAGE 执行器，注册一个同名的包装：参数是平台资源地址时交给原执行器，否则返回 #VALUE!，
//   不产生任何请求；保留 SDK 对尺寸等参数的处理。
// 内置函数在 FormulaController 构造时注册（引擎插件 onReady，engine-formula/src/controllers/formula.controller.ts:135-147），
// 所以要在生命周期到达 Ready 之后安装；安装后再核对一次，防止被晚到的注册覆盖。
import type { Injector } from '@univerjs/core';
import type { BaseValueObject } from '@univerjs/engine-formula';

import { LifecycleService, LifecycleStages } from '@univerjs/core';
import { BaseFunction, ErrorType, ErrorValueObject, IDescriptionService, IFunctionService } from '@univerjs/engine-formula';
import { filter, take } from 'rxjs';

export type ImageFunctionPolicy = 'default' | 'off' | 'restricted';

const IMAGE = 'IMAGE';
const PLATFORM_ASSET = /^\/api\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 平台资源地址：相对地址，或本站的绝对地址（Worker 里 location 也是同源的）。 */
export function isPlatformAssetUrl(value: string): boolean {
    if (PLATFORM_ASSET.test(value)) return true;
    const origin = typeof location !== 'undefined' ? location.origin : '';
    return origin !== '' && value.startsWith(origin) && PLATFORM_ASSET.test(value.slice(origin.length));
}

class RestrictedImageFunction extends BaseFunction {
    constructor(private readonly _original: BaseFunction) {
        super(IMAGE as never);
        this.minParams = _original.minParams;
        this.maxParams = _original.maxParams;
    }

    override calculate(source: BaseValueObject, ...rest: BaseValueObject[]): BaseValueObject {
        const guard = (v: BaseValueObject): BaseValueObject => (v.isString() && !isPlatformAssetUrl(String(v.getValue())) ? ErrorValueObject.create(ErrorType.VALUE) : v);
        if (source.isArray()) {
            return (this._original.calculate as (...args: BaseValueObject[]) => BaseValueObject)((source as unknown as { mapValue(fn: (v: BaseValueObject) => BaseValueObject): BaseValueObject }).mapValue(guard), ...rest);
        }
        const checked = guard(source);
        if (checked.isError()) return checked;
        return (this._original.calculate as (...args: BaseValueObject[]) => BaseValueObject)(source, ...rest);
    }
}

function apply(injector: Injector, policy: ImageFunctionPolicy): boolean {
    const functions = injector.get(IFunctionService);
    const current = functions.getExecutor(IMAGE as never);
    if (policy === 'off') {
        if (current == null) return true;
        functions.unregisterExecutors(IMAGE as never);
        functions.deleteFormulaAstCacheKey(IMAGE as never);
        if (injector.has(IDescriptionService)) injector.get(IDescriptionService).unregisterDescriptions([IMAGE]);
        return functions.getExecutor(IMAGE as never) == null;
    }
    if (current instanceof RestrictedImageFunction) return true;
    if (current == null) return false;
    functions.registerExecutors(new RestrictedImageFunction(current));
    functions.deleteFormulaAstCacheKey(IMAGE as never);
    return functions.getExecutor(IMAGE as never) instanceof RestrictedImageFunction;
}

/** 在生命周期到达 Ready 后安装，回调报告安装结果（验证用）。 */
export function installImageFunctionPolicy(injector: Injector, policy: ImageFunctionPolicy, report?: (ok: boolean) => void): void {
    if (policy === 'default') return;
    injector.get(LifecycleService).lifecycle$.pipe(filter((stage) => stage >= LifecycleStages.Ready), take(1)).subscribe(() => {
        const ok = apply(injector, policy);
        // 核对：同一轮生命周期里若还有晚到的注册覆盖了它，再装一次
        setTimeout(() => report?.(apply(injector, policy) && ok), 0);
    });
}

/** Worker 通过 name 传入策略（例如 "imagefn=restricted"），见 src/entries/sheet.tsx。 */
export function policyFromWorkerName(name: string): ImageFunctionPolicy {
    const m = /imagefn=(off|restricted)/.exec(name);
    return (m?.[1] as ImageFunctionPolicy | undefined) ?? 'default';
}

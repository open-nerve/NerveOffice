// CSP 阳性对照使用的探测动作：页面与 Worker 共用。只用于验证 CSP 是否生效，不代表产品行为。

export type ProbeOutcome = 'allowed' | `blocked:${string}` | 'unexpected';

export interface ProbeResult {
    fetch: ProbeOutcome;
    eval: ProbeOutcome;
    fn: ProbeOutcome;
}

/** no-cors 跨源请求：目标可达时应当成功；被 connect-src 拦截时抛 TypeError。 */
async function tryFetch(url: string): Promise<ProbeOutcome> {
    try {
        await fetch(url, { mode: 'no-cors', cache: 'no-store' });
        return 'allowed';
    } catch (error) {
        return `blocked:${(error as Error)?.name ?? 'unknown'}`;
    }
}

function tryEval(): ProbeOutcome {
    try {
        // eslint-disable-next-line no-eval
        return (0, eval)('1 + 1') === 2 ? 'allowed' : 'unexpected';
    } catch (error) {
        return `blocked:${(error as Error)?.name ?? 'unknown'}`;
    }
}

function tryFunction(): ProbeOutcome {
    try {
        // eslint-disable-next-line no-new-func
        return new Function('return 2')() === 2 ? 'allowed' : 'unexpected';
    } catch (error) {
        return `blocked:${(error as Error)?.name ?? 'unknown'}`;
    }
}

export async function runProbes(target: string): Promise<ProbeResult> {
    // 放在 await 之后执行，避免与调用方的同步求值阶段混在一起。
    await Promise.resolve();
    const fetchOutcome = await tryFetch(target);
    return { fetch: fetchOutcome, eval: tryEval(), fn: tryFunction() };
}

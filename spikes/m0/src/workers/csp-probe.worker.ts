// CSP 阳性对照：在 Worker 作用域内发起跨源请求与动态代码执行。
import { runProbes } from '../harness/csp-probe-actions';

self.onmessage = async (event: MessageEvent<{ target: string }>) => {
    self.postMessage(await runProbes(event.data.target));
};

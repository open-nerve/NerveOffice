// 00 号计划书 §11.3 的起点策略（强制），以及用于检验每项放宽是否必要的探测策略（只报告）。

export const ENFORCED_POLICY = [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

/** 比强制策略更严：去掉 style-src 的 'unsafe-inline'、img/font 的 data:、img/worker 的 blob:。 */
export const PROBE_POLICY = [
    "default-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');

export function cspHeaders(mode: 'full' | 'off'): Record<string, string> {
    if (mode === 'off') return {};
    return {
        'Content-Security-Policy': `${ENFORCED_POLICY}; report-uri /csp-report?policy=enforce`,
        'Content-Security-Policy-Report-Only': `${PROBE_POLICY}; report-uri /csp-report?policy=probe`,
    };
}

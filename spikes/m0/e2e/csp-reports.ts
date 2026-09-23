// CSP 违规记录的统一格式：页面事件、服务端 report-uri 报告、控制台消息三条渠道。
import type { APIRequestContext } from '@playwright/test';
import type { ConsoleRecord } from './helpers';

import { classifyCspConsole } from './helpers';

export interface Violation {
    channel: 'page-event' | 'server-report' | 'console';
    scope: 'page' | 'worker';
    policy: 'enforce' | 'probe';
    directive: string;
    blocked: string;
    sourceFile: string;
    line: number;
}

export function blockedKind(uri: string): string {
    if (!uri) return '';
    if (['inline', 'eval', 'wasm-eval', 'data', 'blob'].includes(uri)) return uri;
    if (uri.startsWith('data:')) return 'data';
    if (uri.startsWith('blob:')) return 'blob';
    try {
        const u = new URL(uri);
        return `${u.origin}${u.pathname.replace(/[^/]+$/, '*')}`;
    } catch {
        return uri;
    }
}

function stripOrigin(file: string): string {
    return file.replace(/^https?:\/\/[^/]+/, '');
}

/** 按脚本路径识别 Worker（Vite 产物命名为 *.worker-<hash>.js）；不能匹配整个 URL，页面地址里的 worker=1 会误判。 */
function isWorkerUrl(u: string): boolean {
    try {
        return /\.worker-[\w-]+\.js$/.test(new URL(u).pathname);
    } catch {
        return false;
    }
}

export function fromPageEvents(events: { effectiveDirective: string; blockedURI: string; sourceFile: string; lineNumber: number; disposition: string }[]): Violation[] {
    return events.map((v) => ({
        channel: 'page-event',
        scope: 'page',
        policy: v.disposition === 'enforce' ? 'enforce' : 'probe',
        directive: v.effectiveDirective,
        blocked: blockedKind(v.blockedURI),
        sourceFile: stripOrigin(v.sourceFile),
        line: v.lineNumber,
    }));
}

/** 服务端收到的报告：兼容 report-uri 旧格式与 Reporting API 格式。document-uri 为 Worker 脚本时记为 Worker 作用域。 */
export async function fromServer(request: APIRequestContext, baseURL: string): Promise<Violation[]> {
    const res = await request.get(`${baseURL}/__csp-reports`);
    const list = (await res.json()) as { policy: string; body: any }[];
    return list.map((r) => {
        const legacy = r.body?.['csp-report'];
        const b = legacy ?? r.body?.body ?? r.body;
        const documentUri: string = b?.['document-uri'] ?? b?.documentURL ?? '';
        return {
            channel: 'server-report',
            scope: isWorkerUrl(documentUri) ? 'worker' : 'page',
            policy: r.policy === 'enforce' ? 'enforce' : 'probe',
            directive: b?.['effective-directive'] ?? b?.effectiveDirective ?? b?.['violated-directive'] ?? '',
            blocked: blockedKind(b?.['blocked-uri'] ?? b?.blockedURL ?? ''),
            sourceFile: stripOrigin(b?.['source-file'] ?? b?.sourceFile ?? ''),
            line: Number(b?.['line-number'] ?? b?.lineNumber ?? 0),
        };
    });
}

/** 控制台里的 CSP 提示：只能拿到文本，指令与被拦截地址按关键字粗略提取。 */
export function fromConsole(list: ConsoleRecord[]): Violation[] {
    const out: Violation[] = [];
    // WebKit 会把 Worker 的控制台消息同时发给页面与 Worker 两个监听器，且页面那份没有位置信息：去掉这份重复
    const workerTexts = new Set(list.filter((m) => m.scope === 'worker').map((m) => m.text));
    for (const m of list) {
        if (m.scope === 'page' && m.url === '' && workerTexts.has(m.text)) continue;
        const policy = classifyCspConsole(m.text);
        if (policy == null) continue;
        const directive = /(connect-src|script-src|style-src(?:-elem|-attr)?|img-src|font-src|worker-src|default-src)/.exec(m.text)?.[1] ?? '';
        const blocked = /eval/i.test(m.text) ? 'eval' : /data:/.test(m.text) ? 'data' : (/https?:\/\/[^\s'"]+/.exec(m.text)?.[0] ?? '');
        out.push({
            channel: 'console',
            scope: m.scope === 'worker' || isWorkerUrl(m.url) ? 'worker' : 'page',
            policy,
            directive,
            blocked: blockedKind(blocked),
            sourceFile: stripOrigin(m.url),
            line: 0,
        });
    }
    return out;
}

export function groupViolations(list: Violation[]) {
    const groups = new Map<string, Violation & { count: number }>();
    for (const v of list) {
        const key = `${v.channel}|${v.scope}|${v.policy}|${v.directive}|${v.blocked}|${v.sourceFile}`;
        const g = groups.get(key) ?? { ...v, count: 0 };
        g.count++;
        groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count).map(({ line: _line, ...rest }) => rest);
}

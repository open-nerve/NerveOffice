// 尽早安装：收集 CSP 违规、未捕获错误与控制台错误，供验证脚本断言。
// 入口文件必须第一个 import 本模块，使监听先于 Univer 代码执行。

export interface CspViolationRecord {
    directive: string;
    effectiveDirective: string;
    blockedURI: string;
    sourceFile: string;
    lineNumber: number;
    disposition: string;
    sample: string;
}

export interface PageEvents {
    cspViolations: CspViolationRecord[];
    errors: string[];
    consoleErrors: string[];
    consoleWarnings: string[];
}

export const pageEvents: PageEvents = { cspViolations: [], errors: [], consoleErrors: [], consoleWarnings: [] };

document.addEventListener('securitypolicyviolation', (e) => {
    pageEvents.cspViolations.push({
        directive: e.violatedDirective,
        effectiveDirective: e.effectiveDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
        disposition: e.disposition,
        sample: e.sample,
    });
});

window.addEventListener('error', (e) => {
    pageEvents.errors.push(`${e.message} @ ${e.filename}:${e.lineno}`);
});

window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason);
    pageEvents.errors.push(`unhandledrejection: ${reason}`);
});

function stringify(args: unknown[]): string {
    return args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJson(a))).join(' ');
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
    pageEvents.consoleErrors.push(stringify(args));
    originalError(...args);
};

const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
    pageEvents.consoleWarnings.push(stringify(args));
    originalWarn(...args);
};

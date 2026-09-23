// 在真实 Safari 中运行自检（Playwright 只能驱动自带的 WebKit，无法驱动真实 Safari）。
// 启动三个验证服务，用 `open -g -a Safari` 在后台打开自检链接；页面依次完成四个编辑场景，
// 以及三种 CSP 模式下的阳性对照，把结果交回服务。脚本汇总后写入 e2e/results/v02/safari/。
// 用法：先 vite build，再 node scripts/safari-selftest.ts（会在 Safari 中留下一个停在入口页的标签页）
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'e2e', 'results', 'v02', 'safari');
const PORTS = { full: 4710, off: 4711, 'html-only': 4712 } as const;
type Mode = keyof typeof PORTS;
const base = (mode: Mode) => `http://127.0.0.1:${PORTS[mode]}`;

const servers = (Object.keys(PORTS) as Mode[]).map((mode) =>
    spawn('node', ['server/serve.ts', '--port', String(PORTS[mode]), '--csp', mode], { cwd: ROOT, stdio: 'ignore' }),
);
const stopServers = () => servers.forEach((s) => s.kill());
process.on('exit', stopServers);

async function waitUntilUp(url: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(url)).ok) return;
        } catch {
            // 服务还没起来
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`服务没有启动：${url}`);
}

for (const mode of Object.keys(PORTS) as Mode[]) {
    await waitUntilUp(`${base(mode)}/index.html`);
    await fetch(`${base(mode)}/__selftest`, { method: 'DELETE' });
    await fetch(`${base(mode)}/__csp-reports`, { method: 'DELETE' });
}

const steps: { mode: Mode; path: string; id: string }[] = [
    { mode: 'full', id: 'sheet-main', path: '/sheet.html?sample=minimal&selftest=sheet-main' },
    { mode: 'full', id: 'sheet-worker', path: '/sheet.html?sample=minimal&worker=1&selftest=sheet-worker' },
    { mode: 'full', id: 'doc-main', path: '/doc.html?sample=minimal&selftest=doc-main' },
    { mode: 'full', id: 'doc-worker', path: '/doc.html?sample=minimal&worker=1&selftest=doc-worker' },
    { mode: 'full', id: 'probe-full', path: `/csp-probe.html?report=full&target=${encodeURIComponent(`${base('off')}/index.html`)}` },
    { mode: 'html-only', id: 'probe-html-only', path: `/csp-probe.html?report=html-only&target=${encodeURIComponent(`${base('off')}/index.html`)}` },
    { mode: 'off', id: 'probe-off', path: `/csp-probe.html?report=off&target=${encodeURIComponent(`${base('full')}/index.html`)}` },
];
// 从后往前串起 next，最后停在入口页
let next = `${base('off')}/index.html`;
const urls: string[] = [];
for (let i = steps.length - 1; i >= 0; i--) {
    const url = `${base(steps[i].mode)}${steps[i].path}&next=${encodeURIComponent(next)}`;
    urls.unshift(url);
    next = url;
}

const safariVersion = execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim();
console.log(`在 Safari ${safariVersion} 中打开自检（后台打开）：${urls[0]}`);
execFileSync('open', ['-g', '-a', 'Safari', urls[0]]);

type Entry = { kind: string; scenario?: string; mode?: string; timestamp: string; [k: string]: unknown };
const collected = new Map<Mode, Entry[]>();
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
    let total = 0;
    for (const mode of Object.keys(PORTS) as Mode[]) {
        const list = (await (await fetch(`${base(mode)}/__selftest`)).json()) as Entry[];
        collected.set(mode, list);
        total += list.length;
    }
    if (total >= steps.length) break;
    await new Promise((r) => setTimeout(r, 1000));
}

const reports = new Map<Mode, { policy: string; receivedAt: string; body: any }[]>();
for (const mode of ['full', 'html-only'] as Mode[]) {
    reports.set(mode, await (await fetch(`${base(mode)}/__csp-reports`)).json());
}
stopServers();

await mkdir(OUT, { recursive: true });
const summary: Record<string, unknown>[] = [];
let prevTime = '';
for (const step of steps) {
    const entries = collected.get(step.mode) ?? [];
    const entry = entries.find((e) => (e.kind === 'editor' ? e.scenario === step.id : `probe-${e.mode}` === step.id));
    if (entry == null) {
        summary.push({ id: step.id, status: 'missing' });
        continue;
    }
    // 按时间窗把服务端报告归到对应的一步（同一个服务上的各步依次执行）
    const windowReports = (reports.get(step.mode) ?? []).filter((r) => r.receivedAt > prevTime && r.receivedAt <= entry.timestamp);
    prevTime = entry.timestamp;
    const events = (entry.events as { cspViolations: { disposition: string }[]; errors: string[]; consoleErrors: string[] } | undefined);
    const record = {
        check: 'V02-safari',
        step: step.id,
        csp: step.mode,
        safariVersion,
        ...entry,
        serverReports: windowReports.map((r) => ({ policy: r.policy, body: r.body })),
        enforceViolations: {
            pageEvents: events?.cspViolations.filter((v) => v.disposition === 'enforce').length ?? 0,
            serverReports: windowReports.filter((r) => r.policy === 'enforce').length,
        },
    };
    await writeFile(join(OUT, `${step.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    summary.push({
        id: step.id,
        status: 'ok',
        checks: Array.isArray(entry.checks) ? (entry.checks as { pass: boolean }[]).every((c) => c.pass) : undefined,
        error: entry.error,
        page: entry.page,
        worker: entry.worker,
        enforceViolations: record.enforceViolations,
        pageErrors: events?.errors.length ?? 0,
        scriptConsoleErrors: events?.consoleErrors.length ?? 0,
    });
}
await writeFile(join(OUT, 'summary.json'), `${JSON.stringify({ safariVersion, timestamp: new Date().toISOString(), steps: summary }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(0);

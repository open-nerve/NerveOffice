// P4：把 V11、V12 的结果文件汇总成报告用的表格（Markdown），报告中的数字都可以用它重新得出。
// 用法：先跑完 P4 的用例，再 node scripts/p4-summary.ts [章节…]，章节为 paths assets limits validate fallback formula external degradation csp，缺省为全部。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, any>;

const RESULTS = join(import.meta.dirname, '..', 'e2e', 'results');
const BROWSERS = ['chromium', 'chrome', 'webkit'];

function load(dir: string): { file: string; data: Json }[] {
    const full = join(RESULTS, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, data: JSON.parse(readFileSync(join(full, f), 'utf8')) as Json }));
}

const browserOf = (file: string) => BROWSERS.find((b) => file.startsWith(`${b}-`) || file === `${b}.json`) ?? '?';
const table = (head: string[], rows: string[][]) =>
    [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
/** 三个浏览器的值相同就只写一次，否则按浏览器列出。 */
function merged(values: { browser: string; value: string }[]): string {
    const distinct = [...new Set(values.map((v) => v.value))];
    if (distinct.length <= 1) return distinct[0] ?? '—';
    return values.map((v) => `${v.browser}：${v.value}`).join('；');
}

function paths(): string {
    const list = load('v11/paths');
    const ids = [...new Set(list.map((x) => x.data.case.id))];
    const rows = ids.map((id) => {
        const of = (img: string) => list.filter((x) => x.data.case.id === id && x.data.img === img);
        const any = list.find((x) => x.data.case.id === id)!.data;
        const verdict = (img: string) => merged(of(img).map((x) => ({ browser: browserOf(x.file), value: x.data.verdict })));
        const events = merged(of('platform').map((x) => ({ browser: browserOf(x.file), value: [...new Set((x.data.imageEvents as Json[]).map((e) => `${e.kind}${e.ok ? '' : '（失败）'}`))].join('、') || '—' })));
        const enforce = (img: string) => merged(of(img).map((x) => ({ browser: browserOf(x.file), value: String((x.data.cspViolations as Json[]).filter((v) => v.disposition === 'enforce').length) })));
        const errors = (img: string) => merged(of(img).map((x) => ({ browser: browserOf(x.file), value: String((x.data.pageErrors as string[]).length + (x.data.actionError ? 1 : 0)) })));
        return [id, any.case.method, any.case.what, verdict('default'), `${enforce('default')} / ${errors('default')}`, verdict('platform'), events, `${enforce('platform')} / ${errors('platform')}`];
    });
    return ['## V11 图片路径矩阵（严格 CSP）', table(['编号', '方式', '路径', 'default：新增图片', 'default：CSP 强制违规 / 页面错误', 'platform：新增图片', 'platform：平台的处理', 'platform：CSP 强制违规 / 页面错误'], rows)].join('\n\n');
}

function assets(): string {
    const list = load('v11/assets');
    const rows = list.map((x) => {
        const d = x.data;
        const ok = (reads: Json[], status: number) => (reads.length > 0 && reads.every((r) => r.status === status) ? `${status} × ${reads.length}` : reads.map((r) => r.status).join('、') || '无');
        return [
            browserOf(x.file), d.kind,
            `${ok(d.sameSession.reads, 200)}（带会话：${d.sameSession.reads.every((r: Json) => r.hasSession) ? '是' : '否'}）`,
            `${ok(d.otherSession.reads, 200)}；未保存的图片 ${d.otherSession.orphanStatus}；上传者本人 ${d.otherSession.orphanStatusForUploader}`,
            `文件 ${d.copy.filesBefore}→${d.copy.filesAfter}；引用 ${d.copy.links.length}；原文档删除后 ${d.copy.statusAfterSourceDeleted}`,
            `${ok(d.noCookie.reads, 401)}；页面错误 ${d.noCookie.errors.length}`,
        ];
    });
    return ['## V11 同源读取与授权', table(['浏览器', '文档', '同一会话重开', '另一个会话', '复制文档', '没有会话 Cookie'], rows)].join('\n\n');
}

function limits(): string {
    const list = load('v11/limits');
    const rows = list.flatMap((x) => (x.data.results as Json[]).map((r) => [browserOf(x.file), r.kind, r.case, String(r.added), (r.uploads as Json[]).map((u) => `${u.status}${u.reason ? `（${u.reason}）` : ''}`).join('、') || '没有上传', (r.messages as string[]).join('、') || '—', String((r.errors as string[]).length)]));
    return ['## V11 上传失败与限制', table(['浏览器', '文档', '情形', '新增图片', '上传', '提示', '页面错误'], rows)].join('\n\n');
}

function validate(): string {
    const list = load('v11/validate');
    const rows = list.flatMap((x) => (x.data.results as Json[]).map((r) => [browserOf(x.file), r.kind, r.img, String(r.status)]));
    return ['## V11 服务端的保存校验', table(['浏览器', '文档', '图片服务', '保存（validate=1）'], rows)].join('\n\n');
}

function fallback(): string {
    const list = load('v11/fallback');
    const rows = list.map((x) => {
        const runs = x.data.results as Json[];
        const count = (server: string) => runs.filter((r) => r.server === server).map((r) => String((r.errors as string[]).length)).join('、');
        return [browserOf(x.file), x.data.kind, count('error-status'), count('placeholder')];
    });
    return ['## V11 读取失败时的页面错误（没有会话，各打开 3 次）', table(['浏览器', '文档', '返回错误状态码', '返回占位图'], rows)].join('\n\n');
}

function formula(): string {
    const list = load('v12/image-formula');
    const rows = list.flatMap((x) => (x.data.runs as Json[]).map((r) => [
        browserOf(x.file), x.data.policy, x.data.worker ? 'Worker' : '主线程', r.csp,
        r.display.external, r.display.platform === '\r\b' ? '图片' : r.display.platform, r.display.data === '\r\b' ? '图片' : r.display.data,
        String((r.externalRequests as string[]).length), (r.cspEnforced as string[]).length === 0 ? '—' : String((r.cspEnforced as string[]).length),
        (r.snapshot as Json[]).every((s) => s.f != null && !s.hasP) ? '只有公式' : '有其他内容',
    ]));
    return ['## V12 IMAGE()', table(['浏览器', '处理', '模式', 'CSP', '外链', '平台地址', 'data URL', '外部请求', 'CSP 强制违规', '快照'], rows)].join('\n\n');
}

function external(): string {
    const list = load('v12/external-images');
    const rows = list.flatMap((x) => (x.data.results as Json[]).map((r) => [browserOf(x.file), x.data.img, r.path, String((r.requests as string[]).length)]));
    return ['## V12 外链图片（关掉 CSP 时实际发出的外部请求）', table(['浏览器', '图片服务', '路径', '外部请求'], rows)].join('\n\n');
}

function degradation(): string {
    const list = load('v12/degradation');
    const rows = list.map((x) => {
        const d = x.data;
        const copy = d.copyToSystem.ok ? ((d.copyToSystem.items as Json[]).map((i) => i.type).join('、') || '剪贴板为空') : d.copyToSystem.error;
        const save = d.saveCellImage.download.ok ? `下载 ${d.saveCellImage.download.name}` : `失败（${(d.saveCellImage.csp as string[]).join('、') || '无 CSP 违规'}）`;
        const preview = (d.preview.images as Json[]).map((i) => `${i.complete && i.width > 0 ? '加载' : '未加载'}`).join('、') || '没有预览';
        return [browserOf(x.file), d.img, copy, save, preview, `${d.move.moved ? '已移动' : '未移动'}；页面错误 ${(d.move.errors as string[]).length}`, `dragover ${d.drop.dragoverPrevented ? '已阻止' : '未阻止'}、drop ${d.drop.dropPrevented ? '已阻止' : '未阻止'}；插入 ${d.drop.inserted}`];
    });
    return ['## V12 功能降级（严格 CSP）', table(['浏览器', '图片服务', '复制浮动图片到系统剪贴板', '保存单元格图片', '双击预览', '移动图片', '拖放文件（合成事件）'], rows)].join('\n\n');
}

function csp(): string {
    const list = load('v12/csp');
    const rows = list.flatMap((x) => (x.data.results as Json[]).map((r) => {
        const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} × ${v}`).join('；') || '—';
        return [browserOf(x.file), r.step, fmt(r.enforce), fmt(r.probe)];
    }));
    return ['## V12 CSP：平台配置下的违规（强制策略 / 探测策略）', table(['浏览器', '步骤', '强制策略', '探测策略（去掉 data:、blob:、unsafe-inline）'], rows)].join('\n\n');
}

const SECTIONS: Record<string, () => string> = { paths, assets, limits, validate, fallback, formula, external, degradation, csp };
const wanted = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SECTIONS);
console.log(wanted.map((k) => SECTIONS[k]()).join('\n\n'));

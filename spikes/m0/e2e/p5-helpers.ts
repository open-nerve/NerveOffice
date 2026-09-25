// P5 的测试辅助：输入法驱动、光标与选区、工具栏与菜单操作、正文结构摘要、保存重开比较。
import type { CDPSession, Page, TestInfo } from '@playwright/test';

import { SERVERS, waitForEditor } from './helpers';
import { contentDiff, snapshotText } from './p3-helpers';
import { cspViolations } from './p4-helpers';

/** 平台配置：平台图片服务（P4）+ 文字文档平台策略（P5）。 */
export const PLATFORM = 'img=platform&docpolicy=platform';

// ---------- 输入法 ----------

/**
 * 输入法驱动：
 * - cdp：Chromium 内核的 CDP（Input.imeSetComposition / Input.insertText），事件由浏览器的输入法通道产生；
 * - chrome、webkit：在隐藏输入元素上派发合成事件，分别按 Chrome 与 WebKit 的提交顺序（WebKit 顺序依据源码梳理，见 P5 报告）。
 */
export type ImeDriver = 'cdp' | 'chrome' | 'webkit';

export interface ImeInput {
    /** 组合过程中的文字（拼音逐字母、五笔编码等），依次更新。 */
    steps: string[];
    /** 提交的文字；空字符串表示取消。 */
    commit: string;
    /** 提交所用的键：WebKit 顺序下，回车提交会在 compositionend 之后再发一次 keyCode 229 的 keydown。 */
    commitKey?: 'space' | 'enter';
}

export function imeDriversFor(project: string): ImeDriver[] {
    return project === 'webkit' ? ['chrome', 'webkit'] : ['cdp', 'chrome', 'webkit'];
}

const cdpSessions = new WeakMap<Page, CDPSession>();
async function cdpOf(page: Page): Promise<CDPSession> {
    let s = cdpSessions.get(page);
    if (s == null) {
        s = await page.context().newCDPSession(page);
        cdpSessions.set(page, s);
    }
    return s;
}

/** 在当前光标处完成一次组合输入。stepDelayMs 模拟按键间隔（每次更新之后都让出宏任务，SDK 在异步流程里记下组合文字）。 */
export async function imeCompose(page: Page, driver: ImeDriver, input: ImeInput, stepDelayMs = 30): Promise<void> {
    if (driver === 'cdp') {
        const cdp = await cdpOf(page);
        for (const text of input.steps) {
            await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
            await page.waitForTimeout(stepDelayMs);
        }
        if (input.commit === '') await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
        else await cdp.send('Input.insertText', { text: input.commit });
        await page.waitForTimeout(stepDelayMs);
        return;
    }
    await page.evaluate(async ({ driver, input, stepDelayMs }) => {
        const el = document.activeElement as HTMLElement | null;
        if (el == null || !el.id.startsWith('__editor_')) throw new Error(`焦点不在编辑器的隐藏输入元素上：${el?.tagName ?? 'null'}#${el?.id ?? ''}`);
        const wait = () => new Promise((r) => setTimeout(r, stepDelayMs));
        // 浏览器派发原生事件时，每个监听器执行完都会清空微任务队列；脚本里 dispatchEvent 是同步的，不会。
        // SDK 在异步流程里记下组合文字（doc-ime-input.controller.ts:160-176），所以每次派发之后都让出一个宏任务，与原生行为一致。
        const tick = () => new Promise((r) => setTimeout(r, 0));
        const key = (k: string, composing: boolean) => {
            const e = new KeyboardEvent('keydown', { key: k, isComposing: composing, bubbles: true, cancelable: true });
            Object.defineProperty(e, 'keyCode', { get: () => 229 });
            el.dispatchEvent(e);
        };
        const fire = async (e: Event) => {
            el.dispatchEvent(e);
            await tick();
        };
        key('Process', false);
        await fire(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
        for (const [i, text] of input.steps.entries()) {
            if (i > 0) key('Process', true);
            await fire(new CompositionEvent('compositionupdate', { data: text, bubbles: true }));
            await fire(new InputEvent('input', { data: text, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
            await wait();
        }
        const commit = input.commit;
        if (commit === '') {
            await fire(new CompositionEvent('compositionupdate', { data: '', bubbles: true }));
            await fire(new InputEvent('input', { data: null, inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
            await fire(new CompositionEvent('compositionend', { data: '', bubbles: true }));
            await wait();
            return;
        }
        if (driver === 'chrome') {
            key('Process', true);
            await fire(new CompositionEvent('compositionupdate', { data: commit, bubbles: true }));
            await fire(new InputEvent('input', { data: commit, inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
            await fire(new CompositionEvent('compositionend', { data: commit, bubbles: true }));
        } else {
            key('Process', true);
            await fire(new InputEvent('input', { data: null, inputType: 'deleteCompositionText', isComposing: true, bubbles: true }));
            await fire(new InputEvent('input', { data: commit, inputType: 'insertFromComposition', isComposing: true, bubbles: true }));
            await fire(new CompositionEvent('compositionend', { data: commit, bubbles: true }));
            if (input.commitKey === 'enter') {
                const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false, bubbles: true, cancelable: true });
                Object.defineProperty(e, 'keyCode', { get: () => 229 });
                el.dispatchEvent(e);
            }
        }
        await wait();
    }, { driver, input, stepDelayMs });
}

// ---------- 光标、选区与键盘 ----------

export async function docText(page: Page): Promise<string> {
    return page.evaluate(() => window.__m0!.editor!.univerAPI.getActiveDocument()!.getBody().dataStream);
}

/** 让编辑器获得焦点（点击画布上正文区域的左上角附近），再设置选区。 */
export async function focusEditor(page: Page): Promise<void> {
    const canvas = page.locator('canvas#univer-doc-main-canvas');
    const box = await canvas.boundingBox();
    if (box == null) throw new Error('找不到文字文档画布');
    await page.mouse.click(box.x + box.width / 2, box.y + 60);
    await page.waitForTimeout(150);
}

/** 画布光标的页面坐标：隐藏输入元素的容器按光标左上角定位（docs-ui 的 doc-selection-render.service.ts:1282-1311）。 */
export async function caretPoint(page: Page): Promise<{ x: number; y: number }> {
    return page.evaluate(() => {
        const id = window.__m0!.editor!.unitId();
        const el = document.getElementById(`univer-doc-selection-container-${id}`) ?? document.getElementById(`__editor_${id}`)?.parentElement?.parentElement;
        if (el == null) throw new Error('找不到隐藏输入元素的容器');
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top };
    });
}

/**
 * 设置选区，并让隐藏输入元素获得焦点（对话框、弹出层关闭后焦点不会回到编辑器；用户此时会点回正文，这里直接聚焦）。
 */
export async function setSelection(page: Page, start: number, end = start): Promise<void> {
    await page.evaluate(({ start, end }) => {
        const editor = window.__m0!.editor!;
        editor.univerAPI.getActiveDocument()!.setSelection(start, end);
        const input = document.getElementById(`__editor_${editor.unitId()}`);
        if (input != null && document.activeElement !== input) input.focus();
    }, { start, end });
    await page.waitForTimeout(150);
}

/** 文字第一次出现的位置（找不到时抛错）。 */
export async function offsetOf(page: Page, text: string, from = 0): Promise<number> {
    const i = (await docText(page)).indexOf(text, from);
    if (i < 0) throw new Error(`正文中找不到：${text}`);
    return i;
}

/** 正文最后一个段落符之前（文末）。 */
export async function endOffset(page: Page): Promise<number> {
    return (await docText(page)).length - 2;
}

export async function selectText(page: Page, text: string): Promise<void> {
    const i = await offsetOf(page, text);
    await setSelection(page, i, i + text.length);
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
export const shortcut = (keys: string) => keys.replace(/Mod/g, MOD);

export async function press(page: Page, keys: string): Promise<void> {
    await page.keyboard.press(shortcut(keys));
    await page.waitForTimeout(200);
}

export async function undo(page: Page): Promise<void> {
    await press(page, 'Mod+z');
    await page.waitForTimeout(200);
}

export async function redo(page: Page): Promise<void> {
    await press(page, 'Mod+Shift+z');
    await page.waitForTimeout(200);
}

// ---------- 工具栏与菜单 ----------

/** 点击工具栏按钮（按 data-u-command）。 */
export async function clickToolbar(page: Page, commandId: string): Promise<void> {
    await page.locator(`[data-u-command="${commandId}"]`).first().click();
    await page.waitForTimeout(250);
}

/** 当前可见的弹出菜单里，按文字点选一项。 */
export async function clickMenuText(page: Page, text: string): Promise<void> {
    await page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], .univer-popup').getByText(text, { exact: true }).first().click();
    await page.waitForTimeout(250);
}

// ---------- 结构摘要 ----------

export interface DocSummary {
    text: string;
    paragraphs: { text: string; style: number | null; align: number | null; list: string | null; level: number | null; inTable: boolean }[];
    tables: { rows: number; cols: number }[];
    links: { text: string; url: string }[];
    runs: { text: string; ts: Record<string, unknown> }[];
    images: { id: string; layoutType: number | null; behindDoc: number | null; wrapText: string | null; source: string; size: [number, number] | null; pos: [number, number] | null }[];
}

/** 正文的结构摘要：段落（命名样式、对齐、列表）、表格、链接、带样式的文字、图片。 */
export async function docSummary(page: Page): Promise<DocSummary> {
    return page.evaluate(() => {
        const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
        const snap = doc.save() as unknown as {
            body: { dataStream: string; paragraphs?: { startIndex: number; paragraphStyle?: { namedStyleType?: number; horizontalAlign?: number }; bullet?: { listType: string; nestingLevel: number } }[]; tables?: { startIndex: number; endIndex: number; tableId: string }[]; customRanges?: { rangeType: number; startIndex: number; endIndex: number; properties?: { url?: string } }[]; textRuns?: { st: number; ed: number; ts?: Record<string, unknown> }[]; customBlocks?: { blockId: string }[] };
            tableSource?: Record<string, { tableRows: { tableCells: unknown[] }[] }>;
            drawings?: Record<string, { layoutType?: number; behindDoc?: number; wrapText?: string; source?: string; docTransform?: { size?: { width?: number; height?: number }; positionH?: { posOffset?: number }; positionV?: { posOffset?: number } } }>;
        };
        const b = snap.body;
        const ds = b.dataStream;
        const inTable = (i: number) => (b.tables ?? []).some((t) => i > t.startIndex && i < t.endIndex);
        const clean = (s: string) => s.replace(/[\r\n\x0e\x0f\x1a-\x1f\b]/g, '');
        let prev = 0;
        const paragraphs = (b.paragraphs ?? []).map((p) => {
            const text = clean(ds.slice(prev, p.startIndex));
            prev = p.startIndex + 1;
            return { text, style: p.paragraphStyle?.namedStyleType ?? null, align: p.paragraphStyle?.horizontalAlign ?? null, list: p.bullet?.listType ?? null, level: p.bullet?.nestingLevel ?? null, inTable: inTable(p.startIndex) };
        });
        return {
            text: ds,
            paragraphs,
            tables: (b.tables ?? []).map((t) => {
                const rows = snap.tableSource?.[t.tableId]?.tableRows ?? [];
                return { rows: rows.length, cols: rows[0]?.tableCells.length ?? 0 };
            }),
            links: (b.customRanges ?? []).filter((r) => r.rangeType === 0).map((r) => ({ text: ds.slice(r.startIndex, r.endIndex + 1), url: r.properties?.url ?? '' })),
            runs: (b.textRuns ?? []).filter((r) => r.ts != null && Object.keys(r.ts).length > 0).map((r) => ({ text: ds.slice(r.st, r.ed), ts: r.ts! })),
            images: Object.entries(snap.drawings ?? {}).map(([id, d]) => ({
                id,
                layoutType: d.layoutType ?? null,
                behindDoc: d.behindDoc ?? null,
                wrapText: d.wrapText ?? null,
                source: String(d.source ?? ''),
                size: d.docTransform?.size != null ? [Math.round(d.docTransform.size.width ?? 0), Math.round(d.docTransform.size.height ?? 0)] as [number, number] : null,
                pos: d.docTransform != null ? [Math.round(d.docTransform.positionH?.posOffset ?? 0), Math.round(d.docTransform.positionV?.posOffset ?? 0)] as [number, number] : null,
            })),
        };
    });
}

// ---------- 页面状态、保存重开 ----------

export interface PageHealth {
    errors: string[];
    cspEnforce: string[];
}

export async function resetHealth(page: Page): Promise<void> {
    await page.evaluate(() => {
        const ev = window.__m0!.events;
        ev.errors.length = 0;
        ev.consoleErrors.length = 0;
        ev.cspViolations.length = 0;
    });
}

export async function pageHealth(page: Page): Promise<PageHealth> {
    const errors = await page.evaluate(() => [...window.__m0!.events.errors, ...window.__m0!.events.consoleErrors].map((x) => x.slice(0, 200)));
    const csp = await cspViolations(page);
    return { errors, cspEnforce: csp.filter((v) => v.disposition === 'enforce').map((v) => `${v.directive} ${v.blocked}`) };
}

/**
 * 额外的页面参数（环境变量 M0_P5_QUERY）：用同一套用例回归档案的变体，例如 worker=1（排版 Worker）、without=formula（去掉公式引擎）。
 */
export const EXTRA_QUERY = process.env.M0_P5_QUERY ?? '';
/** 结果目录的后缀：变体的结果单独存放，例如 v13/capabilities-worker/。 */
export const VARIANT = EXTRA_QUERY === '' ? '' : `-${EXTRA_QUERY.replace(/=1\b/g, '').replace(/[^\w]+/g, '-')}`;

export async function openDoc(page: Page, query: string, base: string = SERVERS.full): Promise<void> {
    await page.goto(`${base}/doc.html?${query}${EXTRA_QUERY === '' ? '' : `&${EXTRA_QUERY}`}`);
    await waitForEditor(page);
}

/**
 * 保存 → 重开 → 再保存（P2 的口径）：s1 是当前快照，s2 是重开后的快照，s3 是再次重开后的快照。
 * 断言用 s2 与 s3 的差异（第一次保存可能补齐默认值）；s1 与 s2 的差异一并记录。
 */
export async function roundtrip(page: Page, id: string, query: string, base: string = SERVERS.full): Promise<{ firstDiff: string[]; secondDiff: string[] }> {
    const s1 = await snapshotText(page);
    await page.evaluate((id) => window.__m0!.persist!(id), id);
    await openDoc(page, `doc=${id}&${query}`, base);
    const s2 = await snapshotText(page);
    await page.evaluate((id) => window.__m0!.persist!(id), id);
    await openDoc(page, `doc=${id}&${query}`, base);
    const s3 = await snapshotText(page);
    const fmt = (d: ReturnType<typeof contentDiff>) => d.map((x) => JSON.stringify(x).slice(0, 200));
    return { firstDiff: fmt(contentDiff(s1, s2)), secondDiff: fmt(contentDiff(s2, s3)) };
}

/** 文档 id：浏览器 + 用例名，避免三个浏览器互相覆盖。 */
export function docId(testInfo: TestInfo, name: string): string {
    return `p5-${testInfo.project.name}-${name}`.replace(/[^\w.-]/g, '_');
}

export async function policyEvents(page: Page): Promise<{ kind: string; detail: string }[]> {
    return page.evaluate(() => (window.__m0!.docPolicy?.events ?? []).map((e) => ({ kind: e.kind, detail: e.detail })));
}

/** 切换功能区标签（开始、插入）。 */
export async function ribbonTab(page: Page, name: '开始' | '插入'): Promise<void> {
    await page.getByRole('tab', { name }).click();
    await page.waitForTimeout(250);
}

/**
 * 在文字文档主画布上按颜色找出一块区域的外接矩形（页面坐标）：用来定位图片（样本图片是纯色的）。
 * 画布是 2D 画布，图片同源，不会被污染；设备像素比按画布的实际像素换算。
 */
export async function findColorBox(page: Page, rgb: [number, number, number], tolerance = 24): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return page.evaluate(({ rgb, tolerance }) => {
        const canvas = document.querySelector('canvas#univer-doc-main-canvas') as HTMLCanvasElement | null;
        if (canvas == null) return null;
        const ctx = canvas.getContext('2d');
        if (ctx == null) return null;
        const { width, height } = canvas;
        const data = ctx.getImageData(0, 0, width, height).data;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y += 2) {
            for (let x = 0; x < width; x += 2) {
                const i = (y * width + x) * 4;
                if (Math.abs(data[i] - rgb[0]) <= tolerance && Math.abs(data[i + 1] - rgb[1]) <= tolerance && Math.abs(data[i + 2] - rgb[2]) <= tolerance) {
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        const rect = canvas.getBoundingClientRect();
        const sx = rect.width / width;
        const sy = rect.height / height;
        return { x: rect.left + minX * sx, y: rect.top + minY * sy, width: (maxX - minX) * sx, height: (maxY - minY) * sy };
    }, { rgb, tolerance });
}

/** 把 window.open 换成记录器（链接的打开走 window.open，见 docs-hyper-link-ui 的 popup.operation.ts）。 */
export async function stubWindowOpen(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as { __opened: unknown[][] };
        w.__opened = [];
        window.open = ((...args: unknown[]) => {
            w.__opened.push(args);
            return null;
        }) as typeof window.open;
    });
}

export async function openedWindows(page: Page): Promise<unknown[][]> {
    return page.evaluate(() => (window as unknown as { __opened?: unknown[][] }).__opened ?? []);
}

/**
 * 图片被点选后弹出的浮动工具条（画布弹出层 section[data-u-comp="rect-popup"]，按钮没有文字与标签），
 * 按从左到右返回按钮中心坐标：环绕方式、编辑、裁剪、删除。image 只用来在多个弹出层里挑离图片最近的一个。
 */
export async function imageToolbarButtons(page: Page, image: { x: number; y: number; width: number; height?: number }): Promise<{ x: number; y: number }[]> {
    return page.evaluate((img) => {
        const pops = [...document.querySelectorAll('section[data-u-comp="rect-popup"]')]
            .map((sec) => ({ sec, rect: sec.getBoundingClientRect(), buttons: [...sec.querySelectorAll('button')] }))
            .filter((p) => p.rect.width > 0 && p.rect.top > -1000 && p.buttons.length >= 3 && p.buttons.every((b) => (b.getAttribute('aria-label') ?? '') === '' && b.innerText.trim() === ''));
        const cy = img.y + (img.height ?? 0) / 2;
        pops.sort((a, b) => Math.abs(a.rect.top - cy) - Math.abs(b.rect.top - cy));
        const pop = pops[0];
        if (pop == null) return [];
        return pop.buttons.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0).sort((a, b) => a.left - b.left).map((r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
    }, image);
}

/** ⌘K 打开链接框后，地址输入框已获得焦点：直接键入，再点确认。 */
export async function fillLinkPopup(page: Page, url: string): Promise<void> {
    await page.waitForTimeout(300);
    await page.keyboard.type(url, { delay: 10 });
    await page.getByRole('button', { name: '确认' }).last().click();
    await page.waitForTimeout(400);
}

/** 不经过组合的直接上屏（中文标点、表情等）：CDP 的 Input.insertText；合成驱动写入隐藏输入元素后派发 beforeinput 与 input。 */
export async function plainInsert(page: Page, driver: ImeDriver, text: string): Promise<void> {
    if (driver === 'cdp') {
        await (await cdpOf(page)).send('Input.insertText', { text });
        await page.waitForTimeout(80);
        return;
    }
    await page.evaluate((text) => {
        const el = document.activeElement as HTMLElement;
        el.dispatchEvent(new InputEvent('beforeinput', { data: text, inputType: 'insertText', bubbles: true, cancelable: true }));
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true }));
    }, text);
    await page.waitForTimeout(80);
}

export async function activeRange(page: Page): Promise<{ startOffset: number; endOffset: number } | null> {
    return page.evaluate(() => window.__m0!.activeTextRange?.() ?? null);
}

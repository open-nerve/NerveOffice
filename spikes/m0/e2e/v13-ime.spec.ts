// V13 中文输入（P5）：无头浏览器无法驱动系统输入法，用两类驱动：
// - cdp：Chromium 内核的 CDP 输入法接口，事件由浏览器的输入法通道产生；
// - chrome、webkit：合成事件，分别按 Chrome 与 WebKit 的提交顺序（WebKit 顺序依据源码梳理，真实 Safari 由人工核对，见 scripts/ime-real.ts）。
// 每个驱动 × 两种配置（SDK 默认、平台策略）× 输入序列与位置，检查最终正文、撤销重做、段落数、光标位置、样式继承与页面错误；
// 另测候选框锚点、组合进行中的捕获，以及输入法记录页本身。
import type { Page, TestInfo } from '@playwright/test';
import type { ImeDriver, ImeInput } from './p5-helpers';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, writeResult } from './helpers';
import {
    activeRange, caretPoint, docSummary, docText, endOffset, focusEditor, imeCompose, imeDriversFor, offsetOf, openDoc, pageHealth, plainInsert, PLATFORM,
    redo, resetHealth, setSelection, undo, VARIANT,
} from './p5-helpers';

type Config = 'default' | 'platform';

const INPUTS = {
    pinyin: { steps: ['n', 'ni', 'ni h', 'ni ha', 'ni hao'], commit: '你好', commitKey: 'space' },
    sentence: { steps: ['z', 'zh', 'zho', 'zhon', 'zhong', 'zhong w', 'zhong we', 'zhong wen', 'zhong wen s', 'zhong wen sh', 'zhong wen shu', 'zhong wen shu r', 'zhong wen shu ru'], commit: '中文输入', commitKey: 'space' },
    wubi: { steps: ['w', 'wq', 'wqv', 'wqvb'], commit: '你好', commitKey: 'space' },
    cancel: { steps: ['c', 'ce', 'ces', 'ce sh', 'ce shi'], commit: '', commitKey: 'space' },
    enterRaw: { steps: ['h', 'he', 'hel', 'hell', 'hello'], commit: 'hello', commitKey: 'enter' },
} satisfies Record<string, ImeInput>;

interface Position {
    id: string;
    name: string;
    /** 准备：设置样式、列表、表格、链接等（用命令，不属于被测路径）。 */
    setup?: (page: Page) => Promise<void>;
    /** 放置光标或选区，返回插入位置与被替换的长度。 */
    place: (page: Page) => Promise<{ at: number; replace: number }>;
    /** 额外检查（样式继承等）。 */
    check?: (page: Page, commit: string) => Promise<{ ok: boolean; detail: unknown }>;
}

const exec = (page: Page, id: string, params: Record<string, unknown>) =>
    page.evaluate(({ id, params }) => window.__m0!.editor!.univerAPI.executeCommand(id, params), { id, params });

async function caretAt(page: Page, at: number): Promise<{ at: number; replace: number }> {
    await setSelection(page, at);
    return { at, replace: 0 };
}

const POSITIONS: Position[] = [
    { id: 'end', name: '段落末尾', place: async (page) => caretAt(page, (await offsetOf(page, '的文字。')) + 4) },
    { id: 'start', name: '段落开头', place: async (page) => caretAt(page, await offsetOf(page, '段落丙')) },
    { id: 'middle', name: '段落中间', place: async (page) => caretAt(page, (await offsetOf(page, '段落丁：')) + 4) },
    {
        id: 'heading', name: '标题里',
        setup: async (page) => {
            await setSelection(page, (await offsetOf(page, '段落甲')) + 2);
            await exec(page, 'doc.command.set-paragraph-named-style', { value: 4 });
        },
        place: async (page) => caretAt(page, (await offsetOf(page, '标题样式。')) + 5),
        check: async (page, commit) => {
            const p = (await docSummary(page)).paragraphs.find((x) => x.text.includes('段落甲'));
            return { ok: commit === '' || (p?.style === 4 && p.text.endsWith(commit)), detail: p };
        },
    },
    {
        id: 'list', name: '列表项里',
        setup: async (page) => {
            await setSelection(page, (await offsetOf(page, '段落戊')) + 2);
            await exec(page, 'doc.command.bullet-list', {});
        },
        place: async (page) => caretAt(page, (await offsetOf(page, '列表第二项')) + 5),
        check: async (page, commit) => {
            const p = (await docSummary(page)).paragraphs.find((x) => x.text.includes('段落戊'));
            return { ok: commit === '' || (p?.list === 'BULLET_LIST' && p.text.endsWith(commit)), detail: p };
        },
    },
    {
        id: 'cell', name: '表格单元格里',
        setup: async (page) => {
            await setSelection(page, await endOffset(page));
            await exec(page, 'doc.command.create-table', { rowCount: 2, colCount: 2 });
            await page.waitForTimeout(400);
        },
        place: async (page) => caretAt(page, (await docText(page)).indexOf('\x1c') + 1),
        check: async (page, commit) => {
            const cells = (await docSummary(page)).paragraphs.filter((x) => x.inTable).map((x) => x.text);
            return { ok: cells[0] === commit, detail: cells };
        },
    },
    {
        id: 'bold', name: '粗体文字中间',
        setup: async (page) => {
            const i = await offsetOf(page, '可以选中');
            await setSelection(page, i, i + 4);
            await exec(page, 'doc.command.set-inline-format-bold', {});
        },
        place: async (page) => caretAt(page, (await offsetOf(page, '可以选中')) + 2),
        check: async (page, commit) => {
            if (commit === '') return { ok: true, detail: null };
            const s = await docSummary(page);
            const run = s.runs.find((r) => r.text.includes(commit));
            return { ok: run?.ts.bl === 1 && s.text.includes(`可以${commit}选中`), detail: run };
        },
    },
    {
        id: 'link', name: '链接文字中间',
        setup: async (page) => {
            const i = await offsetOf(page, '链接文字');
            await setSelection(page, i, i + 4);
            await exec(page, 'docs.command.add-hyper-link', { unitId: await page.evaluate(() => window.__m0!.editor!.unitId()), payload: 'https://example.com/ime' });
        },
        place: async (page) => caretAt(page, (await offsetOf(page, '链接文字')) + 2),
        check: async (page, commit) => {
            if (commit === '') return { ok: true, detail: null };
            const links = (await docSummary(page)).links;
            return { ok: links.some((l) => l.text === `链接${commit}文字` && l.url === 'https://example.com/ime'), detail: links };
        },
    },
    {
        id: 'replace', name: '替换选中的文字',
        place: async (page) => {
            const i = await offsetOf(page, '用于对齐');
            await setSelection(page, i, i + 4);
            return { at: i, replace: 4 };
        },
    },
];

interface CaseResult {
    id: string;
    input: string;
    position: string;
    before: string;
    expected: string;
    after: string;
    ok: { text: boolean; paragraphs: boolean; caret: boolean; undo: boolean; redo: boolean; extra: boolean };
    caret: { expected: number; actual: number | null };
    undone: string;
    redone: string;
    extra?: unknown;
}

const strip = (s: string) => s.replace(/\r\n$/, '');

async function runCase(page: Page, driver: ImeDriver, config: Config, input: ImeInput, inputId: string, pos: Position): Promise<CaseResult> {
    await openDoc(page, `sample=p5-cap${config === 'platform' ? `&${PLATFORM}` : ''}`);
    await focusEditor(page);
    if (pos.setup != null) await pos.setup(page);
    const { at, replace } = await pos.place(page);
    await page.waitForTimeout(200);
    const before = await docText(page);
    const paragraphs = (await docSummary(page)).paragraphs.length;
    const expected = input.commit === '' ? before : before.slice(0, at) + input.commit + before.slice(at + replace);
    await imeCompose(page, driver, input);
    await page.waitForTimeout(400);
    const after = await docText(page);
    const caret = await activeRange(page);
    const afterParagraphs = (await docSummary(page)).paragraphs.length;
    const extra = pos.check != null ? await pos.check(page, input.commit) : { ok: true, detail: undefined };
    let undone = after;
    let redone = after;
    if (input.commit !== '') {
        await undo(page);
        undone = await docText(page);
        await redo(page);
        redone = await docText(page);
    }
    const caretExpected = input.commit === '' ? at : at + input.commit.length;
    // 记录插入点附近的一段（缺陷出现在插入点，不在文末）
    const around = (text: string) => text.slice(Math.max(0, at - 8), at + 16).replace(/\r/g, '⏎');
    return {
        id: `${inputId}@${pos.id}`,
        input: inputId,
        position: pos.id,
        before: around(before),
        expected: around(expected),
        after: around(after),
        ok: {
            text: after === expected,
            paragraphs: afterParagraphs === paragraphs,
            caret: input.commit === '' || (caret?.startOffset === caretExpected && caret.endOffset === caretExpected),
            undo: input.commit === '' || undone === before,
            redo: input.commit === '' || redone === after,
            extra: extra.ok,
        },
        caret: { expected: caretExpected, actual: caret?.startOffset ?? null },
        undone: around(undone),
        redone: around(redone),
        extra: extra.detail,
    };
}

async function writeCases(page: Page, testInfo: TestInfo, name: string, data: Record<string, unknown>): Promise<void> {
    await writeResult(`v13/ime${VARIANT}/${testInfo.project.name}-${name}.json`, { check: 'V13-ime', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...data });
}

for (const driver of ['cdp', 'chrome', 'webkit'] as const) {
    for (const config of ['default', 'platform'] as const) {
        test(`V13 输入法：${driver} 驱动，${config}`, async ({ page }, testInfo) => {
            test.skip(!imeDriversFor(testInfo.project.name).includes(driver), 'CDP 只在 Chromium 内核上可用');
            test.setTimeout(600_000);
            const cases: CaseResult[] = [];
            await resetHealth(page).catch(() => undefined);
            // 输入序列（段落末尾）
            for (const [id, input] of Object.entries(INPUTS)) cases.push(await runCase(page, driver, config, input, id, POSITIONS[0]));
            // 位置（拼音）
            for (const pos of POSITIONS.slice(1)) cases.push(await runCase(page, driver, config, INPUTS.pinyin, 'pinyin', pos));
            // 中文标点（不经过组合）与连续两次组合
            await openDoc(page, `sample=p5-cap${config === 'platform' ? `&${PLATFORM}` : ''}`);
            await focusEditor(page);
            const at = (await offsetOf(page, '的文字。')) + 4;
            await setSelection(page, at);
            const before = await docText(page);
            await plainInsert(page, driver, '，');
            await imeCompose(page, driver, INPUTS.pinyin);
            await imeCompose(page, driver, { steps: ['s', 'sh', 'shi', 'shi j', 'shi jie'], commit: '世界' });
            await plainInsert(page, driver, '。');
            await page.waitForTimeout(400);
            const after = await docText(page);
            const undos: string[] = [];
            for (let k = 0; k < 4; k++) {
                await undo(page);
                undos.push(strip(await docText(page)).slice(-40));
            }
            const health = await pageHealth(page);
            const mixed = { after: strip(after).slice(-40), expected: strip(before.slice(0, at) + '，你好世界。' + before.slice(at)).slice(-40), undos, restored: (await docText(page)) === before };
            await writeCases(page, testInfo, `${driver}-${config}`, { driver, config, cases, mixed, health });
            // 断言：平台配置下全部正确；SDK 默认只对 Chrome 顺序断言（WebKit 顺序的撤销缺陷作为发现记录）
            const strict = config === 'platform' || driver !== 'webkit';
            for (const c of cases) {
                expect.soft(c.ok.text, `${c.id} 正文：${c.after} ≠ ${c.expected}`).toBe(true);
                expect.soft(c.ok.paragraphs, `${c.id} 段落数不变`).toBe(true);
                expect.soft(c.ok.caret, `${c.id} 光标：${JSON.stringify(c.caret)}`).toBe(true);
                expect.soft(c.ok.extra, `${c.id} ${JSON.stringify(c.extra)?.slice(0, 200)}`).toBe(true);
                if (strict) {
                    expect.soft(c.ok.undo, `${c.id} 撤销：${c.undone}`).toBe(true);
                    expect.soft(c.ok.redo, `${c.id} 重做：${c.redone}`).toBe(true);
                }
            }
            expect.soft(mixed.after, '标点与连续组合').toBe(mixed.expected);
            expect.soft(health.errors, '没有页面错误').toEqual([]);
            expect.soft(health.cspEnforce, '没有 CSP 强制违规').toEqual([]);
        });
    }
}

test('V13 候选框锚点：隐藏输入元素里的组合文字与画布光标', async ({ page }, testInfo) => {
    // 系统输入法的候选框贴着隐藏输入元素里的 DOM 光标（组合文字的末尾）；画布上的组合文字由 SDK 绘制。比较两者的位置
    const out: Record<string, unknown>[] = [];
    // nowrap：缓解思路——隐藏输入元素不换行（white-space: pre），组合文字变长时 DOM 光标不再往下移
    for (const [zoom, nowrap] of [[1, false], [1.5, false], [1, true]] as const) {
        await openDoc(page, 'sample=p5-cap');
        if (nowrap) {
            await page.addStyleTag({ content: 'div[id^="__editor_"] { white-space: pre !important; }' });
        }
        await focusEditor(page);
        if (zoom !== 1) {
            await page.evaluate((z) => {
                const api = window.__m0!.editor!.univerAPI;
                return api.executeCommand('doc.command.set-zoom-ratio', { zoomRatio: z, documentId: api.getActiveDocument()!.getId() });
            }, zoom);
            await page.waitForTimeout(500);
        }
        const at = (await offsetOf(page, '的文字。')) + 4;
        await setSelection(page, at);
        const start = await caretPoint(page);
        const samples: Record<string, unknown>[] = [];
        for (const text of ['ni', 'ni hao', 'ni hao shi jie']) {
            await page.evaluate((text) => {
                const el = document.activeElement as HTMLElement;
                if (!el.id.startsWith('__editor_')) throw new Error('焦点不在隐藏输入元素上');
                if (el.dataset.p5Composing !== '1') {
                    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
                    el.dataset.p5Composing = '1';
                }
                el.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }));
                // 模拟浏览器的默认行为：组合文字写进隐藏输入元素
                el.textContent = text;
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                const sel = window.getSelection()!;
                sel.removeAllRanges();
                sel.addRange(range);
            }, text);
            await page.waitForTimeout(300);
            const dom = await page.evaluate(() => {
                const el = document.activeElement as HTMLElement;
                const range = document.createRange();
                range.selectNodeContents(el);
                const rects = range.getClientRects();
                const last = rects[rects.length - 1];
                const style = getComputedStyle(el);
                return { right: last ? last.right : null, top: last ? last.top : null, fontSize: style.fontSize, fontFamily: style.fontFamily.slice(0, 40) };
            });
            const canvas = await caretPoint(page);
            samples.push({ text, canvasCaret: canvas, domCompositionRight: dom.right, domTop: dom.top, dx: dom.right == null ? null : Math.round(dom.right - canvas.x), dy: dom.top == null ? null : Math.round(dom.top - canvas.y), font: `${dom.fontSize} ${dom.fontFamily}` });
        }
        await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            el.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
            delete el.dataset.p5Composing;
        });
        const zoomRatio = await page.evaluate(() => (window.__m0!.editor!.save() as { settings?: { zoomRatio?: number } }).settings?.zoomRatio ?? 1);
        out.push({ zoom, zoomRatio, nowrap, start, samples: samples.map((x) => ({ ...x, compositionOffsetOnCanvas: Math.round((x.canvasCaret as { x: number }).x - start.x) })) });
    }
    await writeCases(page, testInfo, 'candidate-anchor', { results: out });
});

for (const config of ['default', 'platform'] as const) {
    test(`V13 组合进行中的捕获：${config}`, async ({ page }, testInfo) => {
        // platform：捕获时机按组合输入感知（respectComposition，默认）；default：P3 的原规则（不看组合）
        await openDoc(page, `sample=p5-cap${config === 'platform' ? `&${PLATFORM}` : ''}`);
        await focusEditor(page);
        const at = (await offsetOf(page, '的文字。')) + 4;
        await setSelection(page, at);
        const respect = config === 'platform';
        const driver: ImeDriver = testInfo.project.name === 'webkit' ? 'webkit' : 'cdp';
        // 开始组合，停在候选上 1.5 秒（超过 1 秒的去抖）
        const partial = { steps: ['n', 'ni', 'ni h'], commit: '' };
        if (driver === 'cdp') {
            const cdp = await page.context().newCDPSession(page);
            for (const t of partial.steps) {
                await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
                await page.waitForTimeout(30);
            }
        } else {
            await page.evaluate(async (steps) => {
                const el = document.activeElement as HTMLElement;
                el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
                for (const t of steps) {
                    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: t, bubbles: true }));
                    await new Promise((r) => setTimeout(r, 30));
                }
            }, partial.steps);
        }
        const mid = await page.evaluate(async (respect) => {
            const m0 = window.__m0!;
            const wait = await m0.waitForCapture!({ debounceMs: 1000, timeoutMs: 2500, respectComposition: respect });
            const text = JSON.stringify(m0.editor!.save());
            return { wait, hasPinyin: text.includes('ni h'), composition: m0.editor!.detector.composition() };
        }, respect);
        // 组合进行中执行一次 save()（捕获），再继续组合并提交：输入不应被打断
        await page.evaluate(() => window.__m0!.editor!.save());
        if (driver === 'cdp') {
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Input.imeSetComposition', { text: 'ni hao', selectionStart: 6, selectionEnd: 6 });
            await page.waitForTimeout(30);
            await cdp.send('Input.insertText', { text: '你好' });
        } else {
            await page.evaluate(async () => {
                const el = document.activeElement as HTMLElement;
                el.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni hao', bubbles: true }));
                await new Promise((r) => setTimeout(r, 30));
                el.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你好', bubbles: true }));
                await new Promise((r) => setTimeout(r, 30));
                el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }));
            });
        }
        const t0 = Date.now();
        const end = await page.evaluate(async (respect) => {
            const m0 = window.__m0!;
            const wait = await m0.waitForCapture!({ debounceMs: 1000, timeoutMs: 5000, respectComposition: respect });
            const text = JSON.stringify(m0.editor!.save());
            return { wait, hasFinal: text.includes('的文字。你好'), hasPinyin: /ni h/.test(text) };
        }, respect);
        const elapsed = Date.now() - t0;
        const text = await docText(page);
        await writeCases(page, testInfo, `capture-${config}`, { config, driver, mid, end, elapsedMs: elapsed, finalText: strip(text).slice(-40) });
        expect.soft(text.includes('的文字。你好'), '组合中的 save() 不打断输入').toBe(true);
        expect.soft(end.hasFinal && !end.hasPinyin, '提交后的捕获是最终文字').toBe(true);
        if (config === 'platform') {
            expect.soft(mid.wait.composing, '组合进行中：等到超时也不捕获').toBe(true);
        } else {
            expect.soft(mid.hasPinyin, 'P3 原规则：组合进行中捕获到拼音（对照）').toBe(true);
        }
    });
}

test('V13 输入法记录页', async ({ page, request }, testInfo) => {
    // 人工核对用的记录页（scripts/ime-real.ts）本身可用：记录组合事件、检查点，并交回验证服务
    await request.delete(`${SERVERS.full}/__imelog`);
    await openDoc(page, 'sample=minimal&imelog=1');
    await focusEditor(page);
    await setSelection(page, await endOffset(page));
    await imeCompose(page, testInfo.project.name === 'webkit' ? 'webkit' : 'chrome', INPUTS.pinyin);
    await page.waitForTimeout(600);
    await page.locator('[data-testid="imelog-upload"]').click();
    await page.waitForTimeout(500);
    const logs = (await (await request.get(`${SERVERS.full}/__imelog`)).json()) as { events: { type: string; data?: string }[]; checkpoints: { reason: string; text: string }[] }[];
    const log = logs[0];
    await writeCases(page, testInfo, 'recorder', { sessions: logs.length, events: log?.events.length, compositionEnd: log?.events.find((e) => e.type === 'compositionend'), checkpoints: log?.checkpoints });
    expect(logs.length).toBe(1);
    expect(log.events.some((e) => e.type === 'compositionend' && e.data === '你好')).toBe(true);
    expect(log.checkpoints.some((c) => c.reason === 'compositionend' && c.text.includes('你好'))).toBe(true);
});

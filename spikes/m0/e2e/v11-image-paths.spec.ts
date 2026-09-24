// V11-1 图片路径矩阵（P4，00 号计划书 §8.5、§11.3）：图片进入文档的每条路径，在 img=default（SDK 默认）与 img=platform
// （平台图片服务 + 粘贴钩子 + 命令守卫）两种配置下，快照里新增的图片地址是什么、有没有上传、能不能加载、有没有 CSP 违规。
// 严格 CSP（SERVERS.full），三个浏览器；表格带 worker=1（平台默认启用公式 Worker）。
// 方式：F 为命令或 Facade（打开文件选择框的命令与工具栏按钮是同一个命令），P 为合成粘贴（与快捷键粘贴走同一条 onPaste$），U 为真实的键盘鼠标操作。
import type { Page } from '@playwright/test';
import type { PasteFile } from './p4-helpers';

import { expect, test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { brief, detectorMark, detectorState, waitQuiet } from './p3-helpers';
import { addedImages, assetsState, cspViolations, dataUrl, fixtureFile, imageLoadState, insertViaFileChooser, resetAssetLogs, snapshotImages, syntheticPaste } from './p4-helpers';

test.use({ baseURL: SERVERS.full });

const EXTERNAL = 'https://example.invalid/tracking.png';
const png = (): PasteFile => fixtureFile('blue-120x80.png');

/** 文字文档的"内部片段"：HTML 注释里放 base64 的 JSON（docs-ui 的 internal-fragment.ts:237-253）。 */
const fragment = (doc: unknown) => `<!--univer-doc-fragment:${Buffer.from(JSON.stringify({ version: 1, kind: 'univer-doc-fragment', doc })).toString('base64')}-->`;
const TEXT_FILL_DOC = { body: { dataStream: 'TF\r', textRuns: [{ st: 0, ed: 2, ts: { fs: 28, textFill: { type: 'picture', picture: { source: `${EXTERNAL}?textfill` } } } }], paragraphs: [{ startIndex: 2, paragraphId: 'p4tf' }] } };
function drawingDoc(source: unknown, imageSourceType: string | undefined) {
    return {
        body: { dataStream: '\bX\r', customBlocks: [{ startIndex: 0, blockId: 'p4img' }], paragraphs: [{ startIndex: 2, paragraphId: 'p4p' }] },
        drawings: {
            p4img: {
                drawingId: 'p4img', unitId: '', subUnitId: '', drawingType: 0, ...(imageSourceType == null ? {} : { imageSourceType }), source, title: '', description: '', layoutType: 0,
                transform: { width: 40, height: 30, angle: 0 },
                docTransform: { angle: 0, size: { width: 40, height: 30 }, positionH: { relativeFrom: 2, posOffset: 0 }, positionV: { relativeFrom: 2, posOffset: 0 } },
            },
        },
    };
}

interface PathCase {
    id: string;
    kind: 'sheet' | 'doc';
    method: 'F' | 'P' | 'U';
    /** 路径说明（写进结果文件）。 */
    what: string;
    /** 平台配置下预期新增的图片数（文字文档只数正文的 drawings，不数资源里的副本）；0 表示预期被丢弃、拦截或去掉。 */
    expect: number;
    run: (page: Page) => Promise<void>;
}

async function clickCell(page: Page, a1: string): Promise<void> {
    const p = await cellCenter(page, a1);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
}

async function clickDocEnd(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
        const end = doc.getBody().dataStream.length - 2;
        doc.setSelection(end, end);
    });
    await page.waitForTimeout(300);
}

type FacadeAction = 'insertImageUrl' | 'cellImageUrl' | 'backgroundUrl' | 'insertImageData' | 'shape' | 'docInsertUrl' | 'docInsertData';

/** Facade 与命令调用。严格 CSP 下页面里不能用 new Function，所以每个动作写成静态代码。 */
async function facade(page: Page, action: FacadeAction, url: string): Promise<void> {
    await page.evaluate(async ({ action, url }) => {
        const api = window.__m0!.editor!.univerAPI;
        // 文字文档页面没有加载表格的 Facade 扩展
        const ws = window.__m0!.kind === 'sheet' ? api.getActiveWorkbook()?.getActiveSheet() : undefined;
        const doc = window.__m0!.kind === 'doc' ? api.getActiveDocument() : undefined;
        const end = () => doc!.getBody().dataStream.length - 2;
        try {
            if (action === 'insertImageUrl' || action === 'insertImageData') await ws!.insertImage(url, 2, 2);
            else if (action === 'cellImageUrl') await ws!.getRange('E5').insertCellImageAsync(url);
            else if (action === 'backgroundUrl') await (ws as unknown as { setBackgroundImage(src: string): Promise<unknown> }).setBackgroundImage(url);
            else if (action === 'shape') await api.executeCommand('doc.command.insert-float-shape.rectangle');
            else if (action === 'docInsertUrl') await doc!.insertImage({ source: url, imageSourceType: 'URL' as never, width: 80, height: 60, textRange: { startOffset: end(), endOffset: end() } } as never);
            else if (action === 'docInsertData') await doc!.insertImage({ source: url, imageSourceType: 'BASE64' as never, width: 80, height: 60, textRange: { startOffset: end(), endOffset: end() } } as never);
        } catch (e) {
            (window as unknown as { __facadeError?: string }).__facadeError = String(e).slice(0, 200);
        }
    }, { action, url });
}

const CASES: PathCase[] = [
    // ---- 表格 ----
    { id: 'S1-float-image', kind: 'sheet', method: 'F', what: '工具栏"插入浮动图片"（sheet.command.insert-float-image，文件选择框）', expect: 1, run: async (page) => {
        await clickCell(page, 'C3');
        await insertViaFileChooser(page, 'sheet.command.insert-float-image', [png()]);
    } },
    { id: 'S2-cell-image', kind: 'sheet', method: 'F', what: '工具栏"插入单元格图片"（sheet.command.insert-cell-image，文件选择框）', expect: 1, run: async (page) => {
        await clickCell(page, 'C3');
        await insertViaFileChooser(page, 'sheet.command.insert-cell-image', [png()]);
    } },
    { id: 'S4-paste-file', kind: 'sheet', method: 'P', what: '粘贴图片文件', expect: 1, run: async (page) => {
        await clickCell(page, 'C3');
        await syntheticPaste(page, { files: [png()] });
    } },
    { id: 'S5a-paste-html-data', kind: 'sheet', method: 'P', what: '粘贴 HTML：<img src="data:...">（剪贴板里没有文件）', expect: 0, run: async (page) => {
        await clickCell(page, 'C3');
        await syntheticPaste(page, { html: `<table><tr><td>文字</td><td><img src="${dataUrl(png())}"></td></tr></table>` });
    } },
    { id: 'S5b-paste-html-external', kind: 'sheet', method: 'P', what: '粘贴 HTML：外链 <img>', expect: 0, run: async (page) => {
        await clickCell(page, 'C3');
        await syntheticPaste(page, { html: `<table><tr><td>文字</td><td><img src="${EXTERNAL}"></td></tr></table>` });
    } },
    { id: 'S5c-paste-file-and-html', kind: 'sheet', method: 'P', what: '粘贴"图片文件 + 外链 <img> 的 HTML"（浏览器"复制图片"的形态）', expect: 0, run: async (page) => {
        await clickCell(page, 'C3');
        await syntheticPaste(page, { files: [png()], html: `<img src="${EXTERNAL}">` });
    } },
    { id: 'S7-formula-bar-paste', kind: 'sheet', method: 'P', what: '编辑栏里粘贴图片文件', expect: 0, run: async (page) => {
        await clickCell(page, 'C3');
        const box = (await page.locator('[data-u-comp="formula-bar"]').boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        await syntheticPaste(page, { files: [png()] });
        await page.waitForTimeout(800);
        await page.keyboard.press('Enter');
    } },
    { id: 'S7b-cell-editor-paste', kind: 'sheet', method: 'P', what: '单元格编辑器里（双击进入编辑）粘贴图片文件', expect: 0, run: async (page) => {
        const p = await cellCenter(page, 'C3');
        await page.mouse.dblclick(p.x, p.y);
        await page.waitForTimeout(400);
        await syntheticPaste(page, { files: [png()] });
        await page.waitForTimeout(800);
        await page.keyboard.press('Enter');
    } },
    { id: 'S8-internal-copy', kind: 'sheet', method: 'U', what: '插入浮动图片后，快捷键复制、在别处粘贴（内部复制）', expect: 2, run: async (page) => {
        await clickCell(page, 'C3');
        await insertViaFileChooser(page, 'sheet.command.insert-float-image', [png()]);
        await page.waitForTimeout(1200);
        // 先点选图片（左上角对齐 C3），否则复制的是单元格（P4 审查 R3）
        await page.keyboard.press('Escape');
        await clickCell(page, 'C3');
        await page.keyboard.press('Meta+C');
        await page.waitForTimeout(600);
        await clickCell(page, 'H12');
        await page.keyboard.press('Meta+V');
    } },
    { id: 'F1-insert-image-url', kind: 'sheet', method: 'F', what: 'FWorksheet.insertImage(外链)', expect: 0, run: (page) => facade(page, 'insertImageUrl', EXTERNAL) },
    { id: 'F2-cell-image-url', kind: 'sheet', method: 'F', what: 'FRange.insertCellImageAsync(外链)', expect: 0, run: (page) => facade(page, 'cellImageUrl', EXTERNAL) },
    { id: 'F3-background-url', kind: 'sheet', method: 'F', what: 'FWorksheet.setBackgroundImage(外链)（入口已隐藏）', expect: 0, run: (page) => facade(page, 'backgroundUrl', EXTERNAL) },
    { id: 'F4-insert-image-data', kind: 'sheet', method: 'F', what: 'FWorksheet.insertImage(data URL)', expect: 0, run: (page) => facade(page, 'insertImageData', dataUrl(png())) },
    // ---- 文字文档 ----
    { id: 'D1-insert-image', kind: 'doc', method: 'F', what: '工具栏"插入图片"（doc.command.insert-float-image，文件选择框）', expect: 1, run: async (page) => {
        await clickDocEnd(page);
        await insertViaFileChooser(page, 'doc.command.insert-float-image', [png()]);
    } },
    { id: 'D2-shape', kind: 'doc', method: 'F', what: '插入形状（doc.command.insert-float-shape.rectangle）', expect: 0, run: async (page) => {
        await clickDocEnd(page);
        await facade(page, 'shape', '');
    } },
    { id: 'D3-paste-file', kind: 'doc', method: 'P', what: '粘贴图片文件', expect: 1, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { files: [png()] });
    } },
    { id: 'D4-paste-html-data', kind: 'doc', method: 'P', what: '粘贴 HTML：<img src="data:...">', expect: 1, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { html: `<p>前<img src="${dataUrl(png())}">后</p>` });
    } },
    { id: 'D5-paste-html-external', kind: 'doc', method: 'P', what: '粘贴 HTML：外链、file:、blob: 的 <img>', expect: 3, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { html: `<p>一<img src="${EXTERNAL}">二<img src="file:///C:/Users/me/a.png">三<img src="blob:https://example.invalid/0f3e">四</p>` });
    } },
    { id: 'D6-paste-file-and-html', kind: 'doc', method: 'P', what: '粘贴"图片文件 + 外链 <img> 的 HTML"', expect: 2, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { files: [png()], html: `<img src="${EXTERNAL}">` });
    } },
    { id: 'D7-internal-copy', kind: 'doc', method: 'U', what: '插入图片后，选中它快捷键复制、在别处粘贴（内部复制）', expect: 2, run: async (page) => {
        await clickDocEnd(page);
        await insertViaFileChooser(page, 'doc.command.insert-float-image', [png()]);
        await page.waitForTimeout(1200);
        await page.evaluate(() => {
            const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
            const i = doc.getBody().dataStream.lastIndexOf('\b');
            doc.setSelection(i, i + 1);
        });
        await page.waitForTimeout(300);
        await page.keyboard.press('Meta+C');
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
            doc.setSelection(1, 1);
        });
        await page.waitForTimeout(300);
        await page.keyboard.press('Meta+V');
    } },
    // 粘贴带"内部片段"的 HTML（P4 审查 R1）：SDK 直接采用片段，不经过 HTML 转换；任何网页都能在复制时把它放进剪贴板
    { id: 'D8a-fragment-textfill', kind: 'doc', method: 'P', what: '粘贴内部片段：文字填充图片（ts.textFill.picture.source 为外链）', expect: 0, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { html: `${fragment(TEXT_FILL_DOC)}<p>TF</p>` });
    } },
    { id: 'D8b-fragment-array-source', kind: 'doc', method: 'P', what: '粘贴内部片段：source 为数组的图片', expect: 1, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { html: fragment(drawingDoc([`${EXTERNAL}?array`], 'URL')) });
    } },
    { id: 'D8c-fragment-no-type', kind: 'doc', method: 'P', what: '粘贴内部片段：没有 imageSourceType 的外链图片', expect: 1, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { html: fragment(drawingDoc(`${EXTERNAL}?notype`, undefined)) });
    } },
    { id: 'D8d-fragment-external', kind: 'doc', method: 'P', what: '粘贴内部片段：外链图片（对照）', expect: 1, run: async (page) => {
        await clickDocEnd(page);
        await syntheticPaste(page, { html: fragment(drawingDoc(`${EXTERNAL}?string`, 'URL')) });
    } },
    { id: 'S9-cell-editor-fragment', kind: 'sheet', method: 'P', what: '单元格编辑器里粘贴内部片段（外链图片）', expect: 0, run: async (page) => {
        const p = await cellCenter(page, 'C3');
        await page.mouse.dblclick(p.x, p.y);
        await page.waitForTimeout(400);
        await syntheticPaste(page, { html: fragment(drawingDoc(`${EXTERNAL}?cell`, 'URL')) });
        await page.waitForTimeout(800);
        await page.keyboard.press('Escape');
    } },
    { id: 'F5-doc-insert-url', kind: 'doc', method: 'F', what: 'FDocument.insertImage(外链)', expect: 0, run: (page) => facade(page, 'docInsertUrl', EXTERNAL) },
    { id: 'F6-doc-insert-data', kind: 'doc', method: 'F', what: 'FDocument.insertImage(data URL)', expect: 0, run: (page) => facade(page, 'docInsertData', dataUrl(png())) },
];

/** 等到快照里出现新增图片，或者超时（预期不新增的路径等满 3 秒）。 */
async function settle(page: Page, beforeCount: number, expectAdd: boolean): Promise<void> {
    const deadline = Date.now() + (expectAdd ? 10_000 : 3000);
    while (Date.now() < deadline) {
        const n = await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()).match(/"(?:imageSourceType|sourceType)"/g)?.length ?? 0);
        if (expectAdd && n > beforeCount) break;
        await page.waitForTimeout(200);
    }
    await waitQuiet(page);
    await page.waitForTimeout(1000);
}

for (const c of CASES) {
    for (const img of ['default', 'platform'] as const) {
        test(`V11 图片路径：${c.id}（${img}）`, async ({ page, context }, testInfo) => {
            test.setTimeout(120_000);
            if (testInfo.project.name !== 'webkit') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
            const origin = new URL(SERVERS.full).origin;
            await page.goto(`/${c.kind}.html?sample=minimal&img=${img}${c.kind === 'sheet' ? '&worker=1' : ''}`);
            await waitForEditor(page);
            await waitQuiet(page);
            const beforeText = await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));
            const before = snapshotImages(beforeText, origin);
            await resetAssetLogs(page.request, SERVERS.full);
            await page.evaluate(() => {
                window.__m0!.events.cspViolations.length = 0;
                window.__m0!.events.errors.length = 0;
                window.__m0!.events.consoleErrors.length = 0;
                window.__m0!.images!.events.length = 0;
            });
            const m0 = await detectorMark(page);
            const beforeCount = beforeText.match(/"(?:imageSourceType|sourceType)"/g)?.length ?? 0;

            let actionError: string | null = null;
            try {
                await c.run(page);
            } catch (e) {
                actionError = String(e).split('\n')[0].slice(0, 200);
            }
            await settle(page, beforeCount, c.expect > 0);

            const afterText = await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));
            const after = snapshotImages(afterText, origin);
            const added = addedImages(before.images, after.images);
            const assets = await assetsState(page.request, SERVERS.full);
            const platformSources = [...new Set(added.filter((i) => i.kind === 'platform').map((i) => i.source))];
            const load = await imageLoadState(page, platformSources);
            const state = await detectorState(page, m0);
            const page4 = await page.evaluate(() => ({
                imageEvents: window.__m0!.images!.events,
                errors: [...window.__m0!.events.errors, ...window.__m0!.events.consoleErrors].map((x) => x.slice(0, 160)),
                facadeError: (window as unknown as { __facadeError?: string }).__facadeError ?? null,
            }));
            const violations = await cspViolations(page);

            const kinds = [...new Set(added.map((i) => i.kind))];
            const nonPlatform = added.filter((i) => i.kind !== 'platform');
            // 新增的图片数：文字文档只数正文的 drawings（资源 DOC_DRAWING_PLUGIN 里还有一份副本），表格全部都数
            const addedCount = added.filter((i) => c.kind === 'sheet' || i.where.startsWith('/drawings/')).length;
            const verdict = added.length === 0
                ? (page4.imageEvents.some((e) => e.kind === 'guard-cancel') ? '被命令守卫取消' : '没有新增图片')
                : nonPlatform.length === 0 ? '全部为平台地址' : `含非平台地址：${[...new Set(nonPlatform.map((i) => i.kind))].join('、')}`;

            await writeResult(`v11/paths/${testInfo.project.name}-${c.id}-${img}.json`, {
                check: 'V11-paths',
                case: { id: c.id, kind: c.kind, method: c.method, what: c.what },
                img,
                browser: browserInfo(page, testInfo),
                timestamp: new Date().toISOString(),
                verdict,
                expectedCount: c.expect,
                addedCount,
                actionError,
                added: added.map((i) => ({ where: i.where, kind: i.kind, imageSourceType: i.imageSourceType, source: i.source.slice(0, 120) })),
                addedKinds: kinds,
                stray: after.stray.filter((s) => !before.stray.some((b) => b.where === s.where)).map((s) => ({ ...s, value: s.value.slice(0, 120) })),
                uploads: assets.uploads.map((u) => ({ status: u.status, bytes: u.bytes, reason: u.reason ?? null, hasSession: u.session != null })),
                reads: assets.reads.map((r) => ({ status: r.status, hasSession: r.session != null, mode: r.secFetchMode, dest: r.secFetchDest })),
                load,
                imageEvents: page4.imageEvents.map((e) => ({ kind: e.kind, ok: e.ok, detail: e.detail })),
                detections: brief(state).detections,
                cspViolations: violations,
                pageErrors: page4.errors,
                facadeError: page4.facadeError,
                snapshotBytes: afterText.length,
            });

            // 平台配置下的要求：新增的图片全部是平台地址（含占位图）；平台地址都能读、读取都带会话；不产生 CSP 违规
            if (img === 'platform') {
                expect.soft(nonPlatform.map((i) => `${i.kind} ${i.where}`), '新增图片全部是平台地址').toEqual([]);
                expect.soft(addedCount, '新增图片数符合预期（P4 审查 R3）').toBe(c.expect);
                expect.soft(load.filter((l) => !(l.complete && l.width > 0) && l.cached).map((l) => l.source), '平台地址的图片加载成功').toEqual([]);
                expect.soft(assets.reads.filter((r) => r.session == null || r.status !== 200).length, '读取都带会话且成功').toBe(0);
            }
        });
    }
}

// 文字文档的形状入口已隐藏（插件档案 v1 §5.1；P4 审查 S6）
test('V11 文字文档的形状入口已隐藏', async ({ page }) => {
    await page.goto('/doc.html?sample=minimal');
    await waitForEditor(page);
    const items = await page.evaluate(() => window.__m0!.auditMenus!().filter((i) => i.id === 'doc.command.menu-insert-shape' || i.id === 'doc.command.menu-insert-shape.below'));
    expect(items.length, '找到两个形状入口').toBe(2);
    expect(items.every((i) => i.hidden === true), '两个形状入口都已隐藏').toBe(true);
});

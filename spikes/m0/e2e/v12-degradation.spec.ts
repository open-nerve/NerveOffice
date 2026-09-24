// V12 功能降级与 CSP 定稿（P4，00 号计划书 §11.3），严格 CSP，两种图片服务对照：
// 1. 复制浮动图片到系统剪贴板（Chromium 内核；无头 WebKit 不能读剪贴板）；
// 2. "保存单元格图片"（单张时直接下载：URL 类型走同源 fetch，BASE64 类型走 fetch(data:)，受 connect-src 约束）；
// 3. 双击预览；
// 4. 移动图片之后的重新加载；
// 5. 拖放文件（SDK 不处理；合成的 drop 事件不会触发浏览器打开文件的默认行为，只能核对 SDK 这一侧）；
// 6. CSP 定稿：在平台配置下走一遍代表性的路径，收集强制策略与探测策略（去掉 data:、blob:、'unsafe-inline' 的只报告策略）的违规，
//    判断每项放宽是否必要（页面加载时的违规也算在内）。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { waitQuiet } from './p3-helpers';
import { assetsState, cspViolations, fixtureFile, insertViaFileChooser, resetAssetLogs, syntheticPaste } from './p4-helpers';

test.use({ baseURL: SERVERS.full });

const BASE = SERVERS.full;

async function clickCell(page: Page, a1: string): Promise<void> {
    const p = await cellCenter(page, a1);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
}

async function pageErrors(page: Page): Promise<string[]> {
    return page.evaluate(() => [...window.__m0!.events.errors, ...window.__m0!.events.consoleErrors].map((x) => x.slice(0, 160)));
}

for (const img of ['default', 'platform'] as const) {
    test(`V12 功能降级：${img}`, async ({ page, context }, testInfo) => {
        test.setTimeout(240_000);
        const chromium = testInfo.project.name !== 'webkit';
        if (chromium) await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const out: Record<string, unknown> = {};
        await page.goto(`/sheet.html?sample=minimal&img=${img}&worker=1`);
        await waitForEditor(page);

        // 1. 复制浮动图片：点选图片，快捷键复制，再读系统剪贴板
        await clickCell(page, 'C3');
        await insertViaFileChooser(page, 'sheet.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
        await page.waitForTimeout(1500);
        // 点一下图片（左上角对齐 C3）选中它，再复制
        await page.keyboard.press('Escape');
        const onImage = await cellCenter(page, 'C3');
        await page.mouse.click(onImage.x, onImage.y);
        await page.waitForTimeout(500);
        await page.keyboard.press('Meta+C');
        await page.waitForTimeout(500);
        out.copyToSystem = chromium
            ? await page.evaluate(async () => {
                try {
                    const items = await Promise.race([navigator.clipboard.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
                    const list = [];
                    for (const item of items) {
                        for (const type of item.types) list.push({ type, size: (await item.getType(type)).size });
                    }
                    return { ok: true, items: list };
                } catch (e) {
                    return { ok: false, error: String(e).slice(0, 120) };
                }
            })
            : { ok: false, error: '无头 WebKit 不能读剪贴板' };

        // 2. 保存单元格图片：插入单元格图片，选中它，执行"保存单元格图片"
        await clickCell(page, 'B8');
        await insertViaFileChooser(page, 'sheet.command.insert-cell-image', [fixtureFile('orange-64x64.png')]);
        await page.waitForTimeout(1500);
        await clickCell(page, 'B8');
        await page.evaluate(() => {
            window.__m0!.events.cspViolations.length = 0;
            window.__m0!.events.consoleErrors.length = 0;
        });
        const download = page.waitForEvent('download', { timeout: 8000 }).then((d) => ({ ok: true, name: d.suggestedFilename() })).catch((e) => ({ ok: false, error: String(e).split('\n')[0].slice(0, 120) }));
        const executed = await page.evaluate(() => window.__m0!.editor!.univerAPI.executeCommand('sheet.command.save-cell-images').then((r) => r, (e) => String(e)));
        out.saveCellImage = { executed, download: await download, csp: (await cspViolations(page)).filter((v) => v.disposition === 'enforce').map((v) => `${v.directive} ${v.blocked.slice(0, 30)}`), errors: await pageErrors(page) };

        // 3. 双击预览：双击浮动图片所在位置，看预览里的 <img> 是否加载
        await resetAssetLogs(page.request, BASE);
        // 浮动图片插在选中的 C3，左上角对齐 C3，双击 C3 的中心就落在图片上
        const c3 = await cellCenter(page, 'C3');
        await page.mouse.dblclick(c3.x, c3.y);
        await page.waitForTimeout(1200);
        out.preview = {
            images: await page.evaluate(() => [...document.querySelectorAll('img')].filter((e) => e.src.includes('/api/assets/') || e.src.startsWith('data:image/png')).map((e) => ({ src: e.src.slice(0, 60), complete: e.complete, width: e.naturalWidth }))),
            reads: (await assetsState(page.request, BASE)).reads.map((r) => ({ status: r.status, hasSession: r.session != null })),
        };
        await page.keyboard.press('Escape');

        // 4. 移动图片：SDK 用原始地址重设 src（不经过 IURLImageService），看是否重新读取、有没有错误
        await resetAssetLogs(page.request, BASE);
        const moved = await page.evaluate(async () => {
            const image = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().getImages()[0];
            if (image == null) return false;
            await (image as unknown as { setPositionAsync(row: number, col: number): Promise<unknown> }).setPositionAsync(6, 6);
            return true;
        });
        await page.waitForTimeout(1200);
        out.move = { moved, reads: (await assetsState(page.request, BASE)).reads.map((r) => ({ status: r.status, hasSession: r.session != null })), errors: await pageErrors(page) };

        // 5. 拖放文件：合成 drop 事件，看 SDK 是否插入图片、是否调用 preventDefault
        const before = await page.evaluate(() => window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().getImages().length);
        const drop = await page.evaluate(async (f) => {
            const canvas = document.querySelector('canvas[id^="univer-sheet-main-canvas"]') as HTMLCanvasElement;
            const r = canvas.getBoundingClientRect();
            const dt = new DataTransfer();
            dt.items.add(new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
            const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200 };
            const over = new DragEvent('dragover', opts);
            canvas.dispatchEvent(over);
            const ev = new DragEvent('drop', opts);
            canvas.dispatchEvent(ev);
            await new Promise((res) => setTimeout(res, 1500));
            return { dragoverPrevented: over.defaultPrevented, dropPrevented: ev.defaultPrevented };
        }, fixtureFile('blue-120x80.png'));
        const after = await page.evaluate(() => window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().getImages().length);
        out.drop = { ...drop, inserted: after - before, url: page.url() };

        await writeResult(`v12/degradation/${testInfo.project.name}-${img}.json`, { check: 'V12-degradation', img, browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...out });
        if (img === 'platform') expect.soft((out.saveCellImage as { download: { ok: boolean } }).download.ok, '平台配置：保存单元格图片可用').toBe(true);
    });
}

test('V12 CSP 定稿：平台配置下的违规汇总', async ({ page, context }, testInfo) => {
    test.setTimeout(240_000);
    if (testInfo.project.name !== 'webkit') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const out: Record<string, unknown>[] = [];
    const summarize = async (label: string) => {
        const v = await cspViolations(page);
        const group = (disposition: string) => {
            const counts: Record<string, number> = {};
            for (const x of v.filter((y) => (disposition === 'enforce' ? y.disposition === 'enforce' : y.disposition !== 'enforce'))) {
                const scheme = /^(data|blob|inline|eval|https?)/.exec(x.blocked)?.[1] ?? x.blocked.slice(0, 30);
                const key = `${x.directive} ${scheme}`;
                counts[key] = (counts[key] ?? 0) + 1;
            }
            return counts;
        };
        out.push({ step: label, enforce: group('enforce'), probe: group('report') });
    };
    // 表格：加载、插入浮动图片、单元格图片、粘贴图片文件、IMAGE()、内部复制粘贴
    await page.goto('/sheet.html?sample=sheet-all&img=platform&imagefn=restricted&worker=1');
    await waitForEditor(page);
    await summarize('表格：加载 sheet-all');
    await page.evaluate(() => {
        window.__m0!.events.cspViolations.length = 0;
    });
    await clickCell(page, 'H3');
    await insertViaFileChooser(page, 'sheet.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
    await page.waitForTimeout(1200);
    await page.keyboard.press('Meta+C');
    await clickCell(page, 'J12');
    await page.keyboard.press('Meta+V');
    await page.waitForTimeout(800);
    await clickCell(page, 'H14');
    await insertViaFileChooser(page, 'sheet.command.insert-cell-image', [fixtureFile('orange-64x64.png')]);
    await clickCell(page, 'H16');
    await syntheticPaste(page, { files: [fixtureFile('blue-120x80.png')] });
    await page.waitForTimeout(1200);
    await page.evaluate(async () => {
        const blob = await (await fetch('/fixtures-assets/blue-120x80.png')).blob();
        const r = await window.__m0!.images!.io().saveImage(new File([blob], 'b.png', { type: 'image/png' }));
        window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange('H20').setValue(`=IMAGE("${r!.source}")`);
    });
    await page.waitForTimeout(1500);
    await waitQuiet(page);
    await summarize('表格：插入、复制粘贴、单元格图片、粘贴文件、IMAGE()');
    // 文字文档：加载、插入图片、粘贴文件、粘贴外链 HTML、内部复制粘贴
    await page.goto('/doc.html?sample=doc-all&img=platform');
    await waitForEditor(page);
    await summarize('文字文档：加载 doc-all');
    await page.evaluate(() => {
        window.__m0!.events.cspViolations.length = 0;
        const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
        const end = doc.getBody().dataStream.length - 2;
        doc.setSelection(end, end);
    });
    await page.waitForTimeout(300);
    await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
    await page.waitForTimeout(1200);
    await syntheticPaste(page, { files: [fixtureFile('orange-64x64.png')] });
    await page.waitForTimeout(1200);
    await syntheticPaste(page, { html: '<p>外链<img src="https://example.invalid/x.png">图片</p>' });
    await page.waitForTimeout(1200);
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Meta+C');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Meta+V');
    await page.waitForTimeout(1500);
    await waitQuiet(page);
    await summarize('文字文档：插入、粘贴文件、粘贴外链 HTML、全选复制粘贴');
    await writeResult(`v12/csp/${testInfo.project.name}.json`, { check: 'V12-csp', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), results: out });
});

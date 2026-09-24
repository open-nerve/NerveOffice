// V11-2 同源读取与授权（P4，00 号计划书 §8.5、§11.4），严格 CSP，img=platform：
// 1. 同一会话重开：图片都能加载，读取都带会话 Cookie；
// 2. 另一个会话：经由文档引用可以读；只上传、没有随快照保存的图片读不到（403）；
// 3. 没有会话 Cookie：读取返回 401，编辑器显示占位图，记录页面错误；
// 4. 复制文档：副本里的图片能读，引用关系增加，文件不复制；
// 5. 上传失败（503、413、415）与客户端的类型、大小检查：不插入图片、给出提示；
// 6. 服务端的保存校验：平台配置的快照通过，默认配置（data URL）的快照被拒绝。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, cellCenter, SERVERS, waitForEditor, writeResult } from './helpers';
import { waitQuiet } from './p3-helpers';
import { assetsState, fixtureFile, imageLoadState, insertViaFileChooser, resetAssetLogs, snapshotImages } from './p4-helpers';

test.use({ baseURL: SERVERS.full });

const BASE = SERVERS.full;
const ORIGIN = new URL(BASE).origin;

async function clickCell(page: Page, a1: string): Promise<void> {
    const p = await cellCenter(page, a1);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
}

async function clickDocEnd(page: Page): Promise<void> {
    await page.evaluate(() => {
        const doc = window.__m0!.editor!.univerAPI.getActiveDocument()!;
        const end = doc.getBody().dataStream.length - 2;
        doc.setSelection(end, end);
    });
    await page.waitForTimeout(300);
}

async function snapshot(page: Page): Promise<string> {
    return page.evaluate(() => JSON.stringify(window.__m0!.editor!.save()));
}

/** 在平台配置下插入图片：表格插入浮动图片与单元格图片，文字文档插入一张图片；返回快照中的平台地址。 */
async function insertImages(page: Page, kind: 'sheet' | 'doc'): Promise<string[]> {
    if (kind === 'sheet') {
        await clickCell(page, 'C3');
        await insertViaFileChooser(page, 'sheet.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
        await page.waitForTimeout(1500);
        await clickCell(page, 'B8');
        await insertViaFileChooser(page, 'sheet.command.insert-cell-image', [fixtureFile('orange-64x64.png')]);
    } else {
        await clickDocEnd(page);
        await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
    }
    await page.waitForTimeout(1500);
    await waitQuiet(page);
    return [...new Set(snapshotImages(await snapshot(page), ORIGIN).images.filter((i) => i.kind === 'platform').map((i) => i.source))];
}

/** 打开文档后等图片渲染（读取发生在渲染时）。 */
async function openStored(page: Page, kind: 'sheet' | 'doc', id: string): Promise<void> {
    await page.goto(`/${kind}.html?doc=${id}&img=platform${kind === 'sheet' ? '&worker=1' : ''}`);
    await waitForEditor(page);
    await page.waitForTimeout(1500);
}

async function pageErrors(page: Page): Promise<string[]> {
    return page.evaluate(() => [...window.__m0!.events.errors, ...window.__m0!.events.consoleErrors].map((x) => x.slice(0, 160)));
}

for (const kind of ['sheet', 'doc'] as const) {
    test(`V11 同源读取与授权：${kind}`, async ({ page, browser }, testInfo) => {
        test.setTimeout(240_000);
        const id = `v11-assets-${testInfo.project.name}-${kind}`;
        await page.goto(`/${kind}.html?sample=minimal&img=platform${kind === 'sheet' ? '&worker=1' : ''}`);
        await waitForEditor(page);
        const sources = await insertImages(page, kind);
        await page.evaluate((docId) => window.__m0!.persist!(docId), id);
        const uploaderCookies = await page.context().cookies();

        // 1. 同一会话重开
        await resetAssetLogs(page.request, BASE);
        await openStored(page, kind, id);
        const sameSession = {
            reads: (await assetsState(page.request, BASE)).reads.map((r) => ({ status: r.status, hasSession: r.session != null, mode: r.secFetchMode })),
            load: await imageLoadState(page, sources),
            errors: await pageErrors(page),
        };

        // 2. 另一个会话：经由文档引用读取；另传一张不随快照保存的图片，另一个会话直接读它
        const orphan = await page.evaluate(async () => {
            const blob = await (await fetch('/fixtures-assets/orange-64x64.png')).blob();
            const r = await window.__m0!.images!.io().saveImage(new File([blob], 'orphan.png', { type: 'image/png' }));
            return r!.source;
        });
        const other = await browser.newContext({ baseURL: BASE });
        const otherPage = await other.newPage();
        await resetAssetLogs(otherPage.request, BASE);
        await openStored(otherPage, kind, id);
        const otherSession = {
            reads: (await assetsState(otherPage.request, BASE)).reads.map((r) => ({ status: r.status, hasSession: r.session != null })),
            load: await imageLoadState(otherPage, sources),
            orphanStatus: (await otherPage.request.get(orphan)).status(),
            orphanStatusForUploader: (await page.request.get(orphan)).status(),
            referencedStatus: (await otherPage.request.get(sources[0])).status(),
            errors: await pageErrors(otherPage),
        };

        // 4. 复制文档：副本里的图片能读，引用关系增加，文件不复制
        const copyId = `${id}-copy`;
        const filesBefore = (await assetsState(page.request, BASE)).files;
        await page.request.post(`${BASE}/api/docs/${id}/copy?to=${copyId}`);
        const afterCopy = await assetsState(page.request, BASE);
        await page.request.delete(`${BASE}/api/docs/${id}`);
        const copyStatus = (await otherPage.request.get(sources[0])).status();
        await other.close();

        // 3. 没有会话 Cookie：新的浏览器上下文，页面响应不下发 Cookie（nosession=1），图片读取返回 401
        const anonymous = await browser.newContext({ baseURL: BASE });
        const anonPage = await anonymous.newPage();
        await resetAssetLogs(anonPage.request, BASE);
        await anonPage.goto(`/${kind}.html?doc=${copyId}&img=platform&nosession=1${kind === 'sheet' ? '&worker=1' : ''}`);
        await waitForEditor(anonPage);
        await anonPage.waitForTimeout(1500);
        const noCookie = {
            cookies: (await anonymous.cookies()).length,
            reads: (await assetsState(anonPage.request, BASE)).reads.map((r) => ({ status: r.status, hasSession: r.session != null })),
            load: await imageLoadState(anonPage, sources),
            errors: await pageErrors(anonPage),
        };
        await anonymous.close();

        await writeResult(`v11/assets/${testInfo.project.name}-${kind}.json`, {
            check: 'V11-assets',
            kind,
            browser: browserInfo(page, testInfo),
            timestamp: new Date().toISOString(),
            sources,
            uploaderCookie: uploaderCookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, sameSite: c.sameSite })),
            sameSession,
            otherSession,
            copy: { filesBefore, filesAfter: afterCopy.files, links: afterCopy.links[copyId] ?? [], statusAfterSourceDeleted: copyStatus },
            noCookie,
        });

        expect.soft(sources.length, '插入了平台地址的图片').toBeGreaterThan(0);
        expect.soft(sameSession.reads.every((r) => r.status === 200 && r.hasSession), '同一会话：读取成功且带会话').toBe(true);
        expect.soft(otherSession.reads.every((r) => r.status === 200), '另一个会话：经由文档引用可以读').toBe(true);
        expect.soft(otherSession.orphanStatus, '另一个会话：没有随快照保存的图片读不到').toBe(403);
        expect.soft(otherSession.orphanStatusForUploader, '上传者本人 24 小时内可以读').toBe(200);
        expect.soft(afterCopy.files, '复制文档不复制文件').toBe(filesBefore);
        expect.soft(copyStatus, '原文档删除后，副本的引用仍能读').toBe(200);
        expect.soft(noCookie.reads.every((r) => r.status === 401), '没有会话：读取返回 401').toBe(true);
    });
}

test('V11 上传失败与限制：表格与文字文档', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const out: Record<string, unknown>[] = [];
    const big = { name: 'big.png', type: 'image/png', base64: Buffer.alloc(6 * 1024 * 1024, 1).toString('base64') };
    const svg = { name: 'x.svg', type: 'image/svg+xml', base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') };
    const fakePng = { name: 'fake.png', type: 'image/png', base64: Buffer.from('<html><script>alert(1)</script></html>').toString('base64') };
    const cases = [
        { id: 'server-503', inject: 503, file: fixtureFile('blue-120x80.png') },
        { id: 'client-too-large', inject: null, file: big },
        { id: 'client-svg', inject: null, file: svg },
        { id: 'server-fake-png', inject: null, file: fakePng },
    ];
    for (const kind of ['sheet', 'doc'] as const) {
        for (const c of cases) {
            await page.goto(`/${kind}.html?sample=minimal&img=platform${kind === 'sheet' ? '&worker=1' : ''}`);
            await waitForEditor(page);
            await resetAssetLogs(page.request, BASE);
            if (c.inject != null) await page.request.post(`${BASE}/__assets/fail?status=${c.inject}&count=1`);
            const before = snapshotImages(await snapshot(page), ORIGIN).images.length;
            if (kind === 'sheet') await clickCell(page, 'C3');
            else await clickDocEnd(page);
            let error: string | null = null;
            try {
                await insertViaFileChooser(page, kind === 'sheet' ? 'sheet.command.insert-float-image' : 'doc.command.insert-float-image', [c.file]);
            } catch (e) {
                error = String(e).split('\n')[0];
            }
            await page.waitForTimeout(1500);
            const after = snapshotImages(await snapshot(page), ORIGIN).images.length;
            // SDK 用 sonner 显示提示（3 秒后消失）
            const messages = await page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].map((e) => (e.textContent ?? '').trim()).filter((t) => t !== '').slice(0, 5));
            const assets = await assetsState(page.request, BASE);
            out.push({
                kind,
                case: c.id,
                added: after - before,
                uploads: assets.uploads.map((u) => ({ status: u.status, reason: u.reason ?? null })),
                imageEvents: await page.evaluate(() => window.__m0!.images!.events.slice(-3).map((e) => ({ kind: e.kind, ok: e.ok, detail: e.detail }))),
                messages,
                errors: await pageErrors(page),
                error,
            });
        }
    }
    await writeResult(`v11/limits/${testInfo.project.name}.json`, { check: 'V11-limits', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), results: out });
    for (const r of out) expect.soft(r.added, `${r.kind} ${r.case}：不插入图片`).toBe(0);
});

test('V11 服务端的保存校验', async ({ page }, testInfo) => {
    const out: Record<string, unknown>[] = [];
    for (const img of ['default', 'platform'] as const) {
        for (const kind of ['sheet', 'doc'] as const) {
            await page.goto(`/${kind}.html?sample=minimal&img=${img}${kind === 'sheet' ? '&worker=1' : ''}`);
            await waitForEditor(page);
            if (kind === 'sheet') {
                await clickCell(page, 'C3');
                await insertViaFileChooser(page, 'sheet.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
            } else {
                await clickDocEnd(page);
                await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
            }
            await page.waitForTimeout(1500);
            await waitQuiet(page);
            const text = await snapshot(page);
            const res = await page.request.put(`${BASE}/api/docs/v11-validate-${testInfo.project.name}-${kind}-${img}?validate=1`, { data: text, headers: { 'Content-Type': 'application/json' } });
            out.push({ img, kind, status: res.status(), body: res.status() === 204 ? null : (await res.text()).slice(0, 300) });
        }
    }
    await writeResult(`v11/validate/${testInfo.project.name}.json`, { check: 'V11-validate', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), results: out });
    for (const r of out) expect.soft(r.status, `${r.kind} ${r.img}`).toBe(r.img === 'platform' ? 204 : 422);
});

// 读取失败时的处理：SDK 用 <img> 读取图片，读取失败（401、403、404）时渲染可能对破损的图片调用 drawImage，抛出未捕获的 InvalidStateError。
// 对照：同样没有会话，服务端返回错误状态码（SERVERS.full）与返回占位图（SERVERS.fallback，--asset-fallback）各打开 3 次，比较页面错误。
for (const kind of ['sheet', 'doc'] as const) {
    test(`V11 读取失败时返回占位图：${kind}`, async ({ browser }, testInfo) => {
        test.setTimeout(240_000);
        const out: Record<string, unknown>[] = [];
        for (const [label, base] of [['error-status', SERVERS.full], ['placeholder', SERVERS.fallback]] as const) {
            const owner = await browser.newContext({ baseURL: base });
            const page = await owner.newPage();
            const id = `v11-fallback-${testInfo.project.name}-${kind}`;
            await page.goto(`/${kind}.html?sample=minimal&img=platform${kind === 'sheet' ? '&worker=1' : ''}`);
            await waitForEditor(page);
            if (kind === 'sheet') {
                await clickCell(page, 'C3');
                await insertViaFileChooser(page, 'sheet.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
            } else {
                await clickDocEnd(page);
                await insertViaFileChooser(page, 'doc.command.insert-float-image', [fixtureFile('blue-120x80.png')]);
            }
            await page.waitForTimeout(1500);
            await waitQuiet(page);
            await page.evaluate((docId) => window.__m0!.persist!(docId), id);
            await owner.close();
            for (let i = 0; i < 3; i++) {
                const anon = await browser.newContext({ baseURL: base });
                const anonPage = await anon.newPage();
                await anonPage.goto(`/${kind}.html?doc=${id}&img=platform&nosession=1${kind === 'sheet' ? '&worker=1' : ''}`);
                await waitForEditor(anonPage);
                await anonPage.waitForTimeout(1500);
                await anonPage.mouse.wheel(0, 200);
                await anonPage.waitForTimeout(600);
                await anonPage.mouse.wheel(0, -200);
                await anonPage.waitForTimeout(600);
                const state = await assetsState(anonPage.request, base);
                out.push({
                    server: label,
                    run: i,
                    reads: state.reads.slice(-3).map((r) => r.status),
                    errors: await pageErrors(anonPage),
                });
                await anon.close();
            }
        }
        await writeResult(`v11/fallback/${testInfo.project.name}-${kind}.json`, { check: 'V11-fallback', kind, timestamp: new Date().toISOString(), results: out });
        for (const r of out.filter((x) => x.server === 'placeholder')) expect.soft((r.errors as string[]).length, '返回占位图时没有页面错误').toBe(0);
    });
}

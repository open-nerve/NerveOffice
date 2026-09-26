// V14-3 配额（P6，00 号计划书 §7.6）：
// - 三个浏览器：navigator.storage 的 estimate()、persisted()、persist()；
// - 写满：Chromium 内核用 CDP 的 Storage.overrideQuotaForOrigin 把本站配额设小，用 1 MiB 表格的快照以不同的键反复写入，直到失败；
//   检查错误类型、失败的写入没有留下半截记录、之前的记录仍能解密、自动保存报告错误并保留已有记录。
import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, writeResult } from './helpers';
import { ensureGenerated } from './p3-helpers';
import { edit, openWithOutbox, outboxInfo } from './p6-helpers';

test('V14 配额：估算与持久化申请', async ({ page }, testInfo) => {
    await page.goto(`${SERVERS.full}/index.html`);
    const storage = await page.evaluate(async () => ({
        estimate: await navigator.storage.estimate(),
        persisted: await navigator.storage.persisted(),
        persist: await navigator.storage.persist().catch((e: unknown) => `错误：${String(e)}`),
        persistedAfter: await navigator.storage.persisted(),
    }));
    await writeResult(`v14/quota/${testInfo.project.name}-estimate.json`, { check: 'V14-quota-estimate', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...storage });
    expect(storage.estimate.quota ?? 0, '有配额估算').toBeGreaterThan(0);
});

test('V14 配额：写满时', async ({ page, request, context }, testInfo) => {
    test.skip(testInfo.project.name === 'webkit', 'WebKit 没有覆盖配额的接口；默认配额见"估算与持久化申请"');
    test.setTimeout(300_000);
    const source = await ensureGenerated(page, request, 'sheet', 'big-1m');
    const id = `p6-quota-${testInfo.project.name}`;
    const big = await request.get(`${SERVERS.off}/api/docs/${source}`);
    await request.put(`${SERVERS.off}/api/docs/${id}`, { data: await big.json() });
    const user = `quota-${testInfo.project.name}-${Date.now()}`;
    const quotaSize = 8 * 1024 * 1024;
    // 配额覆盖必须在本站第一次写入 IndexedDB 之前设置，否则不生效（P6 审查 S3）；发件箱一装上就会写持有者记录，
    // 所以先在同源的空白页上设置，再带发件箱打开文档
    await page.goto(`${SERVERS.off}/index.html`);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(SERVERS.off).origin, quotaSize });
    await openWithOutbox(page, SERVERS.off, { kind: 'sheet', doc: id, user });
    const fill = await page.evaluate(async () => {
        const out: { key: string; error: string | null; cipherBytes: number; localSeq: number }[] = [];
        for (let i = 0; i < 200; i++) {
            const r = await window.__m0!.outbox!.capture({ force: true, docId: `fill-${i}` });
            out.push({ key: `fill-${i}`, error: r.error, cipherBytes: r.cipherBytes, localSeq: r.localSeq });
            if (r.error != null) break;
        }
        return { writes: out, estimate: await navigator.storage.estimate() };
    });
    const failed = fill.writes.find((w) => w.error != null) ?? null;
    const checks = await page.evaluate(async (failedKey) => {
        const o = window.__m0!.outbox!;
        const firstBefore = (await o.inspect('fill-0')).record?.localSeq ?? null;
        // 覆盖已有的记录时配额不足：把内容变大再写同一个键，原记录应当不变
        const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
        ws.getRange(0, 0, 200, 10).setValues(Array.from({ length: 200 }, (_, r) => Array.from({ length: 10 }, (_, c) => `扩大内容 ${r}-${c} ${Math.random()}`)));
        const overwrite = await o.capture({ force: true, docId: 'fill-0' });
        const firstAfter = await o.inspect('fill-0');
        return {
            first: firstAfter.status,
            failed: failedKey == null ? null : (await o.inspect(failedKey)).status,
            overwriteError: overwrite.error,
            firstSeqBefore: firstBefore,
            firstSeqAfter: firstAfter.record?.localSeq ?? null,
        };
    }, failed?.key ?? null);
    // 自动保存遇到配额不足：报告错误，已有记录不动
    await edit(page, 'sheet', 'P6Q1');
    await page.waitForFunction(() => window.__m0!.outbox!.autosave()!.status() === 'error', null, { timeout: 15_000 }).catch(() => undefined);
    const autosave = await outboxInfo(page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(SERVERS.off).origin });
    await writeResult(`v14/quota/${testInfo.project.name}-full.json`, {
        check: 'V14-quota-full', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(),
        quotaSize, writes: fill.writes.length, failed, estimate: fill.estimate, checks, autosave,
    });
    expect(failed, '写满时失败').not.toBeNull();
    expect(failed!.error, '错误类型').toBe('QuotaExceededError');
    expect(checks.failed, '失败的写入没有留下记录').toBe('none');
    // fill-* 不是服务端的文档（没有修订号），能解密时状态为 conflict；解密失败才是 undecryptable
    expect(['restorable', 'conflict'], '之前的记录仍能解密').toContain(checks.first);
    expect(checks.overwriteError, '覆盖已有记录时配额不足').toBe('QuotaExceededError');
    expect(checks.firstSeqAfter, '覆盖失败：原记录不变').toBe(checks.firstSeqBefore);
    expect(autosave.autosave, '自动保存报告错误').toBe('error');
    expect(autosave.lastError).toBe('QuotaExceededError');
});

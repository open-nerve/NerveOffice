// V14-4 多标签页协调（P6，00 号计划书 §7.5）：同一浏览器上下文里的多个页面打开同一文档。
// - 编辑中的标签页持有文档的排他锁；另一个标签页拿不到锁，进入只读，不写发件箱，排队等锁；
// - 持有者关闭、崩溃、导航离开后，排队的标签页接手：发件箱里有未同步记录就提示恢复，没有就开始自动保存；
// - 接手时服务端的修订号比打开时新：先从服务端重新加载（P6 审查 G3）；
// - 锁被抢走（steal）的标签页停止写入；即使绕过锁状态检查，写入也被存储层的栅栏拒绝（P6 审查 R1）。
import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, writeResult } from './helpers';
import { focusEditor, setSelection } from './p5-helpers';
import { contains, edit, openWithOutbox, outboxInfo, storeFixture, waitSavedLocal } from './p6-helpers';

async function waitState(page: Page, states: string[], timeoutMs = 10_000): Promise<{ state: string; ms: number }> {
    return page.evaluate(async ({ states, timeoutMs }) => {
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
            const s = window.__m0!.outbox!.state();
            if (states.includes(s)) return { state: s, ms: performance.now() - t0 };
            await new Promise((r) => setTimeout(r, 10));
        }
        return { state: window.__m0!.outbox!.state(), ms: performance.now() - t0 };
    }, { states, timeoutMs });
}

const writes = (page: Page) => page.evaluate(() => window.__m0!.outbox!.autosave()?.history.length ?? 0);
const recordSeq = (page: Page) => page.evaluate(async () => (await window.__m0!.outbox!.inspect()).record?.localSeq ?? null);

for (const release of ['close', 'crash', 'navigate'] as const) {
    test(`V14 标签页协调：持有者${release === 'close' ? '关闭' : release === 'crash' ? '崩溃' : '导航离开'}后接手`, async ({ context, request }, testInfo) => {
        test.skip(release === 'crash' && testInfo.project.name === 'webkit', 'WebKit 没有 CDP 的页面崩溃；关闭与导航离开两种方式覆盖锁的释放');
        test.setTimeout(120_000);
        const id = `p6-locks-${release}-${testInfo.project.name}`;
        await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
        const a = await context.newPage();
        await openWithOutbox(a, SERVERS.full, { kind: 'sheet', doc: id });
        const b = await context.newPage();
        await openWithOutbox(b, SERVERS.full, { kind: 'sheet', doc: id });
        const initial = { a: await outboxInfo(a), b: await outboxInfo(b) };
        // B 拿不到锁：修改不写发件箱
        await edit(b, 'sheet', 'P6B1');
        await b.waitForTimeout(1500);
        const bWritesWhileBusy = await writes(b);
        // A 修改并写入本机，然后释放锁
        await edit(a, 'sheet', 'P6A1');
        await waitSavedLocal(a);
        if (release === 'close') await a.close();
        else if (release === 'navigate') await a.goto('about:blank');
        else {
            const cdp = await context.newCDPSession(a);
            void cdp.send('Page.crash').catch(() => undefined);
        }
        const takeover = await waitState(b, ['recovery-pending', 'editing']);
        const after = await outboxInfo(b);
        await writeResult(`v14/locks/${testInfo.project.name}-${release}.json`, {
            check: 'V14-locks', release, browser: browserInfo(b, testInfo), timestamp: new Date().toISOString(), initial, bWritesWhileBusy, takeover, after,
        });
        expect(initial.a.state, 'A 持有锁').toBe('editing');
        expect(initial.b.state, 'B 拿不到锁').toBe('busy');
        expect(bWritesWhileBusy, '拿不到锁时不写发件箱').toBe(0);
        expect(takeover.state, 'A 释放后 B 接手，并发现 A 未同步的记录').toBe('recovery-pending');
        expect(after.recovery?.status).toBe('restorable');
        expect(takeover.ms, '接手的等待').toBeLessThan(5000);
    });
}

for (const placement of ['main', 'worker'] as const) {
    test(`V14 标签页协调：锁被抢走后停止写入（${placement}）`, async ({ context, request }, testInfo) => {
        test.setTimeout(120_000);
        const id = `p6-steal-${placement}-${testInfo.project.name}`;
        await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
        const a = await context.newPage();
        await openWithOutbox(a, SERVERS.full, { kind: 'sheet', doc: id, outbox: placement });
        await edit(a, 'sheet', 'P6S0');
        await waitSavedLocal(a);
        const seqBefore = await recordSeq(a);
        // B 先打开（等锁）；A 再改一处，还在防抖（未保存）时，B 立即抢锁（生产上对应"在这里继续编辑"）
        const b = await context.newPage();
        await openWithOutbox(b, SERVERS.full, { kind: 'sheet', doc: id, outbox: placement });
        await edit(a, 'sheet', 'P6S1');
        await b.evaluate(() => window.__m0!.outbox!.steal());
        const lost = await waitState(a, ['lost']);
        const bState = await outboxInfo(b);
        // 等过 A 的防抖与 3 秒上限：A 不应再写入
        await a.waitForTimeout(3500);
        const seqAfter = await recordSeq(b);
        const aAutosave = await a.evaluate(() => window.__m0!.outbox!.autosave()?.status() ?? null);
        const captureError = await a.evaluate(() => window.__m0!.outbox!.capture().then(() => null, (e: Error) => e.message));
        // 绕过锁状态检查直接写：由存储层的栅栏拒绝
        const fenced = await a.evaluate(async () => (await window.__m0!.outbox!.capture({ force: true, bypassLockCheck: true })).error);
        const seqFinal = await recordSeq(b);
        const generations = { a: await a.evaluate(() => window.__m0!.outbox!.generation()), b: await b.evaluate(() => window.__m0!.outbox!.generation()) };
        await writeResult(`v14/locks/${testInfo.project.name}-steal-${placement}.json`, {
            check: 'V14-locks-steal', placement, browser: browserInfo(a, testInfo), timestamp: new Date().toISOString(),
            seqBefore, lost, bState: bState.state, bRecovery: bState.recovery?.status ?? null, seqAfter, aAutosave, captureError, fenced, seqFinal, generations,
        });
        expect(lost.state, 'A 收到锁被抢走').toBe('lost');
        expect(bState.recovery?.record?.localSeq, 'B 接手时看到的是 A 最后写入的记录').toBe(seqBefore);
        expect(seqAfter, '被抢锁之后 A 没有再写入').toBe(seqBefore);
        expect(aAutosave, 'A 的自动保存已停止，不显示"已保存在本机"').toBe('stopped');
        expect(captureError, '手动写入被拒绝').not.toBeNull();
        expect(fenced, '绕过锁检查的写入被栅栏拒绝').toBe('FenceError');
        expect(seqFinal, '记录没有被 A 覆盖').toBe(seqBefore);
        expect(generations.b, 'B 登记为新的持有者').toBeGreaterThan(generations.a ?? 0);
    });
}

test('V14 标签页协调：等锁与待恢复时只读，接手时对齐服务端', async ({ context, request }, testInfo) => {
    test.setTimeout(120_000);
    const id = `p6-readonly-${testInfo.project.name}`;
    await storeFixture(request, SERVERS.full, 'doc', 'doc-text', id);
    const a = await context.newPage();
    await openWithOutbox(a, SERVERS.full, { kind: 'doc', doc: id });
    const b = await context.newPage();
    await openWithOutbox(b, SERVERS.full, { kind: 'doc', doc: id });
    // B 等锁（只读）：键入无效
    await focusEditor(b);
    await setSelection(b, 2);
    await b.keyboard.type('P6BUSY', { delay: 20 });
    await b.waitForTimeout(300);
    const typedWhileBusy = await contains(b, 'P6BUSY');
    // 等待期间服务端有了新的保存（例如别的设备），A 没有未同步的修改
    await request.put(`${SERVERS.full}/api/docs/${id}`, {
        data: await (async () => {
            const res = await request.get(`${SERVERS.full}/api/docs/${id}`);
            const data = (await res.json()) as { body: { dataStream: string } };
            data.body.dataStream = `P6SERVER${data.body.dataStream}`;
            return data;
        })(),
    });
    await a.close();
    const takeover = await waitState(b, ['editing', 'recovery-pending']);
    const reloads = await b.evaluate(() => window.__m0!.outbox!.reloads());
    const hasServer = await contains(b, 'P6SERVER');
    // 接手后可以编辑，并写入发件箱
    await focusEditor(b);
    await setSelection(b, 2);
    await b.keyboard.type('P6EDIT', { delay: 20 });
    const saved = await waitSavedLocal(b);
    const typedAfter = await contains(b, 'P6EDIT');
    await writeResult(`v14/locks/${testInfo.project.name}-readonly.json`, {
        check: 'V14-locks-readonly', browser: browserInfo(b, testInfo), timestamp: new Date().toISOString(), typedWhileBusy, takeover, reloads, hasServer, typedAfter, saved,
    });
    expect(typedWhileBusy, '等锁时只读，键入无效').toBe(false);
    expect(takeover.state).toBe('editing');
    expect(reloads, '接手时服务端更新过：先重新加载').toBe(1);
    expect(hasServer, '重新加载后是服务端的新内容').toBe(true);
    expect(typedAfter, '接手后可以编辑').toBe(true);
    expect(saved).toBe('saved-local');
});

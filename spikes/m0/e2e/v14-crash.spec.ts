// V14-6 进程被杀之后的恢复（P6，00 号计划书 §7.5、§7.8）：持久化的浏览器上下文，每次一个独立的用户目录。
// - 正常路径：写入本机后再改几处、不等保存，杀掉这个浏览器（SIGKILL：进程树，WebKit 另加它的 XPC 服务），重启后恢复到最后一次写入本机的内容；
// - 持续编辑时被杀：丢失窗口；
// - 写入过程中被杀（压缩、加密阶段）与提交附近被杀：重启后的记录要么是旧的、要么是新的，都能解密、解压、解析；
// - 两次捕获并发：序号不重复（P6 审查 G2）；
// - 公式没收齐时按 3 秒上限捕获：记录带"公式待更新"，恢复时强制重算（P6 审查 R3）；
// - 修订号已变（真冲突）、密钥被吊销、元数据被改动：不自动恢复。
import type { APIRequestContext, Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { ensureGenerated, waitQuiet } from './p3-helpers';
import { contains, edit, killProfile, launchPersistent, openWithOutbox, outboxInfo, removeProfile, storeFixture, waitSavedLocal } from './p6-helpers';

const KINDS = [
    { kind: 'sheet' as const, sample: 'sheet-core' },
    { kind: 'doc' as const, sample: 'doc-text' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const s of KINDS) {
    test(`V14 进程被杀之后恢复：${s.kind}`, async ({ playwright, browserName, request }, testInfo) => {
        test.setTimeout(180_000);
        const browserType = playwright[browserName];
        const id = `p6-crash-${s.kind}-${testInfo.project.name}`;
        const revision = await storeFixture(request, SERVERS.full, s.kind, s.sample, id);
        let { context, dir, launchedAt } = await launchPersistent(browserType, testInfo);
        try {
            let page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind: s.kind, doc: id });
            const opened = await outboxInfo(page);
            await edit(page, s.kind, 'P6M1');
            const saved = await waitSavedLocal(page);
            const e2e = await page.evaluate(() => window.__m0!.outbox!.autosave()!.history.map((h) => Math.round(h.e2eMs)));
            await edit(page, s.kind, 'P6M2');
            const killedAfterMs = 50;
            await sleep(killedAfterMs);
            const kill = killProfile(dir, { browserName, launchedAt });
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context, launchedAt } = await launchPersistent(browserType, testInfo, dir));
            page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind: s.kind, doc: id });
            const reopened = await outboxInfo(page);
            const timings = await page.evaluate(async () => (await window.__m0!.outbox!.inspect()).timings);
            await page.evaluate(() => window.__m0!.outbox!.restore());
            const restored = { m1: await contains(page, 'P6M1'), m2: await contains(page, 'P6M2'), state: (await outboxInfo(page)).state };
            await edit(page, s.kind, 'P6M3');
            const afterRestore = await waitSavedLocal(page);
            const seqAfter = (await page.evaluate(async () => (await window.__m0!.outbox!.inspect()).record?.localSeq)) ?? null;
            await writeResult(`v14/crash/${testInfo.project.name}-${s.kind}.json`, {
                check: 'V14-crash', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(),
                revision, opened, saved, e2e, killedAfterMs, killed: kill.killed.length, killedProcesses: kill.killed.map((k) => k.name), killNote: kill.note, reopened, timings, restored, afterRestore, seqAfter,
            });
            expect(opened.state).toBe('editing');
            expect(saved).toBe('saved-local');
            expect(kill.killed.length, '杀掉了浏览器进程').toBeGreaterThan(0);
            expect(reopened.state, '重启后提示恢复').toBe('recovery-pending');
            expect(reopened.recovery?.status).toBe('restorable');
            expect(restored.m1, '恢复出最后一次写入本机的内容').toBe(true);
            expect(restored.m2, '没来得及保存的修改丢失').toBe(false);
            expect(restored.state).toBe('editing');
            expect(afterRestore).toBe('saved-local');
            expect(seqAfter!, '恢复之后继续编号').toBeGreaterThan(reopened.recovery?.record?.localSeq ?? 0);
        } finally {
            await context.close().catch(() => undefined);
            removeProfile(dir);
        }
    });
}

test('V14 持续编辑时被杀：丢失窗口', async ({ playwright, browserName, request }, testInfo) => {
    test.setTimeout(300_000);
    const browserType = playwright[browserName];
    // 每 200 ms 改一处，持续不同的时长后立即杀进程。丢失窗口 = 第一处丢失的修改到杀进程（没有丢失就是 0，P6 审查 S1）；
    // 上限约为 3 秒（持续编辑时的捕获上限）加 50 ms 的轮询与两次管道
    const runs: Record<string, unknown>[] = [];
    for (const count of [16, 23, 30]) {
        const id = `p6-window-${count}-${testInfo.project.name}`;
        await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
        let { context, dir, launchedAt } = await launchPersistent(browserType, testInfo);
        try {
            let page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id });
            const marks: { mark: string; t: number }[] = [];
            for (let i = 0; i < count; i++) {
                const mark = `P6E${String(i).padStart(2, '0')}`;
                await edit(page, 'sheet', mark);
                marks.push({ mark, t: Date.now() });
                await sleep(200);
            }
            const history = await page.evaluate(() => window.__m0!.outbox!.autosave()!.history.map((h) => ({ trigger: h.trigger, e2eMs: Math.round(h.e2eMs) })));
            const killedAt = Date.now();
            const kill = killProfile(dir, { browserName, launchedAt });
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context, launchedAt } = await launchPersistent(browserType, testInfo, dir));
            page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id });
            await page.evaluate(() => window.__m0!.outbox!.restore());
            const present: boolean[] = [];
            for (const m of marks) present.push(await contains(page, m.mark));
            const lastIndex = present.lastIndexOf(true);
            const firstLost = present.indexOf(false);
            runs.push({
                edits: count,
                editingMs: marks[marks.length - 1].t - marks[0].t,
                recovered: lastIndex + 1,
                lost: firstLost < 0 ? 0 : count - firstLost,
                lossMs: firstLost < 0 ? 0 : killedAt - marks[firstLost].t,
                lastRecoveredToKillMs: lastIndex < 0 ? null : killedAt - marks[lastIndex].t,
                contiguous: present.slice(0, lastIndex + 1).every(Boolean),
                killNote: kill.note,
                history,
            });
        } finally {
            await context.close().catch(() => undefined);
            removeProfile(dir);
        }
    }
    await writeResult(`v14/window/${testInfo.project.name}.json`, {
        check: 'V14-window', browser: { project: testInfo.project.name }, timestamp: new Date().toISOString(), intervalMs: 200, runs,
    });
    for (const r of runs) {
        expect.soft(r.contiguous, `${r.edits} 处修改：恢复出的修改是连续的前缀`).toBe(true);
        expect.soft(r.lossMs as number, `${r.edits} 处修改：丢失窗口不超过约 3 秒加轮询与两次管道`).toBeLessThanOrEqual(3500);
    }
});

/** 5 MiB 表格的副本：写入过程中被杀的两个用例共用。 */
async function bigSheet(page: Page, request: APIRequestContext, id: string): Promise<void> {
    const source = await ensureGenerated(page, request, 'sheet', 'big-5m');
    const big = await request.get(`${SERVERS.off}/api/docs/${source}`);
    await request.put(`${SERVERS.off}/api/docs/${id}`, { data: await big.json() });
}

test('V14 写入过程中被杀（压缩、加密阶段）：记录要么旧要么新', async ({ playwright, browserName, page, request }, testInfo) => {
    test.setTimeout(420_000);
    const browserType = playwright[browserName];
    // 5 MiB 表格：同步段之后的 gzip 约 90 ms，这里的杀点大多落在压缩、加密阶段；提交附近见下一个用例
    const id = `p6-midwrite-${testInfo.project.name}`;
    await bigSheet(page, request, id);
    const delays = [0, 40, 80, 120, 160, 200, 260];
    const out: Record<string, unknown>[] = [];
    let { context, dir, launchedAt } = await launchPersistent(browserType, testInfo);
    try {
        for (const delay of delays) {
            let p = await context.newPage();
            await openWithOutbox(p, SERVERS.off, { kind: 'sheet', doc: id });
            const before = await outboxInfo(p);
            if (before.state === 'recovery-pending') await p.evaluate(() => window.__m0!.outbox!.discard());
            const first = await p.evaluate(async () => (await window.__m0!.outbox!.capture({ force: true })).localSeq);
            await p.evaluate(() => {
                void window.__m0!.outbox!.capture({ force: true });
            });
            await sleep(delay);
            killProfile(dir, { browserName, launchedAt });
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context, launchedAt } = await launchPersistent(browserType, testInfo, dir));
            p = await context.newPage();
            await openWithOutbox(p, SERVERS.off, { kind: 'sheet', doc: id });
            const after = await outboxInfo(p);
            out.push({ delay, first, status: after.recovery?.status ?? null, seq: after.recovery?.record?.localSeq ?? null, error: after.recovery?.error ?? null });
            await p.close();
        }
        await writeResult(`v14/midwrite/${testInfo.project.name}.json`, {
            check: 'V14-midwrite', browser: { project: testInfo.project.name }, timestamp: new Date().toISOString(), runs: out,
        });
        for (const r of out) {
            expect.soft(r.status, `延迟 ${r.delay} ms：记录能解密（旧或新）`).toBe('restorable');
            expect.soft([r.first, (r.first as number) + 1], `延迟 ${r.delay} ms：序号是旧的或新的`).toContain(r.seq);
        }
    } finally {
        await context.close().catch(() => undefined);
        removeProfile(dir);
    }
});

test('V14 提交附近被杀：记录要么旧要么新', async ({ playwright, browserName, page, request }, testInfo) => {
    test.setTimeout(420_000);
    const browserType = playwright[browserName];
    // 主线程放置：写入 IndexedDB 之前页面打出 P6-PUT，测试端收到就立即杀进程（P6 审查 G5），杀点落在事务提交附近
    const id = `p6-atput-${testInfo.project.name}`;
    await bigSheet(page, request, id);
    const out: Record<string, unknown>[] = [];
    let { context, dir, launchedAt } = await launchPersistent(browserType, testInfo);
    try {
        for (let i = 0; i < 8; i++) {
            let p = await context.newPage();
            await openWithOutbox(p, SERVERS.off, { kind: 'sheet', doc: id, outbox: 'main' });
            const before = await outboxInfo(p);
            if (before.state === 'recovery-pending') await p.evaluate(() => window.__m0!.outbox!.discard());
            const first = await p.evaluate(async () => (await window.__m0!.outbox!.capture({ force: true })).localSeq);
            const putSeen = new Promise<number>((resolve) => {
                p.on('console', (m) => {
                    if (m.text() === 'P6-PUT') resolve(Date.now());
                });
            });
            await p.evaluate(() => {
                (globalThis as { __p6OnPut?: () => void }).__p6OnPut = () => console.log('P6-PUT');
                void window.__m0!.outbox!.capture({ force: true });
            });
            await putSeen;
            const kill = killProfile(dir, { browserName, launchedAt });
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context, launchedAt } = await launchPersistent(browserType, testInfo, dir));
            p = await context.newPage();
            await openWithOutbox(p, SERVERS.off, { kind: 'sheet', doc: id, outbox: 'main' });
            const after = await outboxInfo(p);
            out.push({ run: i, first, status: after.recovery?.status ?? null, seq: after.recovery?.record?.localSeq ?? null, error: after.recovery?.error ?? null, killNote: kill.note });
            await p.close();
        }
        await writeResult(`v14/atput/${testInfo.project.name}.json`, {
            check: 'V14-atput', browser: { project: testInfo.project.name }, timestamp: new Date().toISOString(), runs: out,
        });
        for (const r of out) {
            expect.soft(r.status, `第 ${r.run} 次：记录能解密（旧或新）`).toBe('restorable');
            expect.soft([r.first, (r.first as number) + 1], `第 ${r.run} 次：序号是旧的或新的`).toContain(r.seq);
        }
    } finally {
        await context.close().catch(() => undefined);
        removeProfile(dir);
    }
});

test('V14 两次捕获并发：序号不重复', async ({ page, request }, testInfo) => {
    const id = `p6-concurrent-${testInfo.project.name}`;
    await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
    const user = `p6c-${testInfo.project.name}-${Date.now()}`;
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user, outbox: 'worker' });
    const r = await page.evaluate(async () => {
        const o = window.__m0!.outbox!;
        const ws = window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getActiveSheet();
        // 第一次捕获还在途时改内容、再捕获：两次同时在途
        const a = o.capture({ force: true });
        ws.getRange('A20').setValue('P6-LATER');
        const b = o.capture({ force: true });
        const [ra, rb] = await Promise.all([a, b]);
        return { seqs: [ra.localSeq, rb.localSeq], errors: [ra.error, rb.error], final: (await o.inspect()).record?.localSeq ?? null };
    });
    await page.goto('about:blank');
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user, outbox: 'worker' });
    await page.evaluate(() => window.__m0!.outbox!.restore());
    const later = await contains(page, 'P6-LATER');
    await writeResult(`v14/concurrent/${testInfo.project.name}.json`, { check: 'V14-concurrent', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), ...r, later });
    expect(r.errors).toEqual([null, null]);
    expect(r.seqs[1], '后捕获的序号更大').toBeGreaterThan(r.seqs[0]);
    expect(r.final, '留下的是后捕获的记录').toBe(r.seqs[1]);
    expect(later, '恢复出的是后捕获的内容').toBe(true);
});

/** 按公式定义，从快照中的输入独立推算 formula-scenarios 的聚合与慢计算结果（与 V07 的核对相同），返回不一致的单元格数。 */
function checkSlowSheet(text: string): { checked: number; mismatches: number } {
    type Cells = Record<string, Record<string, { v?: unknown }>>;
    const snap = JSON.parse(text) as { sheets: Record<string, { name: string; cellData: Cells }> };
    const sheet = (name: string) => Object.values(snap.sheets).find((s) => s.name === name)!.cellData;
    const agg = sheet('聚合');
    const slow = sheet('慢');
    const b: number[] = [];
    for (let i = 0; i < 20_000; i++) b.push(Number(agg[i]?.[1]?.v ?? 0));
    let mismatches = 0;
    let checked = 0;
    const eq = (expected: number, actual: unknown) => {
        checked += 1;
        if (Math.abs(Number(actual) - expected) > 1e-6 * Math.max(1, Math.abs(expected))) mismatches += 1;
    };
    eq(b.reduce((s, x) => s + x, 0), agg[0]?.[2]?.v);
    for (let i = 0; i < 200; i++) eq(b.filter((x) => x > i * 5).reduce((s, x) => s + x, 0), slow[i]?.[0]?.v);
    return { checked, mismatches };
}

test('V14 公式没收齐时按上限捕获：恢复时强制重算', async ({ page, request }, testInfo) => {
    test.setTimeout(420_000);
    // 审查 R3：公式 Worker 模式下，持续修改牵动慢计算的单元格（V07 的 formula-scenarios：聚合!B1 → 慢 表 200 个 SUMPRODUCT，
    // 每轮约 2 秒），3 秒上限到了公式还没收齐。出现第一次"公式没收齐"的捕获后立即离开页面，重开恢复：
    // 记录带"公式待更新"，恢复时强制全量重算，收齐后补捕获；恢复出的公式结果与输入一致（独立核对 201 个公式）
    const source = await ensureGenerated(page, request, 'sheet', 'formula-scenarios');
    const id = `p6-formula-cap-${testInfo.project.name}`;
    const res = await request.get(`${SERVERS.off}/api/docs/${source}`);
    await request.put(`${SERVERS.off}/api/docs/${id}`, { data: await res.json() });
    const user = `p6f-${testInfo.project.name}-${Date.now()}`;
    await openWithOutbox(page, SERVERS.off, { kind: 'sheet', doc: id, user, extra: 'worker=1' });
    await waitQuiet(page, 1000, 60_000);
    let pendingCapture = false;
    for (let i = 0; i < 60 && !pendingCapture; i++) {
        await page.evaluate((v) => window.__m0!.editor!.univerAPI.getActiveWorkbook()!.getSheetByName('聚合')!.getRange('B1').setValue(v), 500 + i);
        await sleep(150);
        pendingCapture = await page.evaluate(() => window.__m0!.outbox!.autosave()!.history.some((h) => h.formulaPending));
    }
    const history = await page.evaluate(() => window.__m0!.outbox!.autosave()!.history.map((h) => ({ trigger: h.trigger, formulaPending: h.formulaPending })));
    await page.goto('about:blank');
    await openWithOutbox(page, SERVERS.off, { kind: 'sheet', doc: id, user, extra: 'worker=1' });
    const reopened = await outboxInfo(page);
    const recordPending = await page.evaluate(async () => (await window.__m0!.outbox!.inspect()).record?.formulaPending ?? null);
    const t0 = Date.now();
    await page.evaluate(() => window.__m0!.outbox!.restore());
    const restoreMs = Date.now() - t0;
    const idle = await page.evaluate(() => window.__m0!.outbox!.autosave()!.idle(60_000));
    const slowCheck = checkSlowSheet(await page.evaluate(() => JSON.stringify(window.__m0!.editor!.save())));
    const after = await page.evaluate(async () => (await window.__m0!.outbox!.inspect()).record);
    await writeResult(`v14/formula-cap/${testInfo.project.name}.json`, {
        check: 'V14-formula-cap', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(),
        pendingCapture, history, reopened: reopened.recovery?.status, recordPending, restoreMs, idle, slowCheck, after: after == null ? null : { localSeq: after.localSeq, formulaPending: after.formulaPending },
    });
    expect(pendingCapture, '持续修改慢计算的输入：出现公式没收齐的捕获').toBe(true);
    expect(reopened.recovery?.status).toBe('restorable');
    expect(recordPending, '记录带"公式待更新"').toBe(true);
    expect(slowCheck.mismatches, `恢复后的公式结果与输入一致（核对 ${slowCheck.checked} 个）`).toBe(0);
    expect(after?.formulaPending, '收齐之后补捕获，记录不再带标记').toBe(false);
});

test('V14 修订号已变、密钥吊销与元数据被改动：不自动恢复', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const user = `p6-${testInfo.project.name}-${Date.now()}`;
    // 1. 修订号已变：本机有未同步的修改时，别人保存了一次
    const id = `p6-conflict-${testInfo.project.name}`;
    await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user });
    await edit(page, 'sheet', 'P6C1');
    await waitSavedLocal(page);
    await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user });
    const conflict = await outboxInfo(page);
    const restoreError = await page.evaluate(() => window.__m0!.outbox!.restore().then(() => null, (e: Error) => e.message));
    // 2. 把记录明文里的基准修订号改成服务端当前的修订号，想把真冲突伪装成可以一键恢复（P6 审查 G1）
    await page.evaluate(({ user, id }) => new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('nerve-outbox', 2);
        req.onsuccess = () => {
            const tx = req.result.transaction('records', 'readwrite');
            const store = tx.objectStore('records');
            const get = store.get([user, id]);
            get.onsuccess = () => {
                store.put({ ...get.result, baseRevision: get.result.baseRevision + 1 });
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        };
    }), { user, id });
    await page.goto('about:blank');
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user });
    const tampered = await outboxInfo(page);
    // 3. 密钥吊销：本机的记录随即作废
    const id2 = `p6-revoke-${testInfo.project.name}`;
    await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id2);
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id2, user });
    await edit(page, 'sheet', 'P6R1');
    await waitSavedLocal(page);
    await request.post(`${SERVERS.full}/api/keys/${user}/revoke`);
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id2, user });
    const revoked = await outboxInfo(page);
    await writeResult(`v14/conflict/${testInfo.project.name}.json`, {
        check: 'V14-conflict', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), conflict, restoreError, tampered, revoked,
    });
    expect(conflict.state).toBe('recovery-pending');
    expect(conflict.recovery?.status, '修订号已变：真冲突').toBe('conflict');
    expect(restoreError, '真冲突不能一键恢复').not.toBeNull();
    expect(tampered.recovery?.status, '改动了明文元数据：解密失败').toBe('undecryptable');
    expect(revoked.recovery?.status, '密钥吊销后：按密钥版本判为已吊销').toBe('revoked');
});

test('V14 不同用户互不可见', async ({ page, request }, testInfo) => {
    const id = `p6-users-${testInfo.project.name}`;
    await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
    const a = `p6a-${Date.now()}`;
    const b = `p6b-${Date.now()}`;
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user: a });
    await edit(page, 'sheet', 'P6U1');
    await waitSavedLocal(page);
    await page.goto('about:blank');
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user: b });
    const other = await outboxInfo(page);
    await page.goto('about:blank');
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id, user: a });
    const same = await outboxInfo(page);
    await writeResult(`v14/users/${testInfo.project.name}.json`, { check: 'V14-users', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), other, same });
    expect(other.recovery?.status, '另一个用户看不到这条记录').toBe('none');
    expect(same.recovery?.status).toBe('restorable');
});

// V14-6 进程被杀之后的恢复（P6，00 号计划书 §7.5、§7.8）：持久化的浏览器上下文，每次一个独立的用户目录。
// - 正常路径：写入本机后再改几处、不等保存，杀掉浏览器的全部进程（SIGKILL），重启后恢复到最后一次写入本机的内容；
// - 持续编辑时被杀：丢失窗口（最后一次修改到恢复出的最后一处修改）；
// - 写入中被杀：重启后的记录要么是旧的、要么是新的，都能解密、解压、解析；
// - 修订号已变（真冲突）、密钥被吊销：不自动恢复。
import { expect, test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { ensureGenerated } from './p3-helpers';
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
        let { context, dir } = await launchPersistent(browserType, testInfo);
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
            const killed = killProfile(dir);
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context } = await launchPersistent(browserType, testInfo, dir));
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
                revision, opened, saved, e2e, killedAfterMs, killed, reopened, timings, restored, afterRestore, seqAfter,
            });
            expect(opened.state).toBe('editing');
            expect(saved).toBe('saved-local');
            expect(killed, '杀掉了浏览器进程').toBeGreaterThan(0);
            expect(reopened.state, '重启后提示恢复').toBe('recovery-pending');
            expect(reopened.recovery?.status).toBe('restorable');
            expect(restored.m1, '恢复出最后一次写入本机的内容').toBe(true);
            expect(restored.m2, '没来得及保存的修改丢失').toBe(false);
            expect(restored.state).toBe('editing');
            expect(afterRestore).toBe('saved-local');
            expect(seqAfter, '恢复之后继续编号').toBe((reopened.recovery?.record?.localSeq ?? 0) + 1);
        } finally {
            await context.close().catch(() => undefined);
            removeProfile(dir);
        }
    });
}

test('V14 持续编辑时被杀：丢失窗口', async ({ playwright, browserName, request }, testInfo) => {
    test.setTimeout(300_000);
    const browserType = playwright[browserName];
    // 每 200 ms 改一处，持续不同的时长后立即杀进程：持续编辑时最长每 3 秒捕获一次，丢失窗口应在 0 到约 3 秒之间变化
    const runs: Record<string, unknown>[] = [];
    for (const count of [16, 23, 30]) {
        const id = `p6-window-${count}-${testInfo.project.name}`;
        await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id);
        let { context, dir } = await launchPersistent(browserType, testInfo);
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
            killProfile(dir);
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context } = await launchPersistent(browserType, testInfo, dir));
            page = await context.newPage();
            await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id });
            await page.evaluate(() => window.__m0!.outbox!.restore());
            const present: boolean[] = [];
            for (const m of marks) present.push(await contains(page, m.mark));
            const lastIndex = present.lastIndexOf(true);
            runs.push({
                edits: count,
                editingMs: marks[marks.length - 1].t - marks[0].t,
                recovered: lastIndex + 1,
                lossMs: lastIndex < 0 ? null : killedAt - marks[lastIndex].t,
                contiguous: present.slice(0, lastIndex + 1).every(Boolean),
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
        expect.soft(r.lossMs, `${r.edits} 处修改：有恢复出的修改`).not.toBeNull();
        expect.soft(r.lossMs as number, `${r.edits} 处修改：丢失窗口不超过约 3 秒加一次写入`).toBeLessThanOrEqual(3600);
    }
});

test('V14 写入中被杀：记录要么旧要么新', async ({ playwright, browserName, page, request }, testInfo) => {
    test.setTimeout(420_000);
    const browserType = playwright[browserName];
    // 5 MiB 表格：一次写入约 0.2–0.3 秒，在这段时间里的不同时刻杀进程
    const source = await ensureGenerated(page, request, 'sheet', 'big-5m');
    const id = `p6-midwrite-${testInfo.project.name}`;
    const big = await request.get(`${SERVERS.off}/api/docs/${source}`);
    await request.put(`${SERVERS.off}/api/docs/${id}`, { data: await big.json() });
    const delays = [0, 40, 80, 120, 160, 200, 260];
    const out: Record<string, unknown>[] = [];
    let { context, dir } = await launchPersistent(browserType, testInfo);
    try {
        for (const delay of delays) {
            let p = await context.newPage();
            await openWithOutbox(p, SERVERS.off, { kind: 'sheet', doc: id });
            const before = await outboxInfo(p);
            if (before.state === 'recovery-pending') await p.evaluate(() => window.__m0!.outbox!.discard());
            // 先完整写入一次（旧记录），再在第二次写入的过程中杀进程
            const first = await p.evaluate(async () => (await window.__m0!.outbox!.capture({ force: true })).localSeq);
            await p.evaluate(() => {
                void window.__m0!.outbox!.capture({ force: true });
            });
            await sleep(delay);
            killProfile(dir);
            await context.close().catch(() => undefined);
            await sleep(500);
            ({ context } = await launchPersistent(browserType, testInfo, dir));
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

test('V14 修订号已变与密钥吊销：不自动恢复', async ({ page, request }, testInfo) => {
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
    // 2. 密钥吊销：本机的记录随即作废
    const id2 = `p6-revoke-${testInfo.project.name}`;
    await storeFixture(request, SERVERS.full, 'sheet', 'sheet-core', id2);
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id2, user });
    await edit(page, 'sheet', 'P6R1');
    await waitSavedLocal(page);
    await request.post(`${SERVERS.full}/api/keys/${user}/revoke`);
    await openWithOutbox(page, SERVERS.full, { kind: 'sheet', doc: id2, user });
    const revoked = await outboxInfo(page);
    await writeResult(`v14/conflict/${testInfo.project.name}.json`, {
        check: 'V14-conflict', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), conflict, restoreError, revoked,
    });
    expect(conflict.state).toBe('recovery-pending');
    expect(conflict.recovery?.status, '修订号已变：真冲突').toBe('conflict');
    expect(restoreError, '真冲突不能一键恢复').not.toBeNull();
    expect(revoked.recovery?.status, '密钥吊销后记录无法解密').toBe('undecryptable');
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
    void waitForEditor;
});

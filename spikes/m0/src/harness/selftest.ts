// 真实 Safari 自检：Playwright 无法驱动真实 Safari，由页面自己用 Facade 执行编辑、核对快照，
// 再把结果 POST 回验证服务（scripts/safari-selftest.ts 汇总）。编辑走命令而不是键盘，
// 目的只是在真实 Safari 中跑通 SDK 代码路径并观察 CSP 违规；键盘与输入法由 Playwright WebKit 和 P5 覆盖。
import type { EditorHandle } from './create-editor';
import type { PageEvents } from './events';
import type { WorkerStats } from './worker-stats';

interface Check {
    name: string;
    expected: unknown;
    actual: unknown;
    pass: boolean;
}

const check = (name: string, expected: unknown, actual: unknown): Check => ({
    name,
    expected,
    actual,
    pass: JSON.stringify(expected) === JSON.stringify(actual),
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
}

async function runSheet(editor: EditorHandle): Promise<Check[]> {
    const ws = editor.univerAPI.getActiveWorkbook()!.getActiveSheet();
    ws.getRange('B2').setValue('hello 你好');
    ws.getRange('B3').setValue('=SUM(1,2)');
    ws.getRange('B2').setFontWeight('bold');
    await waitFor(() => ws.getRange('B3').getValue() === 3, 15_000);
    const snap = editor.save() as any;
    const sheet = snap.sheets[snap.sheetOrder[0]];
    const b2 = sheet.cellData?.[1]?.[1];
    const b3 = sheet.cellData?.[2]?.[1];
    const style = typeof b2?.s === 'string' ? snap.styles?.[b2.s] : b2?.s;
    return [
        check('B2 值', 'hello 你好', b2?.v),
        check('B2 加粗', 1, style?.bl ?? 0),
        check('B3 公式', '=SUM(1,2)', b3?.f),
        check('B3 计算结果', 3, b3?.v),
    ];
}

async function runDoc(editor: EditorHandle): Promise<Check[]> {
    const doc = editor.univerAPI.getActiveDocument()!;
    doc.insertText(0, '追加ABC ');
    const contentLength = doc.getBody().dataStream.replace(/\r\n$/, '').length;
    doc.getTextRange(0, contentLength).setTextStyle({ bl: 1 });
    await new Promise((r) => setTimeout(r, 500));
    const snap = editor.save() as any;
    const text: string = snap.body?.dataStream ?? '';
    const runs: any[] = snap.body?.textRuns ?? [];
    const boldCovered = runs.filter((t) => t.ts?.bl === 1).reduce((n, t) => n + (t.ed - t.st), 0);
    return [
        check('正文包含插入的文字', true, text.includes('追加ABC')),
        check('原有内容保留', true, text.includes('M0 文字文档样本')),
        check('全文加粗', text.replace(/\r\n$/, '').length, boldCovered),
    ];
}

export async function runSelftest(
    editor: EditorHandle,
    scenario: string,
    context: { events: PageEvents; workerStats: WorkerStats },
): Promise<void> {
    let checks: Check[] = [];
    let error: string | undefined;
    try {
        checks = editor.kind === 'sheet' ? await runSheet(editor) : await runDoc(editor);
    } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    // 给 report-uri 的异步上报留出时间
    await new Promise((r) => setTimeout(r, 1500));
    await fetch('/__selftest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            kind: 'editor',
            scenario,
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString(),
            checks,
            error,
            timings: editor.timings,
            events: context.events,
            workerStats: context.workerStats,
        }),
    });
}

// P5 文字文档样本构建器（确定性）：
// - doc-20k-full：00 号计划书 §12.1 的文字样本，约 2 万汉字，含一级二级标题、有序无序列表、加粗（P3 的 doc-20k 正文），
//   另加 8 个 3×4 的表格（单元格里有文字）与 10 张图片（5 张内联、5 张四周环绕）。
//   图片用静态样本地址（/fixtures-assets/），加载时不经过平台图片服务；性能测量不依赖图片的来源。
import type { FDocument } from '@univerjs/docs/facade';
import type { EditorHandle, SampleBuilder } from '../../harness/create-editor';

import { ImageSourceType } from '@univerjs/core';
import { TextWrappingStyle } from '@univerjs/docs-drawing';
import { CreateDocTableCommand } from '@univerjs/docs-ui';
import { body as generatedBody } from '../p3-samples/doc-builders';
import { hanziText, mulberry32 } from '../p3-samples/random';

const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));
const IMAGES = ['/fixtures-assets/blue-120x80.png', '/fixtures-assets/orange-64x64.png'];

function activeDoc(editor: EditorHandle): FDocument {
    const doc = editor.univerAPI.getActiveDocument();
    if (doc == null) throw new Error('没有活动的文字文档');
    return doc;
}

/** 普通段落的段落符位置（不在表格里、前面有文字），用来挑选插入点。 */
function paragraphEnds(doc: FDocument): number[] {
    const b = doc.getBody();
    const inTable = (i: number) => (b.tables ?? []).some((t) => i > t.startIndex && i < t.endIndex);
    return (b.paragraphs ?? []).map((p) => p.startIndex).filter((i) => i > 0 && b.dataStream[i - 1] !== '\r' && !inTable(i));
}

/** 在某个段落末尾插入 rows × cols 的表格，并在每个单元格里写入文字。 */
async function insertTableAt(editor: EditorHandle, offset: number, rows: number, cols: number, rand: () => number): Promise<void> {
    const doc = activeDoc(editor);
    const before = new Set((doc.getBody().tables ?? []).map((t) => t.tableId));
    doc.setSelection(offset, offset);
    await settle(200);
    const ok = await editor.univerAPI.executeCommand(CreateDocTableCommand.id, { rowCount: rows, colCount: cols });
    if (!ok) throw new Error(`插入表格失败：${offset}`);
    await settle(300);
    const b = activeDoc(editor).getBody();
    const table = (b.tables ?? []).find((t) => !before.has(t.tableId));
    if (table == null) throw new Error('找不到新插入的表格');
    const cells: number[] = [];
    for (let i = table.startIndex; i < table.endIndex; i++) if (b.dataStream[i] === '\x1C') cells.push(i + 1);
    // 从后往前写，前面的位置不受影响
    for (const at of cells.reverse()) activeDoc(editor).insertText(at, hanziText(4 + Math.floor(rand() * 8), rand));
    await settle(200);
}

export const p5DocBuilders: Record<string, SampleBuilder> = {
    'doc-20k-full': async (editor) => {
        const api = editor.univerAPI;
        const current = activeDoc(editor).save();
        api.disposeUnit(current.id);
        api.createDocument({ ...current, body: generatedBody({ chars: 20_000 }).getData().body });
        await settle(1500);
        const rand = mulberry32(5005);
        // 从后往前插入：先挑好位置（按段落末尾的序号均匀分布），再从大到小插入
        const ends = paragraphEnds(activeDoc(editor));
        const pick = (n: number, phase: number) => Array.from({ length: n }, (_, k) => ends[Math.floor(((k + phase) / (n + 1)) * ends.length)]);
        const tableAt = pick(8, 0.5);
        const imageAt = pick(10, 0.25);
        const plan = [...tableAt.map((o) => ({ o, kind: 'table' as const })), ...imageAt.map((o, k) => ({ o, kind: 'image' as const, k }))]
            .sort((a, b) => b.o - a.o);
        for (const step of plan) {
            if (step.kind === 'table') {
                await insertTableAt(editor, step.o, 3, 4, rand);
                continue;
            }
            const k = (step as { k: number }).k;
            const inserted = await activeDoc(editor).insertImage({
                source: IMAGES[k % 2],
                imageSourceType: ImageSourceType.URL,
                width: k % 2 === 0 ? 120 : 64,
                ...(k % 2 === 0 ? {} : { wrappingStyle: TextWrappingStyle.WRAP_SQUARE }),
                textRange: { startOffset: step.o, endOffset: step.o },
            } as never);
            if (inserted == null) throw new Error(`插入图片失败：${step.o}`);
            await settle(150);
        }
        await settle(1500);
    },
};

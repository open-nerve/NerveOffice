// P3 文字文档样本构建器（确定性）：
// - doc-20k：约 2 万汉字，含标题、列表、加粗（00 号计划书 §12.1 的文字样本，不含图片与表格，它们由 P5 覆盖）；
// - doc-1m：按目标字节数（1 MiB）生成，只用于捕获成本（V08）。
import type { EditorHandle, SampleBuilder } from '../../harness/create-editor';

import { NamedStyleType, ParagraphStyleBuilder, PresetListType, RichTextBuilder } from '@univerjs/core';
import { hanziText, mulberry32 } from './random';

const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

/** 生成正文，直到达到目标字数或目标字节数（字节数每 200 段核对一次正文的 JSON 体积）。P5 的 doc-20k-full 复用它。 */
export function body(target: { chars?: number; bytes?: number }): RichTextBuilder {
    const rand = mulberry32(2024);
    const builder = RichTextBuilder.create();
    let chars = 0;
    const done = (i: number): boolean => {
        if (target.chars != null) return chars >= target.chars;
        if (i === 0 || i % 200 !== 0) return false;
        return new TextEncoder().encode(JSON.stringify(builder.getData().body)).length >= (target.bytes ?? 0);
    };
    for (let i = 0; !done(i); i++) {
        if (i % 25 === 0) {
            const title = `第 ${i / 25 + 1} 部分 ${hanziText(8, rand)}`;
            builder.text(title).paragraph(ParagraphStyleBuilder.create({ namedStyleType: NamedStyleType.HEADING_1 }));
            chars += title.length;
        } else if (i % 5 === 0) {
            const heading = hanziText(12, rand);
            builder.text(heading).paragraph(ParagraphStyleBuilder.create({ namedStyleType: NamedStyleType.HEADING_2 }));
            chars += heading.length;
        } else if (i % 7 === 0) {
            for (let k = 0; k < 3; k++) {
                const item = hanziText(30, rand);
                builder.listItem(item, { type: k % 2 === 0 ? PresetListType.BULLET_LIST : PresetListType.ORDER_LIST });
                chars += item.length;
            }
        } else {
            const head = hanziText(20, rand);
            const bold = hanziText(6, rand);
            const tail = hanziText(80, rand);
            builder.text(head).bold(bold).text(tail).paragraph();
            chars += head.length + bold.length + tail.length;
        }
    }
    return builder;
}

/** 用生成的正文替换当前文档，保留文档 id 与版式设置（与 P2 的构建器相同的做法）。 */
async function replaceBody(editor: EditorHandle, builder: RichTextBuilder): Promise<void> {
    const api = editor.univerAPI;
    const current = api.getActiveDocument()!.save();
    api.disposeUnit(current.id);
    api.createDocument({ ...current, body: builder.getData().body });
    await settle(1500);
}

export const p3DocBuilders: Record<string, SampleBuilder> = {
    'doc-20k': (editor) => replaceBody(editor, body({ chars: 20_000 })),
    'doc-1m': (editor) => replaceBody(editor, body({ bytes: 1024 * 1024 * 0.95 })),
};

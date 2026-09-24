// V03 文字文档样本构建器：正文用 RichTextBuilder 生成后重新创建文档单元，
// 标题、表格、图片再通过 Facade 与编辑器命令加入；最后由 save() 输出样本（样本本身就是 SDK 的输出）。
import type { FDocument } from '@univerjs/docs/facade';
import type { EditorHandle, SampleBuilder } from '../../harness/create-editor';

import { BaselineOffset, BooleanNumber, HorizontalAlign, ImageSourceType, NamedStyleType, PresetListType, RichTextBuilder, TextDecoration } from '@univerjs/core';
import { TextWrappingStyle } from '@univerjs/docs-drawing';
import { CreateDocTableCommand } from '@univerjs/docs-ui';

const BLUE = '/fixtures-assets/blue-120x80.png';
const ORANGE = '/fixtures-assets/orange-64x64.png';

const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

function activeDoc(editor: EditorHandle): FDocument {
    const doc = editor.univerAPI.getActiveDocument();
    if (doc == null) throw new Error('没有活动的文字文档');
    return doc;
}

/** 用 RichTextBuilder 生成的正文替换当前文档：保留文档 id 与版式设置，重新创建文档单元。 */
async function replaceBody(editor: EditorHandle, builder: RichTextBuilder): Promise<FDocument> {
    const api = editor.univerAPI;
    const current = activeDoc(editor).save();
    const data = builder.getData();
    api.disposeUnit(current.id);
    api.createDocument({ ...current, body: data.body });
    await settle();
    return activeDoc(editor);
}

/** 找到正文中第一次出现某段文字的段落，设置命名样式（标题等）。 */
function setNamedStyle(doc: FDocument, text: string, namedStyleType: NamedStyleType): void {
    const paragraph = doc.findParagraphByText(text);
    if (paragraph == null) throw new Error(`找不到段落：${text}`);
    if (!paragraph.setStyle({ namedStyleType })) throw new Error(`设置样式失败：${text}`);
}

function textBody(): RichTextBuilder {
    return RichTextBuilder.create()
        .text('文档标题')
        .paragraph()
        .text('副标题：M0 文字文档样本')
        .paragraph()
        .text('一级标题')
        .paragraph()
        .text('正文段落：')
        .span('加粗', { bold: true })
        .text('、')
        .span('斜体', { italic: true })
        .text('、')
        .span('下划线', { ul: { s: BooleanNumber.TRUE, t: TextDecoration.SINGLE } })
        .text('、')
        .span('删除线', { st: { s: BooleanNumber.TRUE } })
        .text('、H')
        .span('2', { va: BaselineOffset.SUBSCRIPT })
        .text('O、x')
        .span('2', { va: BaselineOffset.SUPERSCRIPT })
        .text('、')
        .span('红色', { color: '#dc2626' })
        .text('、')
        .span('高亮', { background: '#fef08a' })
        .text('、')
        .span('大号宋体', { fontSize: 18, fontFamily: 'SimSun' })
        .text('。中英文混排 English text 与标点，检查换行。')
        .paragraph({ align: HorizontalAlign.CENTER })
        .text('居中段落')
        .paragraph({ align: HorizontalAlign.RIGHT })
        .text('右对齐段落')
        .paragraph()
        .text('二级标题')
        .paragraph()
        .text('三级标题')
        .paragraph()
        .text('四级标题')
        .paragraph()
        .text('五级标题')
        .paragraph();
}

function listBody(builder: RichTextBuilder): RichTextBuilder {
    return builder
        .listItem('无序列表第一项', { type: PresetListType.BULLET_LIST, listId: 'bullets' })
        .listItem('无序列表嵌套项', { type: PresetListType.BULLET_LIST, listId: 'bullets', level: 1 })
        .listItem('有序列表第一项', { type: PresetListType.ORDER_LIST, listId: 'ordered' })
        .listItem('有序列表第二项', { type: PresetListType.ORDER_LIST, listId: 'ordered' })
        .listItem('待办：未完成', { type: PresetListType.CHECK_LIST, listId: 'todo' })
        .listItem('待办：已完成', { type: PresetListType.CHECK_LIST_CHECKED, listId: 'todo' })
        .paragraph();
}

function linkBody(builder: RichTextBuilder): RichTextBuilder {
    return builder
        .text('链接：')
        .link('外部网页', 'https://example.com/doc')
        .text('、')
        .link('发邮件', 'mailto:someone@example.com')
        .paragraph();
}

async function applyHeadings(doc: FDocument): Promise<void> {
    setNamedStyle(doc, '文档标题', NamedStyleType.TITLE);
    setNamedStyle(doc, '副标题：M0 文字文档样本', NamedStyleType.SUBTITLE);
    setNamedStyle(doc, '一级标题', NamedStyleType.HEADING_1);
    setNamedStyle(doc, '二级标题', NamedStyleType.HEADING_2);
    setNamedStyle(doc, '三级标题', NamedStyleType.HEADING_3);
    setNamedStyle(doc, '四级标题', NamedStyleType.HEADING_4);
    setNamedStyle(doc, '五级标题', NamedStyleType.HEADING_5);
    await settle();
}

/** 在正文末尾（最后一个段落符之前）插入表格。 */
async function appendTable(editor: EditorHandle, doc: FDocument): Promise<void> {
    const end = doc.getBody().dataStream.length - 2;
    doc.setSelection(end, end);
    await settle(300);
    const ok = await editor.univerAPI.executeCommand(CreateDocTableCommand.id, { rowCount: 3, colCount: 3 });
    if (!ok) throw new Error('插入表格失败');
    await settle();
}

async function appendImages(doc: FDocument): Promise<void> {
    const end = () => doc.getBody().dataStream.length - 2;
    const inline = await doc.insertImage({ source: BLUE, imageSourceType: ImageSourceType.URL, width: 120, textRange: { startOffset: end(), endOffset: end() } } as never);
    if (inline == null) throw new Error('插入内联图片失败');
    const floating = await doc.insertImage({
        source: ORANGE,
        imageSourceType: ImageSourceType.URL,
        width: 64,
        wrappingStyle: TextWrappingStyle.WRAP_SQUARE,
        textRange: { startOffset: end(), endOffset: end() },
    } as never);
    if (floating == null) throw new Error('插入环绕图片失败');
    await settle(1200);
}

export const docBuilders: Record<string, SampleBuilder> = {
    'doc-text': async (editor) => {
        await applyHeadings(await replaceBody(editor, textBody()));
    },
    'doc-list': async (editor) => {
        await replaceBody(editor, listBody(RichTextBuilder.create().text('列表样本').paragraph()));
    },
    'doc-hyperlink': async (editor) => {
        await replaceBody(editor, linkBody(RichTextBuilder.create().text('超链接样本').paragraph()));
    },
    'doc-table': async (editor) => {
        const doc = await replaceBody(editor, RichTextBuilder.create().text('表格样本').paragraph());
        await appendTable(editor, doc);
    },
    'doc-drawing': async (editor) => {
        const doc = await replaceBody(editor, RichTextBuilder.create().text('图片样本：一张内联图片、一张四周环绕的浮动图片。').paragraph());
        await appendImages(doc);
    },
    'doc-all': async (editor) => {
        const doc = await replaceBody(editor, linkBody(listBody(textBody())));
        await applyHeadings(doc);
        await appendImages(doc);
        await appendTable(editor, activeDoc(editor));
    },
};

// 文字文档的平台策略（P5，docpolicy=platform 时安装）：证明 V13 结论中的"条件"可以做到。
// 都是验证用的最小实现，生产实现由 M1 的编辑器适配层统一设计；依赖的内部行为在 P5 报告的内部 API 一节登记。
// 1. `/` 键：SDK 的段落菜单服务在任何位置拦下 `/`（keydown 与 input 两条路径都会弹出菜单，
//    docs-ui/src/services/doc-paragraph-menu.service.ts:405-466），正文里无法键入 `/`；表格单元格里连菜单也不弹出，`/` 被吞掉。
//    平台在捕获阶段拦下 keydown 与 beforeinput（不经过 `/` 键的输入，例如系统文字替换）：光标在表格之外的空段落里时放行
//    （由 SDK 弹出 `/` 菜单）；其他位置由平台插入 `/`。文档不可编辑时不介入（由 SDK 的权限检查处理）。
// 2. 输入法事件归一：compositionend 的数据与最后一次 compositionupdate 不同（WebKit 的提交顺序）时，
//    SDK 的撤销记录按组合文字的长度计算，撤销会删错字（docs-ui 的 doc-ime-input.controller.ts:160-166）。
//    平台拦下原来的 compositionend，先补发一次携带最终文字的 compositionupdate，再派发 compositionend：
//    正常情况下等一个宏任务（SDK 在异步流程里记下更新）；在此之前如果又来了键盘、输入、组合或失焦事件，先同步派发，
//    否则这些输入会因为 SDK 仍认为在组合中而被丢弃（P5 审查 G5）。
// 3. 命令守卫：不支持的功能（切换版式、页面设置、分节、分节符与分栏符、页眉页脚、形状）；
//    超链接地址按白名单规范化（不合法就取消，合法但写法不规范就改成规范写法）；
//    图片的插入、移动、拖动的目标在表格单元格里时取消，锚点在单元格里的图片不能改为内联（00 号计划书 §4.3，P5 审查 R3）。
// 4. 粘贴清洗（剪贴板钩子，与 P4 的图片钩子并存，按注册顺序依次执行）：链接地址按白名单规范化，不合法的去掉；
//    去掉表格之外的分节符（内部片段可以带进来，MODERN 版式下 SDK 照样保留，P5 审查 S6）；粘贴目标在表格单元格里时去掉图片。
// 5. 版式：加载时把 documentFlavor 规范为 MODERN（create-editor.ts 在创建文档单元之前调用 normalizeDocFlavor）。
import type { DocumentDataModel, ICustomRange, IDisposable, IDocumentBody, IDocumentData, ITextRun, Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';

import { CustomRangeType, DocumentFlavor, ICommandService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { DocSelectionManagerService, InsertTextCommand } from '@univerjs/docs';
import { TextWrappingStyle } from '@univerjs/docs-drawing';
import { IDocClipboardService } from '@univerjs/docs-ui';

export type DocPolicyEventKind =
    | 'slash-insert'
    | 'slash-menu'
    | 'ime-normalize'
    | 'guard-cancel'
    | 'guard-normalize'
    | 'paste-link'
    | 'paste-cell-image'
    | 'paste-section-break'
    | 'flavor-normalize';

export interface DocPolicyEvent {
    t: number;
    kind: DocPolicyEventKind;
    detail: string;
}

/** 平台策略的操作记录（页面上经 window.__m0.docPolicy 读取）。 */
export const docPolicyEvents: DocPolicyEvent[] = [];
const record = (kind: DocPolicyEventKind, detail: string) => docPolicyEvents.push({ t: performance.now(), kind, detail });

/** 本期不提供的功能：命令与操作 id（隐藏菜单不会停用命令与快捷键，P5 报告 §内部 API）。 */
export const UNSUPPORTED_DOC_COMMANDS = [
    'doc.command.switch-mode',
    'docs.command.page-setup',
    'docs.operation.open-page-setting',
    'doc.command.insert-section-break',
    'doc.command.insert-column-break',
    'docs.operation.insert-section-break',
    'docs.operation.insert-column-break',
    'doc.command.update-section',
    'doc.command.core-header-footer',
    'doc.command.create-header-footer',
    'doc.command.open-header-footer-panel',
    'doc.command.set-section-header-footer-link',
    'sidebar.operation.doc-header-footer-panel',
    'doc.command.insert-float-shape.rectangle',
    'doc.command.insert-float-shape.ellipse',
] as const;

const LINK_COMMANDS = ['docs.command.add-hyper-link', 'docs.command.update-hyper-link'];

/**
 * 链接地址白名单与规范写法（P5 审查 G3）：返回规范后的地址，不合法时返回 null。
 * - 含控制字符（制表符、换行等）一律拒绝：浏览器解析时会去掉它们，`/\t/evil.example` 会变成协议相对地址；
 * - 文档内锚点 `#…`：不含空白、引号与尖括号；
 * - 本站相对地址：按站点源解析，解析结果必须仍在本站，保存解析后的路径；
 * - http、https、mailto：保存 URL 解析后的 href（引号、尖括号等被百分号编码，复制时不会注入 HTML）。
 */
export function normalizeLinkUrl(url: unknown, origin: string = location.origin): string | null {
    if (typeof url !== 'string') return null;
    const u = url.trim();
    if (u === '' || /[\u0000-\u001f\u007f]/.test(u)) return null;
    if (u.startsWith('#')) return /^#[^\s"'<>`]*$/.test(u) ? u : null;
    if (u.startsWith('/')) {
        try {
            const resolved = new URL(u, origin);
            return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : null;
        } catch {
            return null;
        }
    }
    try {
        const parsed = new URL(u);
        return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : null;
    } catch {
        return null;
    }
}

export const isAllowedLinkUrl = (url: unknown): boolean => normalizeLinkUrl(url) != null;

/** 数据流里的结构符：段落、分节、表格与单元格的边界（core/src/docs/data-model/types.ts）。 */
const STRUCTURAL = /[\r\n\x0e\x0f\x1a-\x1f]/;

/** 光标所在段落是否为空（光标在段落符之前，前面紧挨着结构符或文档开头）。 */
export function isEmptyParagraphAt(body: IDocumentBody, offset: number): boolean {
    const ds = body.dataStream;
    return ds[offset] === '\r' && (offset === 0 || STRUCTURAL.test(ds[offset - 1]));
}

/** 位置是否在表格内部（表格区间 [startIndex, endIndex)）。 */
export function isInTable(body: IDocumentBody, offset: number): boolean {
    return (body.tables ?? []).some((t) => offset > t.startIndex && offset < t.endIndex);
}

/** 在光标处插入的文字沿用左侧文字的样式与链接（与 SDK 的 getTextRunAtPosition 同一口径的简化版，不含"待应用样式"缓存）。 */
function insertBodyAt(body: IDocumentBody, offset: number, text: string): IDocumentBody {
    const atParagraphStart = offset === 0 || STRUCTURAL.test(body.dataStream[offset - 1]);
    const sample = atParagraphStart ? offset + 1 : offset;
    let run: ITextRun | undefined;
    for (const r of body.textRuns ?? []) if (sample > r.st && sample <= r.ed) run = r;
    const link = (body.customRanges ?? []).find((r) => offset > r.startIndex && offset <= r.endIndex && r.wholeEntity !== true);
    return {
        dataStream: text,
        textRuns: run?.ts != null ? [{ st: 0, ed: text.length, ts: { ...run.ts } }] : [],
        customRanges: link != null ? [{ ...link, startIndex: 0, endIndex: text.length - 1 }] : [],
    };
}

/** 从正文中删除若干位置的字符，并平移所有区间（粘贴到单元格时去掉图片的占位字符）。 */
export function removeCharsFromBody(body: IDocumentBody, indices: number[]): void {
    const sorted = [...new Set(indices)].sort((a, b) => b - a);
    for (const i of sorted) {
        body.dataStream = body.dataStream.slice(0, i) + body.dataStream.slice(i + 1);
        const shift = (x: number) => (x > i ? x - 1 : x);
        body.textRuns = (body.textRuns ?? []).map((r) => ({ ...r, st: shift(r.st), ed: r.ed > i ? r.ed - 1 : r.ed })).filter((r) => r.ed > r.st);
        body.paragraphs = (body.paragraphs ?? []).map((p) => ({ ...p, startIndex: shift(p.startIndex) }));
        body.sectionBreaks = (body.sectionBreaks ?? []).filter((s) => s.startIndex !== i).map((s) => ({ ...s, startIndex: shift(s.startIndex) }));
        body.customBlocks = (body.customBlocks ?? []).filter((b) => b.startIndex !== i).map((b) => ({ ...b, startIndex: shift(b.startIndex) }));
        body.tables = (body.tables ?? []).map((t) => ({ ...t, startIndex: shift(t.startIndex), endIndex: shift(t.endIndex) }));
        body.customRanges = (body.customRanges ?? []).map((r) => ({ ...r, startIndex: shift(r.startIndex), endIndex: r.endIndex >= i ? r.endIndex - 1 : r.endIndex })).filter((r) => r.endIndex >= r.startIndex);
        body.customDecorations = (body.customDecorations ?? []).map((d) => ({ ...d, startIndex: shift(d.startIndex), endIndex: d.endIndex >= i ? d.endIndex - 1 : d.endIndex })).filter((d) => d.endIndex >= d.startIndex);
    }
}

/** 加载前把版式规范为 MODERN（无分页的网页式版式，00 号计划书 §4.3）；返回原来的值。 */
export function normalizeDocFlavor(data: Partial<IDocumentData>): DocumentFlavor | undefined {
    const before = data.documentStyle?.documentFlavor;
    if (before !== DocumentFlavor.MODERN) {
        data.documentStyle = { ...(data.documentStyle ?? {}), documentFlavor: DocumentFlavor.MODERN } as IDocumentData['documentStyle'];
        record('flavor-normalize', `${String(before)} → ${DocumentFlavor.MODERN}`);
    }
    return before;
}

const isEditorInput = (target: EventTarget | null): target is HTMLElement => target instanceof HTMLElement && target.id.startsWith('__editor_');

export function installDocPolicy(univer: Univer, univerAPI: FUniver, unitId: string): IDisposable {
    const injector = univer.__getInjector();
    const commandService = injector.get(ICommandService);
    const instances = injector.get(IUniverInstanceService);
    const selection = injector.get(DocSelectionManagerService);
    const mainBody = (): IDocumentBody | undefined => instances.getUnit<DocumentDataModel>(unitId, UniverInstanceType.UNIVER_DOC)?.getBody();
    const canEdit = (): boolean => univerAPI.getActiveDocument()?.getPermission().canEdit() ?? false;
    const disposables: IDisposable[] = [];
    const listen = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
        document.addEventListener(type, fn, true);
        disposables.push({ dispose: () => document.removeEventListener(type, fn, true) });
    };

    // 2. 输入法事件归一（先注册：待派发的 compositionend 要赶在其他监听器之前补上）
    const lastUpdate = new WeakMap<EventTarget, string>();
    const ours = new WeakSet<Event>();
    let pending: { target: HTMLElement; data: string; last: string; timer: ReturnType<typeof setTimeout> } | null = null;
    const flush = () => {
        if (pending == null) return;
        const { target, data, last, timer } = pending;
        pending = null;
        clearTimeout(timer);
        const end = new CompositionEvent('compositionend', { data, bubbles: true });
        ours.add(end);
        target.dispatchEvent(end);
        record('ime-normalize', `${last} → ${data}`);
    };
    for (const type of ['keydown', 'beforeinput', 'input', 'compositionstart', 'focusout', 'mousedown', 'paste'] as const) {
        listen(type, (e: Event) => {
            if (pending != null && !ours.has(e)) flush();
        });
    }
    listen('compositionstart', (e) => {
        if (isEditorInput(e.target)) lastUpdate.set(e.target, '');
    });
    listen('compositionupdate', (e) => {
        if (isEditorInput(e.target)) lastUpdate.set(e.target, e.data ?? '');
    });
    listen('compositionend', (e) => {
        if (ours.has(e) || !isEditorInput(e.target)) return;
        const target = e.target;
        const last = lastUpdate.get(target) ?? '';
        const data = e.data ?? '';
        // 取消（数据为空）与数据一致（Chrome 的顺序）都不介入
        if (data === '' || data === last) return;
        e.stopPropagation();
        const update = new CompositionEvent('compositionupdate', { data, bubbles: true });
        ours.add(update);
        target.dispatchEvent(update);
        // SDK 在异步流程里才记下这次更新的文字（doc-ime-input.controller.ts:160-176），compositionend 等一个宏任务；
        // 在此之前来的输入先触发 flush（见上）
        pending = { target, data, last, timer: setTimeout(flush, 0) };
    });

    // 1. `/` 键：keydown（按键）与 beforeinput（不经过按键的输入）两条路径
    const handleSlash = (e: Event): void => {
        if (!isEditorInput(e.target) || e.target.id !== `__editor_${unitId}` || !canEdit()) return;
        const range = selection.getActiveTextRange();
        if (range == null || range.startOffset !== range.endOffset || (range.segmentId ?? '') !== '') return;
        const body = mainBody();
        if (body == null) return;
        if (isEmptyParagraphAt(body, range.startOffset) && !isInTable(body, range.startOffset)) {
            record('slash-menu', `offset ${range.startOffset}`);
            return;
        }
        // 阻止默认行为（否则 input 路径又会弹出菜单）与传播（段落菜单在隐藏输入元素上监听 keydown）
        e.preventDefault();
        e.stopPropagation();
        void commandService.executeCommand(InsertTextCommand.id, { unitId, body: insertBodyAt(body, range.startOffset, '/'), range, segmentId: '' });
        record('slash-insert', `${e.type} offset ${range.startOffset}`);
    };
    listen('keydown', (e) => {
        if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) handleSlash(e);
    });
    listen('beforeinput', (e) => {
        if (e.inputType === 'insertText' && e.data === '/' && !e.isComposing) handleSlash(e);
    });

    // 3. 命令守卫
    const anchorOf = (body: IDocumentBody, drawingId: string) => body.customBlocks?.find((b) => b.blockId === drawingId)?.startIndex;
    disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (e) => {
        const params = (e.params ?? {}) as Record<string, unknown>;
        const cancel = (reason: string) => {
            e.cancel = true;
            record('guard-cancel', `${e.id}：${reason}`);
        };
        if ((UNSUPPORTED_DOC_COMMANDS as readonly string[]).includes(e.id)) return cancel('本期不支持');
        if (LINK_COMMANDS.includes(e.id)) {
            const normalized = normalizeLinkUrl(params.payload);
            if (normalized == null) return cancel(`链接地址 ${String(params.payload).slice(0, 80)}`);
            if (normalized !== params.payload) {
                // 与命令处理器共用同一个参数对象，改写后按规范写法保存
                params.payload = normalized;
                record('guard-normalize', `${e.id}：链接地址规范为 ${normalized.slice(0, 80)}`);
            }
            return;
        }
        const body = mainBody();
        if (body == null) return;
        if (e.id === 'doc.command.insert-doc-image' || e.id === 'doc.command.move-inline-drawing' || e.id === 'doc.command.transform-non-inline-drawing') {
            const range = params.textRange as { startOffset?: number; segmentId?: string } | undefined;
            const offset = e.id === 'doc.command.insert-doc-image'
                ? range?.startOffset ?? selection.getActiveTextRange()?.startOffset
                : (params.offset as number | undefined);
            const segmentId = (params.segmentId as string | undefined) ?? range?.segmentId ?? selection.getActiveTextRange()?.segmentId ?? '';
            if (offset != null && segmentId === '' && isInTable(body, offset)) return cancel(`表格单元格里不能插入图片（offset ${offset}）`);
            return;
        }
        if (e.id === 'doc.command.update-doc-drawing-wrapping-style' && params.wrappingStyle === TextWrappingStyle.INLINE) {
            const drawings = (params.drawings ?? []) as { drawingId?: string }[];
            const inCell = drawings.filter((d) => d.drawingId != null && isInTable(body, anchorOf(body, d.drawingId) ?? -1));
            if (inCell.length > 0) return cancel(`锚点在表格单元格里的图片不能改为内联（${inCell.map((d) => d.drawingId).join('、')}）`);
        }
    }));

    // 4. 粘贴清洗
    disposables.push(injector.get(IDocClipboardService).addClipboardHook({
        onBeforePaste: (body, context) => {
            const bodies = [body, context.documentData.body].filter((b, i, all): b is IDocumentBody => b != null && all.indexOf(b) === i);
            for (const b of bodies) {
                for (const r of [...(b.customRanges ?? [])]) {
                    if (r.rangeType !== CustomRangeType.HYPERLINK) continue;
                    const url = r.properties?.url;
                    const normalized = normalizeLinkUrl(url);
                    if (normalized != null) {
                        if (normalized !== url) {
                            r.properties = { ...r.properties, url: normalized };
                            record('paste-link', `链接地址规范为 ${normalized.slice(0, 80)}`);
                        }
                        continue;
                    }
                    // SDK 的纯文本路径把"像网址的行"变成链接，地址却是整段粘贴的文字（parse.ts:65-74）：链接文字本身是合法地址时改用它
                    const fromText = normalizeLinkUrl(b.dataStream.slice(r.startIndex, r.endIndex + 1));
                    if (fromText != null) {
                        r.properties = { ...r.properties, url: fromText };
                        record('paste-link', `修正链接地址为链接文字 ${fromText.slice(0, 80)}`);
                    } else {
                        b.customRanges = (b.customRanges ?? []).filter((x) => x !== r);
                        record('paste-link', `去掉链接 ${String(url).slice(0, 80)}`);
                    }
                }
            }
            for (const b of bodies) {
                const breaks = (b.sectionBreaks ?? []).filter((x) => b.dataStream[x.startIndex] === '\n' && !isInTable(b, x.startIndex)).map((x) => x.startIndex);
                if (breaks.length === 0) continue;
                removeCharsFromBody(b, breaks);
                record('paste-section-break', `去掉表格之外的分节符 ${breaks.length} 个`);
            }
            const target = selection.getActiveTextRange();
            const targetBody = mainBody();
            if (target != null && targetBody != null && (target.segmentId ?? '') === '' && isInTable(targetBody, target.startOffset)) {
                for (const b of bodies) {
                    const blocks = (b.customBlocks ?? []).map((x) => x.startIndex);
                    if (blocks.length === 0) continue;
                    const ids = (b.customBlocks ?? []).map((x) => x.blockId);
                    removeCharsFromBody(b, blocks);
                    for (const id of ids) delete (context.documentData.drawings as Record<string, unknown> | undefined)?.[id];
                    record('paste-cell-image', `粘贴到表格单元格：去掉图片 ${ids.join('、')}`);
                }
            }
            return body;
        },
    }));

    return {
        dispose: () => {
            flush();
            disposables.forEach((d) => d.dispose());
        },
    };
}

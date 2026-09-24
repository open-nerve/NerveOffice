// 图片的粘贴钩子、命令守卫与复制补救（P4，00 号计划书 §8.5、§11.3），img=platform 时安装。
// 规则都是"默认拒绝"（P4 审查 R1）：任何深度上名为 source 的字段都当作图片地址，不是平台地址（含非字符串）就处理掉。
// - 文字文档剪贴板钩子（表格的单元格编辑器与编辑栏也用它）：
//   onBeforePasteImage：粘贴的图片文件、HTML 里的 data: 图片改为上传（默认实现把它们读成 data URL，不经过图片服务）；
//   onBeforePaste：插入前检查整个粘贴内容（包括"内部片段"，它不经过 HTML 转换，SDK 直接采用）：
//     本站的绝对地址规范回相对地址；drawings 里的非平台地址替换成平台内置的占位图（不删除图片对象，避免破坏正文里的占位字符）；
//     文字填充图片（ts.textFill）整个去掉；其他位置（列表符号图片、页面背景等）去掉持有 source 的那一项。
// - 命令守卫（纵深防御）：命令参数里有非平台地址的 source 时取消（BeforeCommandExecute，公开 API）。
//   它只看 COMMAND：命令内部执行的 mutation 看不到，所以它兜住的是平台代码的误用（例如 Facade 的字符串接口），不是所有未知路径；
//   最终的防线是服务端的保存校验（server/serve.ts 的 validate=1）。
// 表格另有复制补救（sheet-image-copy.ts），由表格档案提供。
import type { IDisposable, Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';

import { CommandType, ImageSourceType } from '@univerjs/core';
import { IDocClipboardService } from '@univerjs/docs-ui';
import { classifySource, extractImages } from '../../server/snapshot-images';
import { PLACEHOLDER_ASSET_URL, recordImageEvent, uploadImage } from './platform-image-io';

type Json = Record<string, unknown>;

/** 遍历对象，把每个带 source 字段的对象连同它的父对象与键交给 visit。 */
function eachSourceOwner(root: unknown, visit: (owner: Json, parent: Json | unknown[] | null, key: string, path: string) => void): void {
    const walk = (value: unknown, parent: Json | unknown[] | null, key: string, path: string) => {
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, value, String(i), `${path}/${i}`));
            return;
        }
        if (value == null || typeof value !== 'object') return;
        const o = value as Json;
        if ('source' in o) visit(o, parent, key, path);
        for (const [k, v] of Object.entries(o)) walk(v, o, k, `${path}/${k}`);
    };
    walk(root, null, '', '');
}

/** 粘贴内容的默认拒绝处理；返回处理记录。drawings 是 documentData.drawings（图片对象替换为占位图，不删除）。 */
function sanitizePasted(root: unknown, drawings: Json | undefined): string[] {
    const actions: string[] = [];
    const drawingSet = new Set(Object.values(drawings ?? {}));
    eachSourceOwner(root, (owner, parent, key, path) => {
        const kind = classifySource(owner.source, location.origin);
        if (kind === 'platform') {
            if (typeof owner.source === 'string' && owner.source.startsWith(location.origin)) {
                owner.source = owner.source.slice(location.origin.length);
                actions.push(`normalize ${path}`);
            }
            return;
        }
        const detail = `${kind} ${path} ${typeof owner.source === 'string' ? owner.source.slice(0, 80) : JSON.stringify(owner.source)?.slice(0, 80)}`;
        if (drawingSet.has(owner)) {
            owner.source = PLACEHOLDER_ASSET_URL;
            owner.imageSourceType = ImageSourceType.URL;
            actions.push(`replace ${detail}`);
            return;
        }
        if (parent == null) return;
        // 文字填充图片：去掉整个 textFill（owner 是 picture，parent 是 textFill，要从 textFill 的父对象上删）
        if (key === 'picture' && /\/textFill\/picture$/.test(path)) {
            const tsPath = path.replace(/\/textFill\/picture$/, '');
            eachOwnerAt(root, tsPath, (ts) => delete ts.textFill);
            actions.push(`drop-textFill ${detail}`);
            return;
        }
        if (Array.isArray(parent)) parent.splice(Number(key), 1, null);
        else delete parent[key];
        actions.push(`drop ${detail}`);
    });
    return actions;
}

/** 按路径找到对象并执行 fn（路径由 eachSourceOwner 生成）。 */
function eachOwnerAt(root: unknown, path: string, fn: (o: Json) => void): void {
    let cur: unknown = root;
    for (const seg of path.split('/').filter((x) => x !== '')) {
        if (cur == null || typeof cur !== 'object') return;
        cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) fn(cur as Json);
}

export function installImageGuards(univer: Univer, univerAPI: FUniver): IDisposable {
    const injector = univer.__getInjector();
    const disposables: IDisposable[] = [];

    const hook = injector.get(IDocClipboardService).addClipboardHook({
        onBeforePasteImage: async (file: File) => {
            try {
                const uploaded = await uploadImage(file, file.name);
                recordImageEvent('paste-upload', true, uploaded.url);
                return { source: uploaded.url, imageSourceType: ImageSourceType.URL };
            } catch (error) {
                recordImageEvent('paste-upload', false, `${file.type} ${file.size}：${error instanceof Error ? error.message : String(error)}`);
                return null;
            }
        },
        onBeforePaste: (body, context) => {
            const drawings = context.documentData.drawings as Json | undefined;
            const actions = [...sanitizePasted(body, drawings), ...(context.documentData.body === body ? [] : sanitizePasted(context.documentData.body, drawings))];
            const { body: _body, ...rest } = context.documentData;
            actions.push(...sanitizePasted(rest, drawings));
            for (const a of actions) recordImageEvent(a.startsWith('normalize') ? 'paste-normalize' : 'paste-replace', true, a);
            return body;
        },
    });
    disposables.push(hook);

    disposables.push(univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (e) => {
        if (e.type !== CommandType.COMMAND || e.params == null || typeof e.params !== 'object') return;
        const rejected = extractImages(e.params, location.origin).images.filter((i) => i.kind !== 'platform');
        if (rejected.length === 0) return;
        e.cancel = true;
        recordImageEvent('guard-cancel', true, `${e.id}：${rejected.map((i) => `${i.kind} ${i.source.slice(0, 60)}`).join('；')}`);
    }));

    return { dispose: () => disposables.forEach((d) => d.dispose()) };
}

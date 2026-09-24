// 图片的粘贴钩子与命令守卫（P4，00 号计划书 §8.5、§11.3），img=platform 时安装。
// - 文字文档剪贴板钩子（表格的单元格编辑器与编辑栏也用它）：
//   onBeforePasteImage：粘贴的图片文件、HTML 里的 data: 图片改为上传（默认实现把它们读成 data URL，不经过图片服务）；
//   onBeforePaste：插入前检查 documentData.drawings，本站的绝对地址规范回相对地址；外链、file:、blob:、data: 等非平台地址
//   替换成平台内置的占位图（不删除图片对象，避免破坏正文里的占位字符），浏览器也无法跨域读取外链（connect-src 'self'）。
// - 命令守卫（纵深防御）：命令参数里带非平台地址的图片时取消（BeforeCommandExecute，公开 API），覆盖平台代码的误用与未知路径。
//   最终的防线是服务端的保存校验（server/serve.ts 的 validate=1）。
import type { IDisposable, Univer } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';

import { CommandType, ImageSourceType } from '@univerjs/core';
import { IDocClipboardService } from '@univerjs/docs-ui';
import { classifySource, extractImages } from '../../server/snapshot-images';
import { PLACEHOLDER_ASSET_URL, recordImageEvent, uploadImage } from './platform-image-io';

interface DrawingLike {
    source?: unknown;
    imageSourceType?: unknown;
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
            for (const drawing of Object.values(context.documentData.drawings ?? {}) as DrawingLike[]) {
                if (typeof drawing.source !== 'string') continue;
                const kind = classifySource(drawing.source, location.origin);
                if (kind === 'platform') {
                    if (drawing.source.startsWith(location.origin)) {
                        recordImageEvent('paste-normalize', true, drawing.source);
                        drawing.source = drawing.source.slice(location.origin.length);
                    }
                    continue;
                }
                recordImageEvent('paste-replace', true, `${kind}：${drawing.source}`);
                drawing.source = PLACEHOLDER_ASSET_URL;
                drawing.imageSourceType = ImageSourceType.URL;
            }
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

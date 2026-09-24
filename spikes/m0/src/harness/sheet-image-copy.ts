// 表格：复制浮动图片的补救（P4 审查 R4），img=platform 时由表格档案安装。
// SDK 复制 URL 类型的浮动图片时，200 ms 后往系统剪贴板写空文本（sheets-drawing-ui 的 sheet-drawing-copy-paste.controller.ts:145-152），
// 同一页面里靠内存中的复制信息粘贴，跨文档（另一个标签页）粘贴就拿不到图片。这里在它之后把同源图片转成 PNG 写入剪贴板，
// 另一个文档粘贴时走"粘贴图片文件"的路径，由平台图片服务重新上传。
import type { IDisposable, Univer } from '@univerjs/core';

import { DrawingTypeEnum, ImageSourceType } from '@univerjs/core';
import { IDrawingManagerService } from '@univerjs/drawing';
import { ISheetClipboardService } from '@univerjs/sheets-ui';
import { classifySource } from '../../server/snapshot-images';
import { recordImageEvent } from './platform-image-io';

/** 把同源图片转成 PNG 写入系统剪贴板（剪贴板的图片格式普遍只支持 PNG；同源图片不会污染画布）。 */
async function writeImageToClipboard(source: string): Promise<void> {
    try {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b != null ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        recordImageEvent('copy-image', true, source);
    } catch (error) {
        recordImageEvent('copy-image', false, `${source}：${error instanceof Error ? error.message : String(error)}`);
    }
}

export function installSheetImageCopy(univer: Univer): IDisposable {
    const injector = univer.__getInjector();
    const drawingService = injector.get(IDrawingManagerService);
    return injector.get(ISheetClipboardService).addClipboardHook({
        id: 'PLATFORM_IMAGE_COPY',
        // 所有钩子的 onBeforeCopyFocusedObject 都会被调用（sheets-ui 的 clipboard.service.ts:333-337），返回 false 不影响 SDK 自己的图片复制
        onBeforeCopyFocusedObject: () => {
            const image = drawingService.getFocusDrawings().find((d) => d.drawingType === DrawingTypeEnum.DRAWING_IMAGE) as { source?: string; imageSourceType?: string } | undefined;
            if (image?.imageSourceType === ImageSourceType.URL && classifySource(image.source, location.origin) === 'platform') {
                // SDK 在 200 ms 后写空文本，在它之后再写
                setTimeout(() => void writeImageToClipboard(image.source!), 350);
            }
            return false;
        },
    });
}

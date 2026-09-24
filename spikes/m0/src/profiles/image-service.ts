// 图片服务的替换（P4，00 号计划书 §8.5）：UniverDrawingPlugin 的 override 把 IImageIoService 换成平台图片服务。
// 官方 preset 不开放 override，档案逐个注册插件，所以可以直接传配置（drawing/src/plugin.ts:60-69）。
import type { ProfileOptions } from './types';

import { IImageIoService } from '@univerjs/core';
import { DRAWING_IMAGE_ALLOW_IMAGE_LIST } from '@univerjs/drawing';
import { imageMimeTypeSet } from '@univerjs/ui';
import { PlatformImageIoService } from '../harness/platform-image-io';

export function drawingPluginConfig(imageService: ProfileOptions['imageService']): { override: [typeof IImageIoService, { useClass: typeof PlatformImageIoService }][] } | undefined {
    return imageService === 'platform' ? { override: [[IImageIoService, { useClass: PlatformImageIoService }]] } : undefined;
}

/**
 * 让 SDK 各入口接受的图片格式与平台一致（PNG、JPEG、GIF、WebP，00 号计划书 §4.1；P4 审查 G4）：
 * - 插入图片的文件选择框按 DRAWING_IMAGE_ALLOW_IMAGE_LIST 生成 accept（默认没有 WebP，却有平台不接受的 BMP）；
 * - 文字文档粘贴、表格菜单粘贴按 imageMimeTypeSet 挑选剪贴板里的图片（默认没有 GIF）。
 * 两者都是 SDK 导出的可变模块状态（内部 API，P4 报告 §4 登记），对页面里的所有实例生效。
 */
export function alignImageFormats(): void {
    DRAWING_IMAGE_ALLOW_IMAGE_LIST.splice(0, DRAWING_IMAGE_ALLOW_IMAGE_LIST.length, 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp');
    imageMimeTypeSet.clear();
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) imageMimeTypeSet.add(type);
}

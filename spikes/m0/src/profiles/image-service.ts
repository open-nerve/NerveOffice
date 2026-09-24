// 图片服务的替换（P4，00 号计划书 §8.5）：UniverDrawingPlugin 的 override 把 IImageIoService 换成平台图片服务。
// 官方 preset 不开放 override，档案逐个注册插件，所以可以直接传配置（drawing/src/plugin.ts:60-69）。
import type { ProfileOptions } from './types';

import { IImageIoService } from '@univerjs/core';
import { PlatformImageIoService } from '../harness/platform-image-io';

export function drawingPluginConfig(imageService: ProfileOptions['imageService']): { override: [typeof IImageIoService, { useClass: typeof PlatformImageIoService }][] } | undefined {
    return imageService === 'platform' ? { override: [[IImageIoService, { useClass: PlatformImageIoService }]] } : undefined;
}

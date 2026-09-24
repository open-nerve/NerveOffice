// 平台图片服务（P4，00 号计划书 §8.5）：实现 IImageIoService，插入图片时先上传到平台，快照里只保存同源地址 /api/assets/{assetId}。
// 经 UniverDrawingPlugin 的 override 注册（img=platform）。SDK 的约定（Phase 文档 §2）：
// - base64Cache 必须能加载（插入流程用它量尺寸）：这里直接用同源地址，多一次读取，同时验证了读取可用；
// - imageId 直接当作 drawingId：每次生成新的随机 id，不用 assetId（服务端按内容去重，同一张图可能对应多个 assetId，也可能被插入多次）；
// - 失败时以 Error(ImageUploadStatusType.X) 拒绝，SDK 才会给出本地化提示；
// - change$ 在启动时就被订阅：上传开始时发出正数、结束时回到 0，表格会显示"上传中"。
import type { IImageIoService, IImageIoServiceParam, Nullable } from '@univerjs/core';

import { generateRandomId, ImageSourceType, ImageUploadStatusType } from '@univerjs/core';
import { Subject } from 'rxjs';

export const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PLACEHOLDER_ASSET_URL = '/api/assets/00000000-0000-4000-8000-000000000000';

export interface UploadResult {
    assetId: string;
    url: string;
    type: string;
    width: number;
    height: number;
}

export class UploadError extends Error {
    constructor(readonly status: number) {
        super(`upload failed: ${status}`);
    }
}

/** 平台的图片操作记录（验证用，页面里经 window.__m0.images.log 读取）。 */
export interface ImageEvent {
    at: number;
    /** save：图片服务上传；paste-upload：剪贴板钩子上传；paste-replace：粘贴时替换成占位图；guard-cancel：命令守卫取消。 */
    kind: 'save' | 'paste-upload' | 'paste-replace' | 'paste-normalize' | 'guard-cancel';
    ok: boolean;
    detail: string;
}

export const imageEvents: ImageEvent[] = [];

export function recordImageEvent(kind: ImageEvent['kind'], ok: boolean, detail: string): void {
    imageEvents.push({ at: performance.now(), kind, ok, detail: detail.slice(0, 160) });
}

/** 上传到验证服务的 /api/assets（原始字节，服务端按文件头识别类型）。 */
export async function uploadImage(file: Blob, name?: string): Promise<UploadResult> {
    const res = await fetch('/api/assets', {
        method: 'POST',
        body: file,
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'application/octet-stream', ...(name ? { 'X-File-Name': encodeURIComponent(name) } : {}) },
    });
    if (!res.ok) throw new UploadError(res.status);
    return (await res.json()) as UploadResult;
}

/** 上传失败映射成 SDK 的错误约定；其他失败统一为 ERROR_IMAGE。 */
function toStatusError(error: unknown): Error {
    if (error instanceof Error && Object.values(ImageUploadStatusType).includes(error.message as ImageUploadStatusType)) return error;
    if (error instanceof UploadError && error.status === 413) return new Error(ImageUploadStatusType.ERROR_EXCEED_SIZE);
    if (error instanceof UploadError && error.status === 415) return new Error(ImageUploadStatusType.ERROR_IMAGE_TYPE);
    return new Error(ImageUploadStatusType.ERROR_IMAGE);
}

export class PlatformImageIoService implements IImageIoService {
    private _waitCount = 0;
    private readonly _change$ = new Subject<number>();
    readonly change$ = this._change$.asObservable();
    private readonly _cache = new Map<string, HTMLImageElement>();

    setWaitCount(count: number): void {
        this._waitCount = count;
        this._change$.next(count);
    }

    getImageSourceCache(source: string, imageSourceType: ImageSourceType): Nullable<HTMLImageElement> {
        const cached = this._cache.get(source);
        if (cached != null) return cached;
        // 旧文档里的 BASE64 图片：与默认实现一样就地创建（平台模式下新插入的图片不会是 BASE64）
        if (imageSourceType === ImageSourceType.BASE64) {
            const image = new Image();
            image.onload = () => this._change$.next(this._waitCount);
            image.onerror = () => this._change$.next(this._waitCount);
            image.src = source;
            this._cache.set(source, image);
            return image;
        }
        return undefined;
    }

    addImageSourceCache(source: string, imageSourceType: ImageSourceType, imageSource: Nullable<HTMLImageElement>): void {
        if (imageSourceType === ImageSourceType.BASE64 || imageSource == null) return;
        // 加载失败的元素不留在缓存里：SDK 的渲染服务会一直复用缓存中的元素，失败就要等到刷新页面（Phase 文档 §2）
        imageSource.addEventListener('error', () => {
            if (this._cache.get(source) === imageSource) this._cache.delete(source);
        }, { once: true });
        this._cache.set(source, imageSource);
    }

    async getImage(imageId: string): Promise<string> {
        return imageId;
    }

    async saveImage(imageFile: File): Promise<Nullable<IImageIoServiceParam>> {
        this._waitCount += 1;
        this._change$.next(this._waitCount);
        try {
            if (!ALLOWED_IMAGE_TYPES.includes(imageFile.type)) throw new Error(ImageUploadStatusType.ERROR_IMAGE_TYPE);
            if (imageFile.size > MAX_IMAGE_BYTES) throw new Error(ImageUploadStatusType.ERROR_EXCEED_SIZE);
            const uploaded = await uploadImage(imageFile, imageFile.name);
            recordImageEvent('save', true, uploaded.url);
            return {
                imageId: generateRandomId(6),
                imageSourceType: ImageSourceType.URL,
                source: uploaded.url,
                base64Cache: uploaded.url,
                status: ImageUploadStatusType.SUCCUSS,
            };
        } catch (error) {
            const mapped = toStatusError(error);
            recordImageEvent('save', false, `${imageFile.type} ${imageFile.size}：${error instanceof Error ? error.message : String(error)} → ${mapped.message}`);
            throw mapped;
        } finally {
            this._waitCount = Math.max(0, this._waitCount - 1);
            this._change$.next(this._waitCount);
        }
    }
}

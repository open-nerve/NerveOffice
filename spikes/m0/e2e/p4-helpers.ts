// P4 的测试辅助：合成粘贴、文件选择框、图片资源的观测、CSP 违规与外部请求。
import type { APIRequestContext, Page } from '@playwright/test';
import type { AssetReadLog, UploadLog } from '../server/assets';
import type { ImageRef, SnapshotImages } from '../server/snapshot-images';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractImages } from '../server/snapshot-images';

export const ASSET_DIR = join(import.meta.dirname, '..', 'public', 'fixtures-assets');

export interface PasteFile {
    name: string;
    type: string;
    base64: string;
}

export function fixtureFile(name: string, type = 'image/png'): PasteFile {
    return { name, type, base64: readFileSync(join(ASSET_DIR, name)).toString('base64') };
}

export function dataUrl(file: PasteFile): string {
    return `data:${file.type};base64,${file.base64}`;
}

/**
 * 合成粘贴：把文件、HTML、纯文本放进 DataTransfer，派发到获得焦点的元素。
 * 表格与文字文档都在编辑器的隐藏输入元素上监听 paste（DocSelectionRenderService.onPaste$），与快捷键粘贴走同一条路径。
 */
export async function syntheticPaste(page: Page, data: { files?: PasteFile[]; html?: string; text?: string }): Promise<{ target: string; defaultPrevented: boolean }> {
    return page.evaluate((d) => {
        const dt = new DataTransfer();
        for (const f of d.files ?? []) {
            const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
            dt.items.add(new File([bytes], f.name, { type: f.type }));
        }
        if (d.html != null) dt.setData('text/html', d.html);
        if (d.text != null) dt.setData('text/plain', d.text);
        const target = document.activeElement ?? document.body;
        const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return { target: `${target.tagName.toLowerCase()}${target.className ? `.${String(target.className).split(' ')[0]}` : ''}`, defaultPrevented: event.defaultPrevented };
    }, data);
}

/** 执行会打开文件选择框的命令（与工具栏按钮是同一个命令），选中给定的文件。 */
export async function insertViaFileChooser(page: Page, commandId: string, files: PasteFile[]): Promise<void> {
    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
    await page.evaluate((id) => {
        void window.__m0!.editor!.univerAPI.executeCommand(id);
    }, commandId);
    await (await chooser).setFiles(files.map((f) => ({ name: f.name, mimeType: f.type, buffer: Buffer.from(f.base64, 'base64') })));
}

export interface AssetsState {
    assets: { assetId: string; uploader: string; type: string; width: number; height: number }[];
    files: number;
    links: Record<string, string[]>;
    reads: AssetReadLog[];
    uploads: UploadLog[];
}

export async function assetsState(request: APIRequestContext, base: string): Promise<AssetsState> {
    return (await (await request.get(`${base}/__assets`)).json()) as AssetsState;
}

export async function resetAssetLogs(request: APIRequestContext, base: string): Promise<void> {
    await request.delete(`${base}/__assets`);
}

/** 快照中的图片（按分类），以及通用扫描发现的其他可疑字符串（超链接地址除外）。 */
export function snapshotImages(text: string, origin: string): SnapshotImages & { byKind: Record<string, number> } {
    const result = extractImages(JSON.parse(text), origin);
    const stray = result.stray.filter((s) => !/\/(?:url|payload)$/.test(s.where));
    const byKind: Record<string, number> = {};
    for (const i of result.images) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    return { images: result.images, stray, byKind };
}

/** 两份快照之间新增的图片（按 where + source 比较）。 */
export function addedImages(before: ImageRef[], after: ImageRef[]): ImageRef[] {
    const seen = new Set(before.map((i) => `${i.where}|${i.source}`));
    return after.filter((i) => !seen.has(`${i.where}|${i.source}`));
}

/** 页面里图片服务缓存中的元素是否加载成功（浮动图片），以及页面上全部 img 元素的状态。 */
export async function imageLoadState(page: Page, sources: string[]): Promise<{ source: string; cached: boolean; complete: boolean; width: number }[]> {
    return page.evaluate((list) => {
        const io = window.__m0!.images!.io();
        return list.map((source) => {
            const el = io.getImageSourceCache(source, 'URL' as never) as HTMLImageElement | null | undefined;
            return { source, cached: el != null, complete: el?.complete ?? false, width: el?.naturalWidth ?? 0 };
        });
    }, sources);
}

/** 记录页面发起的外部请求（非本站），并按需拦截（csp=off 时用来证明"会不会发出请求"）。 */
export async function watchExternalRequests(page: Page, origin: string): Promise<string[]> {
    const seen: string[] = [];
    await page.route((url) => !url.href.startsWith(origin) && !url.href.startsWith('data:') && !url.href.startsWith('blob:'), async (route) => {
        seen.push(route.request().url());
        await route.abort();
    });
    return seen;
}

/** 页面上的 CSP 违规事件（events.ts 在页面加载时就开始记录）。 */
export async function cspViolations(page: Page): Promise<{ directive: string; blocked: string; disposition: string }[]> {
    return page.evaluate(() => (window.__m0!.events.cspViolations ?? []).map((v) => ({ directive: v.effectiveDirective, blocked: v.blockedURI, disposition: v.disposition })));
}

// V03 样本生成：在空白文档上执行构建器，把 save() 的输出写入 fixtures/。
// 样本生成后入库；只在需要重新生成时运行：M0_BUILD_SAMPLES=1 npx playwright test e2e/v03-build-samples.spec.ts --project=chromium
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVERS, waitForEditor } from './helpers';

test.skip(process.env.M0_BUILD_SAMPLES !== '1', '只在需要重新生成样本时运行（M0_BUILD_SAMPLES=1）');
test.use({ baseURL: SERVERS.off });

export const SHEET_SAMPLES = ['sheet-core', 'sheet-cf', 'sheet-dv', 'sheet-filter', 'sheet-hyperlink', 'sheet-note', 'sheet-drawing', 'sheet-protection', 'sheet-all'];
export const DOC_SAMPLES = ['doc-text', 'doc-list', 'doc-hyperlink', 'doc-table', 'doc-drawing', 'doc-all'];

for (const name of [...SHEET_SAMPLES, ...DOC_SAMPLES]) {
    test(`生成样本 ${name}`, async ({ page }) => {
        const kind = name.startsWith('sheet') ? 'sheet' : 'doc';
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(`/${kind}.html?sample=empty&unit=m0-${name}`);
        await waitForEditor(page);
        await page.evaluate(async (n) => {
            const m = window.__m0!;
            const build = m.builders?.[n];
            if (build == null) throw new Error(`没有构建器：${n}`);
            await build(m.editor!);
        }, name);
        const snapshot = await page.evaluate(() => window.__m0!.editor!.save());
        const events = await page.evaluate(() => window.__m0!.events);
        expect(pageErrors, '页面错误').toEqual([]);
        expect(events.errors, '未捕获错误').toEqual([]);
        expect(events.consoleErrors, '控制台错误').toEqual([]);
        await writeFile(join(import.meta.dirname, '..', 'fixtures', kind, `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
    });
}

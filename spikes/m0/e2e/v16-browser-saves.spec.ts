// V16 的对照：浏览器里"加载 fixtures 的样本 → save()"的结果，供 scripts/v16-node-load.ts 与 Node 下的结果比较。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { browserInfo, SERVERS, waitForEditor, writeResult } from './helpers';
import { waitQuiet } from './p3-helpers';

for (const kind of ['sheet', 'doc'] as const) {
    const names = readdirSync(join(import.meta.dirname, '..', 'fixtures', kind)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    for (const name of names) {
        test(`V16 浏览器保存：${kind}/${name}`, async ({ page }, testInfo) => {
            await page.goto(`${SERVERS.full}/${kind}.html?sample=${name}`);
            await waitForEditor(page);
            await waitQuiet(page);
            const saved = await page.evaluate(() => window.__m0!.editor!.save());
            await writeResult(`v16/browser/${testInfo.project.name}-${kind}-${name}.json`, { check: 'V16-browser-save', browser: browserInfo(page, testInfo), timestamp: new Date().toISOString(), saved });
        });
    }
}

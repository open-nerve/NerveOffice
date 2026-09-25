// 真实输入法的人工核对（P5，V13）：无头浏览器无法驱动系统输入法，由人在真实的 Safari 与 Chrome 里按页面上的清单输入。
// 用法：先 vite build，再 node scripts/ime-real.ts，然后：
//   1. 在 Safari 与 Chrome 中分别打开脚本打印的地址（加 --open 由脚本用 `open -a` 打开）；
//   2. 按页面右下角的清单操作，点"上传记录"；
//   3. 回到终端按回车，脚本汇总记录（写入 e2e/results/v13/ime-real/）后退出。
// 汇总的重点：提交时 compositionend 的数据与最后一次 compositionupdate 是否相同（不同即 WebKit 顺序，会触发撤销缺陷），
// 以及撤销、重做之后的正文。
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import type { ImeLog } from '../src/harness/ime-recorder';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'e2e', 'results', 'v13', 'ime-real');
const PORT = 4790;
const url = (policy: string) => `http://127.0.0.1:${PORT}/doc.html?sample=minimal&imelog=1&docpolicy=${policy}`;

const server = spawn('node', ['server/serve.ts', '--port', String(PORT), '--csp', 'full', '--imelog-dir', OUT], { cwd: ROOT, stdio: 'ignore' });
process.on('exit', () => server.kill());
for (let i = 0; i < 100; i++) {
    try {
        if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break;
    } catch {
        // 服务还没起来
    }
    await new Promise((r) => setTimeout(r, 100));
}

console.log('输入法记录页（SDK 默认行为，用来确认各浏览器的事件顺序）：');
console.log(`  ${url('default')}`);
console.log('对照（平台策略：事件归一、`/` 键等）：');
console.log(`  ${url('platform')}`);
if (process.argv.includes('--open')) {
    for (const app of ['Safari', 'Google Chrome']) {
        try {
            execFileSync('open', ['-a', app, url('default')]);
        } catch {
            console.log(`没能打开 ${app}，请手动打开上面的地址`);
        }
    }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('\n在两个浏览器里做完清单并点"上传记录"之后，按回车汇总：');
rl.close();

const logs: ImeLog[] = (existsSync(OUT) ? readdirSync(OUT, { withFileTypes: true }) : [])
    .filter((f) => f.isFile() && f.name.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(OUT, f.name), 'utf8')) as ImeLog);

for (const log of logs) {
    const browser = /Chrome\//.test(log.userAgent) ? 'Chrome' : /Safari\//.test(log.userAgent) ? 'Safari' : log.userAgent;
    console.log(`\n== ${browser}（${log.session}，${log.url.includes('docpolicy=platform') ? '平台策略' : 'SDK 默认'}）`);
    let lastUpdate = '';
    for (const e of log.events) {
        if (e.type === 'compositionupdate') lastUpdate = e.data ?? '';
        if (e.type === 'compositionend') {
            const same = (e.data ?? '') === lastUpdate;
            console.log(`  提交 "${e.data ?? ''}"：最后一次 compositionupdate 为 "${lastUpdate}"，${same ? '相同（Chrome 顺序）' : '不同（WebKit 顺序）'}`);
        }
        if (e.type === 'input' && (e.inputType === 'insertFromComposition' || e.inputType === 'deleteCompositionText')) {
            console.log(`  input ${e.inputType} data="${e.data ?? ''}"`);
        }
    }
    for (const c of log.checkpoints) console.log(`  [${c.reason}] 段落 ${c.paragraphs}，撤销栈 ${c.undo.undos}/${c.undo.redos}：${c.text.slice(-40)}`);
}
console.log(`\n记录文件：${OUT}`);
process.exit(0);

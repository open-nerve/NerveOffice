// V01：生产依赖图的版本一致性、重复实例、Pro 检查、安装脚本与许可分类。
// 用法：node scripts/deps-report.ts（需先 pnpm install）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PNPM = ['-y', 'pnpm@12.6.0'];
const OUT = join(import.meta.dirname, '..', 'e2e', 'results', 'v01');
const EXPECTED_UNIVER = '1.0.0';
/** 独立发版、按 @univerjs/ui 声明锁定的包。 */
const INDEPENDENT = new Map([['@univerjs/icons', '1.43.0']]);
/** 多份实例会破坏依赖注入或 React 上下文的包。 */
const SINGLETONS = ['react', 'react-dom', 'rxjs', '@wendellhu/redi'];

const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib']);
const WEAK_COPYLEFT = new Set(['MPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'LGPL-2.1-only', 'LGPL-3.0-only', 'EPL-2.0', 'CDDL-1.0']);

interface LsNode {
    version: string;
    path: string;
    dependencies?: Record<string, LsNode>;
}

function pnpmJson(args: string[]): unknown {
    const out = execFileSync('npx', [...PNPM, ...args], { cwd: join(import.meta.dirname, '..'), maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(out);
}

function classify(license: string): 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown' {
    const parts = license.replace(/[()]/g, '').split(/\s+OR\s+/);
    // 多选一的许可取最宽松的一项
    if (parts.some((p) => PERMISSIVE.has(p.trim()))) return 'permissive';
    if (parts.some((p) => WEAK_COPYLEFT.has(p.trim()))) return 'weak-copyleft';
    if (/GPL|AGPL|SSPL|EUPL/i.test(license)) return 'strong-copyleft';
    return 'unknown';
}

const tree = pnpmJson(['ls', '--prod', '--depth', 'Infinity', '--json']) as { dependencies: Record<string, LsNode> }[];
const versions = new Map<string, Set<string>>();
const paths = new Map<string, string>();
const walk = (deps: Record<string, LsNode> | undefined) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
        const set = versions.get(name) ?? new Set();
        set.add(node.version);
        versions.set(name, set);
        paths.set(`${name}@${node.version}`, node.path);
        walk(node.dependencies);
    }
};
walk(tree[0].dependencies);

const univer = [...versions.entries()].filter(([n]) => n.startsWith('@univerjs/'));
const univerMismatch = univer
    .filter(([n, v]) => {
        const expected = INDEPENDENT.get(n) ?? EXPECTED_UNIVER;
        return v.size !== 1 || !v.has(expected);
    })
    .map(([n, v]) => ({ name: n, versions: [...v] }));
const pro = [...versions.keys()].filter((n) => n.startsWith('@univerjs-pro/') || /univer-?pro/i.test(n));
const duplicates = [...versions.entries()].filter(([, v]) => v.size > 1).map(([n, v]) => ({ name: n, versions: [...v] }));
const singletonDuplicates = duplicates.filter((d) => SINGLETONS.includes(d.name) || d.name.startsWith('@univerjs/'));

// 安装脚本：供应链风险点，需要显式放行或拒绝
const installScripts: { pkg: string; scripts: Record<string, string> }[] = [];
for (const [key, dir] of paths) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const s = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([k]) => ['preinstall', 'install', 'postinstall'].includes(k)));
    if (Object.keys(s).length > 0) installScripts.push({ pkg: key, scripts: s });
}

const licensesRaw = pnpmJson(['licenses', 'list', '--prod', '--json']) as Record<string, { name: string; versions: string[]; license: string; author?: string; homepage?: string }[]>;
const licenseRows = Object.values(licensesRaw)
    .flat()
    .map((p) => ({ name: p.name, versions: p.versions, license: p.license, category: classify(p.license), author: p.author ?? '', homepage: p.homepage ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
const byLicense: Record<string, number> = {};
const byCategory: Record<string, number> = {};
for (const r of licenseRows) {
    byLicense[r.license] = (byLicense[r.license] ?? 0) + 1;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
}
const nonPermissive = licenseRows.filter((r) => r.category !== 'permissive');

const summary = {
    check: 'V01',
    timestamp: new Date().toISOString(),
    node: process.version,
    packageCount: versions.size,
    univer: {
        expected: EXPECTED_UNIVER,
        packages: univer.map(([n, v]) => ({ name: n, versions: [...v] })).sort((a, b) => a.name.localeCompare(b.name)),
        mismatches: univerMismatch,
    },
    proPackages: pro,
    duplicates,
    singletonDuplicates,
    installScripts,
    licenses: { byLicense, byCategory, nonPermissive },
    verdict: {
        univerVersionsLocked: univerMismatch.length === 0,
        noPro: pro.length === 0,
        noSingletonDuplicates: singletonDuplicates.length === 0,
        allLicensesPermissive: nonPermissive.length === 0,
    },
};

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'deps.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(OUT, 'licenses.json'), `${JSON.stringify(licenseRows, null, 2)}\n`);
console.log(JSON.stringify({ packageCount: summary.packageCount, univerPackages: univer.length, ...summary.verdict, duplicates: duplicates.length, installScripts: installScripts.map((i) => i.pkg), byLicense }, null, 2));

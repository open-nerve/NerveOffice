// 对仓库现状执行不依赖网络与构建产物的门禁；产物与漏洞两个门禁的装配逻辑用临时目录与样例测试。
// 前一组会执行 pnpm、vitest、playwright 的列举命令，比其他单元测试慢。
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJson } from '../shared/repo.ts'
import { readFixture } from './fixtures.ts'
import { ARTIFACT_POLICY } from './policy.ts'
import { artifactsGate, auditGate, budgetsGate, GATE_NAMES, runGate } from './run.ts'

describe('US-M1-11 门禁对仓库现状通过', () => {
  it.each(['pins', 'config', 'stories', 'migrations', 'schema', 'deps', 'licenses'] as const)('%s', (name) => {
    const outcome = runGate(name)
    expect(outcome.violations).toEqual([])
    expect(outcome.name).toBe(name)
  })
}, 120_000)

describe('US-M1-11 门禁的快捷脚本', () => {
  it('根 package.json 为每个门禁提供 gate:<名称>，新增门禁时不会漏（审查 B23）', () => {
    const { scripts } = z.object({ scripts: z.record(z.string(), z.string()) }).parse(readJson('package.json'))
    for (const name of GATE_NAMES)
      expect(scripts[`gate:${name}`], name).toBe(`node tools/src/gates/cli.ts ${name}`)
  })
})

let dist: string | undefined

afterEach(() => {
  if (dist !== undefined)
    rmSync(dist, { recursive: true, force: true })
})

function writeDist(files: Record<string, string>): string {
  dist = mkdtempSync(join(tmpdir(), 'nerve-dist-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dist, dirname(path)), { recursive: true })
    writeFileSync(join(dist, path), content)
  }
  return dist
}

const clean = {
  'index.html': '<!doctype html><script type="module" src="/assets/index.js"></script>',
  'assets/index.js': 'const ns="http://www.w3.org/2000/svg";',
  '.vite/manifest.json': '{}',
  '.vite/third-party-packages.json': JSON.stringify([{ name: 'react', version: '19.3.0', license: 'MIT', licenseTextSource: 'package' }]),
  'THIRD-PARTY-LICENSES.md': '## react 19.3.0（MIT）\n\nhttps://github.com/facebook/react 的许可正文里有地址，不扫描\n',
}

describe('US-M1-11 产物门禁的装配', () => {
  it('合规：干净的产物', () => {
    expect(artifactsGate(writeDist(clean)).violations).toEqual([])
  })

  it('违规：没有构建产物', () => {
    expect(artifactsGate(join(tmpdir(), 'nerve-no-such-dist')).violations.map(v => v.rule)).toEqual(['artifacts/missing-build'])
  })

  it('违规：产物里的动态代码、.json 里的外部地址、未登记的文件类型、缺少许可清单', () => {
    const { '.vite/third-party-packages.json': _omitted, ...withoutBundle } = clean
    const outcome = artifactsGate(writeDist({ ...withoutBundle, 'assets/w.js': 'self.eval(x)', 'config.json': '{"endpoint":"https://evil.example.com"}', 'notes.md': '说明' }))
    expect(outcome.violations.map(v => v.rule).sort()).toEqual(['artifacts/address', 'artifacts/dynamic-code', 'artifacts/file-type', 'license-bundle/missing-file'])
  })

  it('说明列出出现的主机、主机在运行时拼出的地址、允许清单里这次没出现的地址与已登记的动态代码', () => {
    // 样例是产物里的模板字符串原文，不是要插值
    // eslint-disable-next-line no-template-curly-in-string
    const outcome = artifactsGate(writeDist({ ...clean, 'assets/index.js': 'const ns="http://www.w3.org/2000/svg";const u=`http://[${e}]`' }))
    expect(outcome.violations).toEqual([])
    expect(outcome.notes).toEqual(expect.arrayContaining([
      '出现的主机：www.w3.org×1；主机在运行时拼出的地址 1 处（由 CSP 兜底）',
      '已登记的动态代码（出现次数为 0 的登记已经过时，核对后删除）：zod 的 JIT 探测×0、zod 的 JIT 编译器×0；全局对象探测 0 处（上限 2）',
    ]))
    expect(outcome.notes.find(note => note.startsWith('允许清单里这次没出现的地址'))).toContain('http://localhost')
  })

  it('说明：没有出现地址时，主机写"无"', () => {
    const outcome = artifactsGate(writeDist({ ...clean, 'assets/index.js': 'export const x = 1' }))
    expect(outcome.notes).toContain('出现的主机：无；主机在运行时拼出的地址 0 处（由 CSP 兜底）')
  })

  /** 两个入口：平台页面与编辑器页（编辑器页创建公式 Worker、有一个动态加载的块；Worker 动态加载一个块） */
  function withEditor(files: Record<string, string>, manifest: Record<string, unknown> = {}): Record<string, string> {
    return {
      ...clean,
      '.vite/manifest.json': JSON.stringify({
        'index.html': { file: 'assets/index.js', isEntry: true },
        'editor.html': { file: 'assets/editor.js', isEntry: true, dynamicImports: ['src/lazy.ts'], assets: ['assets/formula.worker-a1b2c3d4.js'] },
        'src/lazy.ts': { file: 'assets/lazy.js' },
        ...manifest,
      }),
      'editor.html': '<!doctype html><script type="module" src="/assets/editor.js"></script>',
      'assets/editor.js': 'new Worker(new URL(`/assets/formula.worker-a1b2c3d4.js`,``+import.meta.url),{type:`module`})',
      'assets/formula.worker-a1b2c3d4.js': 'self.onmessage=()=>import("./worker-lazy-b2.js")',
      'assets/worker-lazy-b2.js': 'export const y=2',
      'assets/lazy.js': 'export const x=1',
      ...files,
    }
  }

  it('说明：允许清单里的地址都出现时（前缀的登记出现在编辑器的产物里），没出现的地址写"无"', () => {
    const exact = ARTIFACT_POLICY.allowedAddresses.filter(entry => entry.prefix !== true).map(entry => JSON.stringify(entry.address)).join(',')
    const prefixed = ARTIFACT_POLICY.allowedAddresses.filter(entry => entry.prefix === true).map(entry => JSON.stringify(`${entry.address}sample`)).join(',')
    const outcome = artifactsGate(writeDist(withEditor({ 'assets/index.js': `export const addresses = [${exact}]`, 'assets/lazy.js': `export const links = [${prefixed}]` })))
    expect(outcome.violations).toEqual([])
    expect(outcome.notes).toContain('允许清单里这次没出现的地址（核对后删除）：无')
  })

  it('前缀的登记只适用于编辑器页能加载到的产物与它创建的 Worker；平台页面与其他文件只按具体地址（审查 A 路建议 B1）', () => {
    const link = JSON.stringify(`${ARTIFACT_POLICY.allowedAddresses.find(entry => entry.prefix === true)?.address ?? ''}sample`)
    for (const file of ['assets/editor.js', 'assets/lazy.js', 'assets/formula.worker-a1b2c3d4.js', 'assets/worker-lazy-b2.js']) {
      const outcome = artifactsGate(writeDist(withEditor({ [file]: `${withEditor({})[file] ?? ''};export const link=${link}` })))
      expect(outcome.violations, file).toEqual([])
    }
    for (const file of ['assets/index.js', 'assets/other.js']) {
      const outcome = artifactsGate(writeDist(withEditor({ [file]: `export const link=${link}` })))
      expect(outcome.violations.map(v => v.rule), file).toEqual(['artifacts/address'])
    }
    // 找不到构建清单时一律只按具体地址
    const noManifest = artifactsGate(writeDist({ ...withEditor({ 'assets/editor.js': `export const link=${link}` }), '.vite/manifest.json': '{}' }))
    expect(noManifest.violations.map(v => v.rule)).toEqual(['artifacts/address'])
  })

  it('前缀的登记：平台页面也能加载到的块（例如两边共用的动态块）、清单里没有编辑器入口时的编辑器页，只按具体地址（复验 RA8）', () => {
    const link = JSON.stringify(`${ARTIFACT_POLICY.allowedAddresses.find(entry => entry.prefix === true)?.address ?? ''}sample`)
    const shared = artifactsGate(writeDist(withEditor({ 'assets/lazy.js': `export const link=${link}` }, {
      'index.html': { file: 'assets/index.js', isEntry: true, dynamicImports: ['src/lazy.ts'] },
    })))
    expect(shared.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    const noEditorEntry = artifactsGate(writeDist({
      ...withEditor({ 'editor.html': `<!doctype html><a href=${link}>帮助</a>` }),
      '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js', isEntry: true } }),
    }))
    expect(noEditorEntry.violations.map(v => v.rule)).toEqual(['artifacts/address'])
  })
})

describe('US-M1-11 体积预算门禁的装配', () => {
  /** 两个入口与编辑器页创建的公式 Worker */
  function dist(indexContent: string): string {
    return writeDist({
      '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js', isEntry: true }, 'editor.html': { file: 'assets/editor.js', isEntry: true, assets: ['assets/formula.worker-a1b2c3d4.js'] } }),
      'assets/index.js': indexContent,
      'assets/editor.js': 'new Worker(new URL(`/assets/formula.worker-a1b2c3d4.js`,``+import.meta.url),{type:`module`})',
      'assets/formula.worker-a1b2c3d4.js': 'self.onmessage=()=>{}',
    })
  }

  it('按构建清单与产物文件计算：小的产物通过；平台页面超出预算时违规', () => {
    expect(budgetsGate(dist('console.log(1)')).violations).toEqual([])
    // 随机数据几乎压缩不了：200 KiB 随机字节的 base64（约 273 KiB 文本）gzip 之后仍超过 180 KiB 的预算
    const random = randomBytes(200 * 1024).toString('base64')
    expect(budgetsGate(dist(random)).violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
  })

  it('编辑器页的入口没有引用公式 Worker：违规', () => {
    const noWorker = writeDist({
      '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js', isEntry: true }, 'editor.html': { file: 'assets/editor.js', isEntry: true } }),
      'assets/index.js': 'console.log(1)',
      'assets/editor.js': 'console.log(2)',
    })
    expect(budgetsGate(noWorker).violations.map(v => v.rule)).toEqual(['budgets/missing-worker'])
  })

  it('违规：没有构建清单', () => {
    expect(budgetsGate(join(tmpdir(), 'nerve-no-such-dist')).violations.map(v => v.rule)).toEqual(['budgets/missing-build'])
  })
})

describe('US-M1-11 漏洞门禁的装配', () => {
  it('生产依赖的漏洞失败，全部依赖的计数写进说明（真实输出）', () => {
    const report = readFixture('pnpm-12/audit-with-advisories.json')
    const outcome = auditGate(() => report, '2026-09-26')
    expect(outcome.violations.map(v => v.rule)).toEqual(['audit/advisory', 'audit/advisory', 'audit/advisory'])
    expect(outcome.notes[0]).toContain('critical 1')
  })

  it('pnpm 的输出结构不对时直接报错，不当作没有漏洞', () => {
    expect(() => auditGate(() => ({ advisories: {} }), '2026-09-26')).toThrow()
  })
})

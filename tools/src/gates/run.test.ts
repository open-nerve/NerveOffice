// 对仓库现状执行不依赖网络与构建产物的门禁；产物与漏洞两个门禁的装配逻辑用临时目录与样例测试。
// 前一组会执行 pnpm、vitest、playwright 的列举命令，比其他单元测试慢。
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFixture } from './fixtures.ts'
import { artifactsGate, auditGate, budgetsGate, runGate } from './run.ts'

describe('US-M1-11 门禁对仓库现状通过', () => {
  it.each(['pins', 'config', 'stories', 'migrations', 'schema', 'deps', 'licenses'] as const)('%s', (name) => {
    const outcome = runGate(name)
    expect(outcome.violations).toEqual([])
    expect(outcome.name).toBe(name)
  })
}, 120_000)

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
})

describe('US-M1-11 体积预算门禁的装配', () => {
  it('按构建清单与产物文件计算：小的产物通过；平台页面超出预算时违规', () => {
    const small = writeDist({ '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js' } }), 'assets/index.js': 'console.log(1)' })
    expect(budgetsGate(small).violations).toEqual([])
    // 随机数据几乎压缩不了：200 KiB 随机字节的 base64（约 273 KiB 文本）gzip 之后仍超过 180 KiB 的预算
    const random = randomBytes(200 * 1024).toString('base64')
    const large = writeDist({ '.vite/manifest.json': JSON.stringify({ 'index.html': { file: 'assets/index.js' } }), 'assets/index.js': random })
    expect(budgetsGate(large).violations.map(v => v.rule)).toEqual(['budgets/exceeded'])
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

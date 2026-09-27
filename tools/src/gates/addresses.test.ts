import { describe, expect, it } from 'vitest'
import { blankOut, crossOriginAddress, cssValues, decodeHtmlReferences, htmlValues, isRegexFlags, unescapeCss } from './addresses.ts'
import { INTERPOLATION_PLACEHOLDER } from './eval-and-function.ts'

const HOLE = INTERPOLATION_PLACEHOLDER

describe('US-M1-11 按浏览器的规则认出跨源地址（DEF-016，复验 RA2–RA4）', () => {
  it.each([
    ['//evil.example/x', 'https://evil.example/x'],
    [' \u0001//evil.example/x', 'https://evil.example/x'],
    ['\\\\evil.example/x', 'https://evil.example/x'],
    ['https:\\\\evil.example/x', 'https://evil.example/x'],
    ['wss:evil.example/x', 'wss://evil.example/x'],
    ['//u@evil.example/x', 'https://u@evil.example/x'],
    ['//%65vil.example/x', 'https://evil.example/x'],
    ['//ｅｖｉｌ.example/x', 'https://evil.example/x'],
    ['/\t/evil.example/x', 'https://evil.example/x'],
    ['//intranet/x', 'https://intranet/x'],
    ['//nas:443/x', 'https://nas/x'],
    ['http:/evil.example/x', 'http://evil.example/x'],
    ['//2130706433/x', 'https://127.0.0.1/x'],
    ['//[::1]:8080/x', 'https://[::1]:8080/x'],
    [`${HOLE}//evil.example/x`, 'https://evil.example/x'],
    [`${HOLE}\\\\evil.example/x`, 'https://evil.example/x'],
    [`//evil.example/${HOLE}`, `https://evil.example/${HOLE}`],
    [`https://${HOLE}/x`, `https://${HOLE}/x`],
  ])('地址：%j → %s', (value, expected) => {
    expect(crossOriginAddress(value)).toBe(expected)
  })

  it.each([
    ['同协议、不带斜杠：相对地址', 'https:evil.example/x'],
    ['开头是 U+FEFF：相对地址', '\uFEFF//evil.example/x'],
    ['正则的标志', '//g'],
    ['正则的标志（多个）', '//gim'],
    ['相对路径', '/api/x'],
    ['查不到地址的名字', '\\/*$'],
    ['查不到地址的名字（括号）', '//(.+)'],
    ['不是网络协议', 'mailto:a@example.com'],
    ['脚本协议', 'javascript:alert(1)'],
    ['ftp', 'ftp://evil.example/x'],
    ['只有两个斜杠', '//'],
    ['开头的插值后面不是两个斜杠', `${HOLE}/x`],
  ])('不是跨源地址：%s', (_case, value) => {
    expect(crossOriginAddress(value)).toBeUndefined()
  })

  it('正则的标志：两个斜杠之后只有标志', () => {
    expect(isRegexFlags('//gi')).toBe(true)
    expect(isRegexFlags('//go')).toBe(false)
    expect(isRegexFlags('//intranet')).toBe(false)
  })

  it('HTML 的字符引用：数字引用（分号可以省略）与会改变地址结构的命名引用；其他命名引用原样保留', () => {
    expect(decodeHtmlReferences('&#x2f;&#47&sol;&colon;&bsol;&Tab;&NewLine;&amp;&eacute;')).toBe('///:\\\t\n&&eacute;')
    expect(decodeHtmlReferences('&#0;&#x110000;')).toBe('\uFFFD\uFFFD')
  })

  it('样式的转义：十六进制（后面可以跟一个空白）与单个字符', () => {
    expect(unescapeCss('\\2f\\2f evil')).toBe('//evil')
    expect(unescapeCss('\\/\\/evil')).toBe('//evil')
    expect(unescapeCss('\\0 x')).toBe('\uFFFDx')
  })

  it('样式里的值：url() 的内容（带不带引号）与 url() 之外引号里的字符串，不重复', () => {
    const css = 'a{background:url( " //evil.example/a.png" )}@import "x.css";b{content:\'y\'}'
    expect(cssValues(css).map(item => item.value)).toEqual(['//evil.example/a.png', 'x.css', 'y'])
  })

  it('HTML 里的值：属性（解码之后）、srcset 的每个候选、style 属性与元素、meta refresh', () => {
    const html = '<img src=" &#47;/a.example/x" srcset="a.png 1x, //b.example/b.png 2x" style="background:url(//c.example/c.png)">'
      + '<meta http-equiv="refresh" content="0; url=\'//d.example/d\'"><style>e{background:url(//e.example/e.png)}</style>'
    expect(htmlValues(html).map(item => item.value)).toEqual([
      ' //a.example/x',
      'a.png',
      '//b.example/b.png',
      '//c.example/c.png',
      'refresh',
      '//d.example/d',
      '//e.example/e.png',
    ])
  })

  it('取出值之后剩下的文本：位置不变，重叠的范围只处理一次', () => {
    expect(blankOut('abcdefgh', [{ index: 1, end: 3 }, { index: 2, end: 5 }, { index: 7, end: 8 }])).toBe('a    fg ')
  })
})

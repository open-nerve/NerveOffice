import { describe, expect, it } from 'vitest'
import { htmlValues } from './html-values.ts'

/** 取出的值里带某个主机的（去重） */
function valuesWith(html: string, marker: string): string[] {
  return [...new Set(htmlValues(html).map(item => item.value).filter(value => value.includes(marker)))]
}

describe('US-M1-11 HTML 与 SVG 里可能是地址的值（parse5，复验 SA2、SA4）', () => {
  it.each([
    ['十六进制的字符引用', '<img src="&#x2f;&#x2f;evil.example/a.png">', '//evil.example/a.png'],
    ['前导零很多的数字引用', '<img src="&#00000000047;&#x000000002f;evil.example/a.png">', '//evil.example/a.png'],
    ['命名引用（冒号）', '<img src="https&colon;//evil.example/a.png">', 'https://evil.example/a.png'],
    ['命名引用组成的 IPv6', '<img src="//&lsqb;::1&rsqb;/a.png">', '//[::1]/a.png'],
    ['文字里的 x=" 不会吞掉后面的属性', '<p>x="</p><img src=//evil.example/b.png>', '//evil.example/b.png'],
    ['srcset 的第二个候选', '<img src="a.png" srcset="a.png 1x, //evil.example/b.png 2x">', '//evil.example/b.png'],
    ['ping 的第二个地址', '<a href="/" ping="/ok //evil.example/p">x</a>', '//evil.example/p'],
    ['SVG 的呈现属性里的 url()', '<svg><rect fill="url(//evil.example/f.svg#x)"/></svg>', '//evil.example/f.svg#x'],
    ['style 属性里命名引用组成的 url()', '<div style="background:url&lpar;//evil.example/l&rpar;"></div>', '//evil.example/l'],
    ['style 元素里转义的斜杠', '<style>a{background:url(\\/\\/evil.example/s.png)}</style>', '//evil.example/s.png'],
    ['iframe 的 srcdoc 里的 HTML', '<iframe srcdoc="&lt;img src=//evil.example/s&gt;"></iframe>', '//evil.example/s'],
    ['template 里的元素', '<template><img src="//evil.example/t.png"></template>', '//evil.example/t.png'],
  ])('%s', (_case, html, expected) => {
    expect(valuesWith(html, 'evil.example').concat(valuesWith(html, '[::1]'))).toContain(expected)
  })

  it.each([
    ['带引号、没有 url=', '<meta http-equiv="refresh" content="0; \'//evil.example/r\'">'],
    ['只有分号', '<meta http-equiv="refresh" content="0;//evil.example/r">'],
    ['逗号与反斜杠', '<meta http-equiv="refresh" content="0,\\\\evil.example/r">'],
    ['url= 两边有空白', '<meta http-equiv="refresh" content="0; url = //evil.example/r">'],
  ])('meta refresh 的地址（HTML 规范的声明式刷新步骤）：%s', (_case, html) => {
    const found = valuesWith(html, 'evil.example/r')
    expect(found.some(value => /^[\\/]{2}evil\.example\/r$/.test(value))).toBe(true)
  })

  it('位置是整个属性在原文里的范围', () => {
    const html = '<img alt="x" src="//evil.example/a.png">'
    const item = htmlValues(html).find(candidate => candidate.value === '//evil.example/a.png')
    expect(html.slice(item?.index, item?.end)).toBe('src="//evil.example/a.png"')
  })
})

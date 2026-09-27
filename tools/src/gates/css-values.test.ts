import { describe, expect, it } from 'vitest'
import { cssValues } from './css-values.ts'

function values(css: string): string[] {
  return cssValues(css).map(item => item.value)
}

describe('US-M1-11 样式里可能是地址的值（按 CSS 的分词规则，复验 SA2、SA4）', () => {
  it.each([
    ['不带引号的 url()', 'a{background:url(//evil.example/a.png)}', ['//evil.example/a.png']],
    ['url() 里的空白', 'a{background:url( //evil.example/a.png )}', ['//evil.example/a.png']],
    ['带引号的 url() 里有右括号', 'a{background:url("//evil.example/a)b")}', ['//evil.example/a)b']],
    ['转义的斜杠', 'a{background:url(\\/\\/evil.example/a.png)}', ['//evil.example/a.png']],
    ['十六进制的转义与其后的空白', 'a{background:url("\\2f\\2f evil.example/a.png")}', ['//evil.example/a.png']],
    ['转义出来的 url 函数名', 'a{background:u\\72l(//evil.example/a.png)}', ['//evil.example/a.png']],
    ['字符串里的续行', 'a{content:"a\\\nb"}', ['ab']],
    ['https 页面上跨协议、不带斜杠', 'a{background:url(http:evil.example/a.png)}', ['http:evil.example/a.png']],
  ])('%s', (_case, css, expected) => {
    expect(values(css)).toEqual(expected)
  })

  it('转义的引号与注释不会让后面的引号配错对', () => {
    expect(values('a{content:"\\""} b{background-image:image-set("//evil.example/x.png" 1x)}')).toEqual(['"', '//evil.example/x.png'])
    expect(values('/* " */ @import "//evil.example/a.css";')).toEqual(['//evil.example/a.css'])
  })

  it('坏的 url（中间有空白）不取，之后的照常', () => {
    expect(values('a{background:url(bad url.png)} b{x:url(//ok.example/y.png)}')).toEqual(['//ok.example/y.png'])
  })

  it('字符串在换行处结束（坏的字符串），照样取出已读到的部分', () => {
    expect(values('a{content:"//evil.example/x\n}')).toEqual(['//evil.example/x'])
  })

  it('位置是原文里的范围', () => {
    const css = 'a{b:url(//x.example/y)}'
    const [item] = cssValues(css)
    expect(css.slice(item?.index, item?.end)).toBe('url(//x.example/y)')
  })

  it('无效的转义：代码点 0、代理对与超出范围的换成 U+FFFD', () => {
    expect(values('a{content:"\\0 \\d800 \\110000"}')).toEqual(['\uFFFD\uFFFD\uFFFD'])
  })

  it('反斜杠后面是输入的结尾：合法的转义，得到 U+FFFD（复验 TA3）', () => {
    expect(values('a{background:url(//evil.example/h2.png\\')).toEqual(['//evil.example/h2.png\uFFFD'])
    expect(values('a{background:u\\')).toEqual([])
  })

  it('输入的预处理：NUL 与单独的代理项换成 U+FFFD，位置不变（复验 TA3）', () => {
    const css = 'a{background:url(//evil.example/n1\0.png)}'
    const [item] = cssValues(css)
    expect(item?.value).toBe('//evil.example/n1\uFFFD.png')
    expect(css.slice(item?.index, item?.end)).toBe('url(//evil.example/n1\0.png)')
    expect(values('a{background:url(//evil.example/s\uD800.png)}')).toEqual(['//evil.example/s\uFFFD.png'])
  })

  it('坏的 url 里转义的右括号不结束它，之后的 url() 照常取出', () => {
    expect(values('a{b:url(x y\\))} c{background:url(//evil.example/z)}')).toEqual(['//evil.example/z'])
  })
})

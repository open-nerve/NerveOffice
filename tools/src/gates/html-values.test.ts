import { describe, expect, it } from 'vitest'
import { htmlValues } from './html-values.ts'

/** 取出的值里带某个标记的（去重） */
function valuesWith(html: string, marker: string): string[] {
  return [...new Set(htmlValues(html).groups.flatMap(group => group.values).filter(value => value.includes(marker)))]
}

describe('US-M1-11 HTML 里可能是地址的值（parse5，复验 SA2、SA4、TA1、TA2、TA6）', () => {
  it.each([
    ['十六进制的字符引用', '<img src="&#x2f;&#x2f;evil.example/a.png">', '//evil.example/a.png'],
    ['前导零很多的数字引用', '<img src="&#00000000047;&#x000000002f;evil.example/a.png">', '//evil.example/a.png'],
    ['命名引用（冒号）', '<img src="https&colon;//evil.example/a.png">', 'https://evil.example/a.png'],
    ['命名引用组成的 IPv6', '<img src="//&lsqb;::1&rsqb;/a.png">', '//[::1]/a.png'],
    ['文字里的 x=" 不会吞掉后面的属性', '<p>x="</p><img src=//evil.example/b.png>', '//evil.example/b.png'],
    ['srcset 的第二个候选', '<img src="a.png" srcset="a.png 1x, //evil.example/b.png 2x">', '//evil.example/b.png'],
    ['ping 的第二个地址', '<a href="/" ping="/ok //evil.example/p">x</a>', '//evil.example/p'],
    ['SMIL 的 values 按分号分隔（复验 TA6）', '<svg><animate attributeName="href" values="/ok.png;//evil.example/e1.png"/></svg>', '//evil.example/e1.png'],
    ['SVG 的呈现属性里的 url()', '<svg><rect fill="url(//evil.example/f.svg#x)"/></svg>', '//evil.example/f.svg#x'],
    ['style 属性里命名引用组成的 url()', '<div style="background:url&lpar;//evil.example/l&rpar;"></div>', '//evil.example/l'],
    ['style 元素里转义的斜杠', '<style>a{background:url(\\/\\/evil.example/s.png)}</style>', '//evil.example/s.png'],
    ['iframe 的 srcdoc 里的 HTML', '<iframe srcdoc="&lt;img src=//evil.example/s&gt;"></iframe>', '//evil.example/s'],
    ['srcdoc 里的 srcdoc', '<iframe srcdoc="&lt;iframe srcdoc=&quot;&amp;lt;img src=//evil.example/n&amp;gt;&quot;&gt;"></iframe>', '//evil.example/n'],
    ['template 里的元素', '<template><img src="//evil.example/t.png"></template>', '//evil.example/t.png'],
    // 树构建丢掉的开始标签：parse5 按旧的规则丢掉 <select> 里的元素，浏览器保留（复验 TA2）
    ['select 里的 img', '<select><img src=//evil.example/d1.png></select>', '//evil.example/d1.png'],
    ['select 里 div 的 style', '<select><div style="background:url(//evil.example/d2.png)">x</div></select>', '//evil.example/d2.png'],
    ['重复的 body 并到第一个上的属性', '<body><p>x</p><body background="//evil.example/bg.png"></body>', '//evil.example/bg.png'],
    // SVG 的 <style> 被注释或元素拆成几段：浏览器连起来当样式（复验 TA6）
    ['SVG 样式里的注释', '<svg><style>@import u<!---->rl(//evil.example/b1.css);</style></svg>', '//evil.example/b1.css'],
    ['SVG 样式里的子元素', '<svg><style>@import u<g></g>rl(//evil.example/b2.css);</style></svg>', '//evil.example/b2.css'],
    ['SVG 样式里的 CDATA', '<svg><style><![CDATA[a{fill:url(//evil.exa]]>mple/c.svg)}</style></svg>', '//evil.example/c.svg'],
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

  it('原始文本与 RCDATA 里的文字不当作标签', () => {
    expect(valuesWith('<textarea><img src=//not-a-tag.example/x></textarea><title><img src=//not-a-tag.example/y></title>', 'not-a-tag')).toEqual([])
  })

  it('位置是整个属性在原文里的范围；调整过名字的属性（xlink:href、SVG 的大小写）按原文的名字找（复验 TA1）', () => {
    const html = '<img alt="x" src="//evil.example/a.png"><svg><image xlink:href="//evil.example/x.png"/><animate attributeName="href" values="//evil.example/v.png"/></svg>'
    const { groups } = htmlValues(html)
    for (const [value, attribute] of [['//evil.example/a.png', 'src="//evil.example/a.png"'], ['//evil.example/x.png', 'xlink:href="//evil.example/x.png"'], ['//evil.example/v.png', 'values="//evil.example/v.png"']]) {
      const group = groups.find(candidate => candidate.values[0] === value)
      expect(html.slice(group?.index, group?.end)).toBe(attribute)
    }
    expect(groups.find(group => group.values[0] === 'href')).toMatchObject({ index: html.indexOf('attributeName') })
  })

  it('每个属性各是一处：值取自同一个属性的才一起去重（复验 TA1）', () => {
    const { groups } = htmlValues('<img src="https://react.dev/errors/" srcset="https://react.dev/errors/ 2x, https://react.dev/evil-a2.png 1x">')
    expect(groups.map(group => group.values[0])).toEqual(['https://react.dev/errors/', 'https://react.dev/errors/ 2x, https://react.dev/evil-a2.png 1x'])
    expect(groups[1]?.values).toContain('https://react.dev/evil-a2.png')
  })

  it('style 元素里的值精确到各自的位置；SVG 的样式拼起来之后记在整个元素上', () => {
    const html = '<style>a{b:url(//x.example/y)}</style><svg><style>c{d:u<!---->rl(//z.example/w)}</style></svg>'
    const { groups } = htmlValues(html)
    const plain = groups.find(group => group.values[0] === '//x.example/y')
    expect(html.slice(plain?.index, plain?.end)).toBe('url(//x.example/y)')
    const svg = groups.find(group => group.values[0] === '//z.example/w')
    expect(html.slice(svg?.index, svg?.end)).toBe('<style>c{d:u<!---->rl(//z.example/w)}</style>')
  })

  it.each([
    ['select 里的 style', '<select><style>/* <!-- */</style><img src=//evil.example/x.png><!-- --></select>', 'style'],
    ['select 里的 svg', '<select><svg><style>@import u<!---->rl(//evil.example/a.css)</style></svg></select>', 'svg'],
    ['select 里的 textarea 之外的 RCDATA', '<select><title>x</title></select>', 'title'],
    ['select 里的 iframe', '<select><iframe srcdoc="x"></iframe></select>', 'iframe'],
  ])('状态切换的开始标签被 parse5 丢掉：浏览器可能按另一种状态分词，直接报出（fail closed，复验 TA2）：%s', (_case, html, tagName) => {
    const { problems } = htmlValues(html)
    expect(problems.map(problem => problem.detail)).toContainEqual(expect.stringContaining(`<${tagName}>`))
  })

  it('入口页常见的写法没有问题', () => {
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" /><title>x</title><script type="module" crossorigin src="/assets/a.js"></script><link rel="stylesheet" href="/assets/a.css"><style>a{b:c}</style><noscript>x</noscript></head><body><div id="root"></div><svg><title>t</title><style>a{}</style></svg><textarea>x</textarea></body></html>'
    expect(htmlValues(html).problems).toEqual([])
  })

  it('嵌套很深也不会栈溢出（复验 TA9）', () => {
    const html = `${'<div>'.repeat(20000)}<img src=//evil.example/deep.png>`
    expect(valuesWith(html, 'evil.example')).toContain('//evil.example/deep.png')
    const nested = Array.from({ length: 200 }).reduce<string>(inner => `<iframe srcdoc="${inner.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`, '<img src=//evil.example/n.png>')
    expect(valuesWith(nested, 'evil.example')).toContain('//evil.example/n.png')
  })
})

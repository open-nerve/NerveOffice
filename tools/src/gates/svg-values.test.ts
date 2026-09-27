import { describe, expect, it } from 'vitest'
import { svgValues } from './svg-values.ts'

function values(svg: string): string[] {
  return svgValues(svg).groups.flatMap(group => group.values)
}

describe('US-M1-11 SVG 文件里可能是地址的值（按 XML 解析，复验 TA6）', () => {
  it.each([
    ['属性里的字符引用', '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#47;&#47;evil.example/x.png"/></svg>', '//evil.example/x.png'],
    ['xlink:href', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="//evil.example/u.svg#a"/></svg>', '//evil.example/u.svg#a'],
    ['SMIL 的 values 按分号分隔', '<svg><animate attributeName="href" values="/ok.png;//evil.example/e1.png"/></svg>', '//evil.example/e1.png'],
    ['样式被注释拆开', '<svg><style>@import u<!---->rl(//evil.example/b1.css);</style></svg>', '//evil.example/b1.css'],
    ['样式里的 CDATA', '<svg><style><![CDATA[a{fill:url(//evil.exa]]>mple/c.svg)}</style></svg>', '//evil.example/c.svg'],
    ['样式里的字符引用', '<svg><style>a{fill:url(&#47;&#47;evil.example/r.svg)}</style></svg>', '//evil.example/r.svg'],
    // XML 里 <img> 不会跳出外来内容：之后的 <style> 仍是 SVG 的样式，注释照样去掉（按 HTML 解析时会变成原始文本）
    ['img 之后的样式', '<svg><img src="x"/><style>@import u<!---->rl(//evil.example/b3.css);</style></svg>', '//evil.example/b3.css'],
    ['带前缀的样式元素', '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:style>@import url(//evil.example/p.css);</s:style></s:svg>', '//evil.example/p.css'],
    ['XML 声明与开头的 BOM', '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<svg><image href="//evil.example/d.png"/></svg>', '//evil.example/d.png'],
  ])('%s', (_case, svg, expected) => {
    expect(values(svg)).toContain(expected)
    expect(svgValues(svg).problems).toEqual([])
  })

  it('XHTML 的 iframe 的 srcdoc 按 HTML 解析，值与问题记在所在的开始标签上（复验 UA1）', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><foreignObject><h:iframe srcdoc="&lt;img src=//evil.example/s1.png&gt;"/></foreignObject></svg>'
    const { groups } = svgValues(svg)
    const nested = groups.find(group => group.values.includes('//evil.example/s1.png'))
    expect(svg.slice(nested?.index, nested?.end)).toBe('<h:iframe srcdoc="&lt;img src=//evil.example/s1.png&gt;"/>')
    expect(values('<svg><h:iframe xmlns:h="http://www.w3.org/1999/xhtml" srcdoc="&lt;img src=&amp;#47;&amp;#47;evil.example/s2.png&gt;"/></svg>')).toContain('//evil.example/s2.png')
    const { problems } = svgValues('<svg><iframe srcdoc="&lt;select&gt;&lt;style&gt;a{}&lt;/style&gt;&lt;/select&gt;"/></svg>')
    expect(problems.map(problem => problem.detail)).toContainEqual(expect.stringContaining('<style>'))
  })

  it('XML 声明的编码不是 UTF-8：浏览器按它解码，直接报出（复验 UA5）', () => {
    expect(svgValues('<?xml version="1.0" encoding="Shift_JIS"?><svg/>').problems[0]?.detail).toContain('Shift_JIS')
    for (const encoding of ['UTF-8', 'utf-8', 'UTF8'])
      expect(svgValues(`<?xml version="1.0" encoding="${encoding}"?><svg/>`).problems).toEqual([])
  })

  // 输入很大（30 万个值，展开成参数时一定超出调用栈），给足时间
  it('一段样式里有几十万个值：逐个加入，不会超出调用栈（复验 UA6）', () => {
    expect(svgValues(`<svg><style>${'url(a)'.repeat(300000)}</style></svg>`).groups).toHaveLength(300000)
  }, 30_000)

  it('只取样式元素直接的文字：子元素里的文字不算', () => {
    expect(values('<svg><style>a{}<g>b{fill:url(//child.example/x)}</g></style></svg>')).not.toContain('//child.example/x')
  })

  it.each([
    ['DOCTYPE 里定义的实体（浏览器会展开）', '<!DOCTYPE svg [<!ENTITY e "&#47;&#47;evil.example/f1.css">]><svg><style>@import url(&e;);</style></svg>', 'DOCTYPE'],
    ['xml-stylesheet 处理指令', '<?xml-stylesheet href="//evil.example/x.css"?><svg/>', 'xml-stylesheet'],
    ['格式不正确', '<svg><g></svg>', '格式正确'],
    ['未定义的实体', '<svg><image href="&lsqb;"/></svg>', '格式正确'],
  ])('门禁无法确定的写法直接报出（fail closed）：%s', (_case, svg, marker) => {
    // 第一条是原因；DOCTYPE 里的实体没有展开，之后还会报未定义的实体
    const { problems } = svgValues(svg)
    expect(problems[0]?.detail).toContain(marker)
  })

  it('位置：属性记在所在的开始标签上，样式记在整个元素上', () => {
    const svg = '<svg><g/><image href="//x.example/a.png"/><style>a{b:url(//x.example/s)}</style></svg>'
    const { groups } = svgValues(svg)
    const attribute = groups.find(group => group.values[0] === '//x.example/a.png')
    expect(svg.slice(attribute?.index, attribute?.end)).toBe('<image href="//x.example/a.png"/>')
    const style = groups.find(group => group.values[0] === '//x.example/s')
    expect(svg.slice(style?.index, style?.end)).toBe('<style>a{b:url(//x.example/s)}</style>')
  })

  it('嵌套很深也不会栈溢出（复验 TA9）', () => {
    const svg = `<svg>${'<g>'.repeat(20000)}<image href="//evil.example/deep.png"/>${'</g>'.repeat(20000)}</svg>`
    expect(values(svg)).toContain('//evil.example/deep.png')
  })
})

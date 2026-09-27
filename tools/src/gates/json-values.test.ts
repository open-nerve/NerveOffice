import { describe, expect, it } from 'vitest'
import { jsonValues } from './json-values.ts'

describe('US-M1-11 JSON 里可能是地址的值（复验 RA4、SA2、TA7、TA9）', () => {
  it('每个字符串字面量（键与值）按顺序取出，位置是字面量在原文里的范围', () => {
    const json = '{"a\\/b": ["//evil.example/x", {"k": "https:\\/\\/evil.example\\/y"}], "n": 1}'
    const groups = jsonValues(json)?.groups ?? []
    expect(groups.map(group => group.values[0])).toEqual(['a/b', '//evil.example/x', 'k', 'https://evil.example/y', 'n'])
    expect(groups.map(group => json.slice(group.index, group.end))).toEqual(['"a\\/b"', '"//evil.example/x"', '"k"', '"https:\\/\\/evil.example\\/y"', '"n"'])
  })

  it('重复的键也算（JSON.parse 只留最后一个）', () => {
    expect(jsonValues('{"a": "//evil.example/first", "a": "ok"}')?.groups.map(group => group.values[0])).toContain('//evil.example/first')
  })

  it('嵌在字符串里的 HTML 与样式', () => {
    const [html, css] = jsonValues('["<img src=//evil.example/h.png>", "a{b:url(//evil.example/c.png)}"]')?.groups ?? []
    expect(html?.values).toContain('//evil.example/h.png')
    expect(css?.values).toContain('//evil.example/c.png')
  })

  it('嵌在字符串里的 HTML 有门禁无法确定的写法：报在这个字符串上', () => {
    const json = '{"x": "<select><style>a{}</style></select>"}'
    const problems = jsonValues(json)?.problems ?? []
    expect(problems.map(problem => problem.index)).toEqual([json.indexOf('"<select>')])
    expect(problems[0]?.detail).toContain('<style>')
  })

  it('开头的 BOM 不算：浏览器的 Response.json() 去掉它（复验 UA4）', () => {
    const json = '\uFEFF{"a":"\\/\\/evil.example/j1"}'
    const groups = jsonValues(json)?.groups ?? []
    expect(groups.map(group => group.values[0])).toEqual(['a', '//evil.example/j1'])
    expect(groups.map(group => json.slice(group.index, group.end))).toEqual(['"a"', '"\\/\\/evil.example/j1"'])
  })

  // 输入很大（30 万个值，展开成参数时一定超出调用栈），给足时间
  it('一个字符串里有几十万个值：逐个加入，不会超出调用栈（复验 UA6）', () => {
    const [group] = jsonValues(JSON.stringify(['url(a)'.repeat(300000)]))?.groups ?? []
    expect(group?.values.length).toBeGreaterThan(300000)
  }, 30_000)

  it('不是合法的 JSON：返回 undefined', () => {
    expect(jsonValues('{"a": ')).toBeUndefined()
  })

  it('线性：很多带地址的字符串、嵌套很深也不会变慢或栈溢出（复验 TA7、TA9）', () => {
    const many = JSON.stringify(Array.from({ length: 50000 }, (_, i) => `https://evil.example/${i}`))
    const start = performance.now()
    expect(jsonValues(many)?.groups).toHaveLength(50000)
    expect(performance.now() - start).toBeLessThan(2000)
    const deep = `${'['.repeat(20000)}"//evil.example/deep"${']'.repeat(20000)}`
    expect(jsonValues(deep)?.groups.map(group => group.values[0])).toEqual(['//evil.example/deep'])
  })
})

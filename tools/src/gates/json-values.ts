// JSON 文件里可能是地址的值（复验 RA4、SA2、SA7、TA7、TA9）：原文里的每个字符串字面量（键与值，重复的键也算）按出现的顺序线性地取出，
// 连同嵌在里面的 HTML 与样式。不解析成对象再逐层展开：那样要在原文里重新找每个字符串的位置（平方级，复验 TA7），嵌套很深时会栈溢出（复验 TA9）。
import type { ExtractedValues, LocatedValues, MarkupProblem } from './addresses.ts'
import { cssValues } from './css-values.ts'
import { htmlValues } from './html-values.ts'

/** 不是合法的 JSON 时返回 undefined：整个文件只按写法匹配 */
export function jsonValues(content: string): ExtractedValues | undefined {
  try {
    JSON.parse(content)
  }
  catch {
    return undefined
  }
  const groups: LocatedValues[] = []
  const problems: MarkupProblem[] = []
  // 合法的 JSON 里，字符串之外的双引号都是字符串的开头；字符串里的双引号都经过转义
  for (let index = content.indexOf('"'); index >= 0;) {
    let end = index + 1
    while (content[end] !== '"')
      end += content[end] === '\\' ? 2 : 1
    end += 1
    const text = JSON.parse(content.slice(index, end)) as string
    const values = [text]
    if (text.includes('<')) {
      const embedded = htmlValues(text)
      values.push(...embedded.groups.flatMap(group => group.values))
      problems.push(...embedded.problems.map(problem => ({ detail: problem.detail, index })))
    }
    if (text.includes('(') || text.includes('"') || text.includes('\''))
      values.push(...cssValues(text).map(item => item.value))
    groups.push({ values, index, end })
    index = content.indexOf('"', end)
  }
  return { groups, problems }
}

// 按标题搜索的关键词（M2-P4 设计 §3.4 第 5 条）：关键词整体是字面量，里面的通配符不当通配符用。
// 转义与 LIKE 的 ESCAPE 子句必须成对，所以两者放在一起，由仓储拼进语句。

/**
 * LIKE 的转义字符。虽然反斜杠也是 PostgreSQL 的默认值，语句里仍然显式写出 ESCAPE 子句，
 * 而且把它作为参数绑定进去：默认值将来变了，转义与语句也不会各说各话。
 */
export const TITLE_SEARCH_ESCAPE = '\\'

/** 关键词里要转义的字符：转义符自己、以及 LIKE 的两个通配符。 */
const ESCAPED = /[\\%_]/g

/**
 * 把关键词变成 LIKE 的模式：`\`、`%`、`_` 前面加上转义符，前后各加一个通配符（标题里包含关键词即可）。
 * 一次正则替换从左往右扫一遍，加进去的转义符不会被再扫一次，所以 `\%` 这种写法也是两个字面量字符。
 * 大小写不敏感由语句两边一起 lower() 做，不在这里：不同的排序规则下 JavaScript 与数据库的折叠结果不一定相同
 */
export function titleSearchPattern(keyword: string): string {
  return `%${keyword.replace(ESCAPED, character => `${TITLE_SEARCH_ESCAPE}${character}`)}%`
}

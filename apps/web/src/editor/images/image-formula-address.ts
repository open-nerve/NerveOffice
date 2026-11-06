import { isPlatformAssetAddress } from '@nerve-office/contracts'

const PREFIX = '/api/assets/'
const SPACE = new Set([' ', '\t', '\n', '\r'])
const NAME = /^[\p{L}\p{N}_.]$/u
/** 函数名与括号之间：SDK 对函数名 token 用 String.prototype.trim，去掉的就是这一类空白 */
const TRIMMED = /^\s$/u
/** SDK 去掉的函数名前缀（engine-formula 的 normalizeFunctionToken，大写比较、只去掉一个） */
const FUNCTION_PREFIXES = ['_XLFN.', '_XLWS.', '_XLETA.'] as const

/**
 * SDK 认作哪个函数（engine-formula 的 checkAndCreateNodeType 与 normalizeFunctionToken）：不区分大小写，去掉一个
 * _XLFN./_XLWS./_XLETA. 前缀。名字前的 @、- 是另外的前缀节点，扫描时本来就跳过（S14 审查 E2）
 */
function functionNameOf(token: string): string {
  const upper = token.toUpperCase()
  const prefix = FUNCTION_PREFIXES.find(candidate => upper.startsWith(candidate))
  return prefix === undefined ? upper : upper.slice(prefix.length)
}

interface Literal {
  /** 起止下标，含两端引号 */
  readonly start: number
  readonly end: number
  /** 按公式语义解码（"" 是一个引号）之后的值 */
  readonly value: string
}

/** 从 index 处的引号开始，按公式语义（引号以重复转义）找到收尾引号之后的下标；没有收尾时返回 undefined。 */
function closing(formula: string, index: number, quote: string): number | undefined {
  for (let at = index + 1; at < formula.length; at += 1) {
    if (formula.charAt(at) !== quote)
      continue
    if (formula.charAt(at + 1) === quote) {
      at += 1
      continue
    }
    return at + 1
  }
  return undefined
}

/** 结构化引用 [ … ] 整段跳过：可嵌套，' 转义下一个字符；没有收尾时返回 undefined。 */
function closingBracket(formula: string, index: number): number | undefined {
  let depth = 0
  for (let at = index; at < formula.length; at += 1) {
    const char = formula.charAt(at)
    if (char === '\'') {
      at += 1
    }
    else if (char === '[') {
      depth += 1
    }
    else if (char === ']') {
      depth -= 1
      if (depth === 0)
        return at + 1
    }
  }
  return undefined
}

function skipSpaces(formula: string, index: number): number {
  let at = index
  while (at < formula.length && SPACE.has(formula.charAt(at)))
    at += 1
  return at
}

/**
 * IMAGE( 之后的首参恰为字符串字面量（可包透明括号）时返回该字面量；否则返回 undefined。
 * 与固定 engine-formula 补丁的首参证明一致：引用、拼接、计算与名称都不是字面量，不在这里改写（P2-S3 §3）。
 */
function firstArgumentLiteral(formula: string, index: number): Literal | undefined {
  let at = skipSpaces(formula, index)
  let groups = 0
  while (formula.charAt(at) === '(') {
    groups += 1
    at = skipSpaces(formula, at + 1)
  }
  if (formula.charAt(at) !== '"')
    return undefined
  const end = closing(formula, at, '"')
  if (end === undefined)
    return undefined
  const literal = { start: at, end, value: formula.slice(at + 1, end - 1).replaceAll('""', '"') }
  at = skipSpaces(formula, end)
  for (; groups > 0; groups -= 1) {
    if (formula.charAt(at) !== ')')
      return undefined
    at = skipSpaces(formula, at + 1)
  }
  const next = formula.charAt(at)
  return next === ',' || next === ')' ? literal : undefined
}

/**
 * 把 IMAGE() 首参字符串字面量中的本站绝对平台地址改写为相对地址 `/api/assets/<id>`（M5R-I-03，D-02）。
 * 服务端只按相对地址建立图片引用；与浮动图片的同源绝对地址归一保持一致。其他字面量、工作表名、结构化引用
 * 和识别不了的写法一律原样保留——宁可不改，也不改动用户的普通文字。
 */
export function normalizeImageFormula(formula: string, origin: string): string {
  if (origin === '' || origin === 'null' || !formula.includes(`${origin}${PREFIX}`))
    return formula
  const edits: { readonly start: number, readonly end: number, readonly text: string }[] = []
  let index = 0
  while (index < formula.length) {
    const char = formula.charAt(index)
    if (char === '"' || char === '\'') {
      const end = closing(formula, index, char)
      if (end === undefined)
        return formula
      index = end
      continue
    }
    if (char === '[') {
      const end = closingBracket(formula, index)
      if (end === undefined)
        return formula
      index = end
      continue
    }
    if (!NAME.test(char)) {
      index += 1
      continue
    }
    let end = index
    while (end < formula.length && NAME.test(formula.charAt(end)))
      end += 1
    // 名字与括号之间可以有空白：SDK 去掉函数名两端的空白，`IMAGE (` 也是 IMAGE 调用
    let open = end
    while (open < formula.length && TRIMMED.test(formula.charAt(open)))
      open += 1
    if (functionNameOf(formula.slice(index, end)) === 'IMAGE' && formula.charAt(open) === '(') {
      const literal = firstArgumentLiteral(formula, open + 1)
      if (literal !== undefined && literal.value.startsWith(`${origin}/`) && isPlatformAssetAddress(literal.value, origin))
        edits.push({ start: literal.start, end: literal.end, text: `"${literal.value.slice(origin.length)}"` })
    }
    index = end
  }
  if (edits.length === 0)
    return formula
  let result = ''
  let last = 0
  for (const edit of edits) {
    result += formula.slice(last, edit.start) + edit.text
    last = edit.end
  }
  return result + formula.slice(last)
}

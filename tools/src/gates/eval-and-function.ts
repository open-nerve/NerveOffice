// A01 产物扫描：JS 产物里对 eval 与 Function 的每一处引用（审查 B3），以及以字符串为代码的定时器调用（Codex 评审 CX11）。
// eval 与 Function 这两个全局绑定是把字符串变成代码的入口。按写法匹配只认得出直接调用：先赋给变量（let e=Function; new e(code)）、
// 当作参数传出（Reflect.construct(Function, …)）、用下标从全局对象上取（globalThis["Function"]）都会漏掉，
// 字符串里的 "[object Function]" 反而会误报。所以按语法树找引用，只放过几种拿不到代码执行能力的用法。
// 定时器（setTimeout 等）平常都传函数，不能像 eval 那样把每一处引用都报出来：按语法树认"调用对象静态可知是定时器、
// 代码参数是字符串"的调用（见 stringTimerAt）；按写法匹配认不出 globalThis["setTimeout"](…)、Reflect.get(…)(…) 这类写法。
// 解析用 Vite 自带的解析器：与产出产物的打包器是同一套，不另加依赖。
import { parseSync } from 'vite'

export type EvalOrFunction = 'eval' | 'Function'

/** 引用的用法：调用、new、标签模板，或者当作值（赋给变量、当作参数、取 prototype 以外的属性、解构出来等）。 */
export type Usage = 'call' | 'new' | 'tag' | 'value'

export interface Reference {
  name: EvalOrFunction
  usage: Usage
  /** 在文件内容里的下标 */
  index: number
  /** 调用或 new 的参数都是字符串字面量时，参数的值（用来认出 Function('return this') 这类全局对象探测） */
  literalArguments?: readonly string[]
}

export type ScanOutcome = { references: Reference[] } | { error: string }

/**
 * JS 里可能写着地址的文字（DEF-016）：字符串的值（已处理转义）、模板字符串（插值写成 ${…}）、正则的原文与注释。
 * 按值识别地址，写法上的伪装（转义的斜杠、拼接、插值给出的协议）就藏不住。
 */
export interface TextValue {
  kind: 'string' | 'template' | 'regexp' | 'comment'
  text: string
  /** 在文件内容里的下标 */
  index: number
}

export type TimerName = 'setTimeout' | 'setInterval' | 'setImmediate'

/** 以字符串为代码的定时器调用（Codex 评审 CX11） */
export interface StringTimerCall {
  name: TimerName
  /** 调用在文件内容里的下标 */
  index: number
}

export type AnalysisOutcome = { references: Reference[], texts: TextValue[], stringTimers: StringTimerCall[] } | { error: string }

/** 模板字符串里插值的占位 ${…}：地址的识别把它当作运行时才有的一段 */
export const INTERPOLATION_PLACEHOLDER = `$\{…}`

interface SyntaxNode {
  type: string
  start: number
  [field: string]: unknown
}

interface Visit {
  node: SyntaxNode
  parent: SyntaxNode | undefined
  grandparent: SyntaxNode | undefined
  /** node 在 parent 的哪个字段里 */
  field: string
}

const NAMES: ReadonlySet<string> = new Set(['eval', 'Function'])

/** 这些字段里的标识符是名字（属性名、对象的键、标签、导入导出的名字），不是对全局绑定的引用；computed 为 true 时除外。 */
const NAME_FIELDS: Readonly<Record<string, readonly string[]>> = {
  MemberExpression: ['property'],
  Property: ['key'],
  MethodDefinition: ['key'],
  PropertyDefinition: ['key'],
  AccessorProperty: ['key'],
  LabeledStatement: ['label'],
  BreakStatement: ['label'],
  ContinueStatement: ['label'],
  ImportSpecifier: ['imported'],
  ExportSpecifier: ['exported'],
  ExportAllDeclaration: ['exported'],
  MetaProperty: ['meta', 'property'],
}

function isNode(value: unknown): value is SyntaxNode {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && 'start' in value && typeof value.start === 'number'
}

function isName(value: unknown): value is EvalOrFunction {
  return typeof value === 'string' && NAMES.has(value)
}

/** 字符串字面量或不带插值的模板字符串的值（已处理转义，例如 "\x65val" 就是 eval）。 */
function staticString(value: unknown): string | undefined {
  if (!isNode(value))
    return undefined
  if (value.type === 'Literal')
    return typeof value.value === 'string' ? value.value : undefined
  if (value.type !== 'TemplateLiteral' || !Array.isArray(value.expressions) || value.expressions.length > 0 || !Array.isArray(value.quasis))
    return undefined
  const quasi: unknown = value.quasis[0]
  const text = isNode(quasi) && typeof quasi.value === 'object' && quasi.value !== null && 'cooked' in quasi.value ? quasi.value.cooked : undefined
  return typeof text === 'string' ? text : undefined
}

/** 取属性的名字：a.b 的 b，a["b"] 的 b；下标不是字面量时为 undefined。私有字段（this.#eval）不是全局的属性，不算（复验 S6）。 */
function propertyName(member: SyntaxNode): string | undefined {
  if (member.computed === true)
    return staticString(member.property)
  if (!isNode(member.property) || member.property.type === 'PrivateIdentifier')
    return undefined
  return typeof member.property.name === 'string' ? member.property.name : undefined
}

function isReferencePosition({ parent, grandparent, field }: Visit): boolean {
  if (parent === undefined || parent.computed === true || !(NAME_FIELDS[parent.type] ?? []).includes(field))
    return true
  // 解构里的键是从对象上取出这个属性：const { Function: F } = globalThis
  return parent.type === 'Property' && grandparent?.type === 'ObjectPattern'
}

/** 定义成员名字的位置：类的成员、对象字面量的键（不是计算的键）。解构里的键是取出属性，不在此列。 */
const MEMBER_DEFINITIONS: ReadonlySet<string> = new Set(['MethodDefinition', 'PropertyDefinition', 'AccessorProperty'])

/**
 * 这个字符串不是按名字取属性，不算引用（复验 S6）：
 * - 成员访问的下标（a["eval"]）：成员访问本身已经算作引用，字符串不再重复计数；
 * - 对象字面量的键（{"eval": 1}，与 {eval: 1} 一致）、类成员的名字：只是定义一个名字；
 * - switch 的 case（case "Function":）：只拿来比较。
 */
function isNameOnlyString({ parent, grandparent, field }: Visit): boolean {
  if (parent === undefined)
    return false
  if (parent.type === 'MemberExpression')
    return field === 'property'
  if (parent.type === 'SwitchCase')
    return field === 'test'
  if (field !== 'key' || parent.computed === true)
    return false
  return MEMBER_DEFINITIONS.has(parent.type) || (parent.type === 'Property' && grandparent?.type === 'ObjectExpression')
}

/**
 * 这个节点引用的是 eval 还是 Function：
 * - 标识符本身；
 * - 任何对象上名为 eval、Function 的属性：全局对象可以先赋给别的名字（const g = globalThis; new g.Function(…)），
 *   也可以经 window.self、top、parent、frames 取到，按对象的写法认不全（复验 R5）；
 * - 内容恰好是 'eval'、'Function' 的字符串：Reflect.get(globalThis, "Function") 这类按名字取的写法里只剩字符串。
 * 生产产物里本来没有这几类写法；将来的依赖出现时，门禁报出来，确认后登记。
 */
function referencedName(visit: Visit): EvalOrFunction | undefined {
  const { node } = visit
  if (node.type === 'Identifier')
    return isName(node.name) && isReferencePosition(visit) ? node.name : undefined
  if (node.type === 'MemberExpression') {
    const name = propertyName(node)
    return isName(name) ? name : undefined
  }
  if (node.type === 'Literal' || node.type === 'TemplateLiteral') {
    const value = staticString(node)
    return isName(value) && !isNameOnlyString(visit) ? value : undefined
  }
  return undefined
}

/** 引用的用法；拿不到代码执行能力的用法返回 undefined。 */
function usageOf(parent: SyntaxNode, field: string): Usage | undefined {
  switch (parent.type) {
    case 'CallExpression':
      return field === 'callee' ? 'call' : 'value'
    case 'NewExpression':
      return field === 'callee' ? 'new' : 'value'
    // 标签模板里只有标签可能是引用（模板本身是另一个节点）
    case 'TaggedTemplateExpression':
      return 'tag'
    // 取 prototype 不会生成代码，例如 Function.prototype.call.bind(f)、Function.prototype.toString.call(f)
    case 'MemberExpression':
      return field === 'object' && propertyName(parent) === 'prototype' ? undefined : 'value'
    // 一元与二元运算（typeof、比较、instanceof 的右边等）只读取或比较它，交不出去；
    // 例外是 instanceof 的左边：它会被交给右边对象的 Symbol.hasInstance，算作传出
    case 'UnaryExpression':
      return undefined
    case 'BinaryExpression':
      return parent.operator === 'instanceof' && field === 'left' ? 'value' : undefined
    // case 的值只拿来与 switch 的条件比较（=== 的比较已经放过）
    case 'SwitchCase':
      return field === 'test' ? undefined : 'value'
    default:
      return 'value'
  }
}

function literalArguments(call: SyntaxNode): string[] | undefined {
  if (!Array.isArray(call.arguments))
    return undefined
  const values = call.arguments.map(staticString)
  return values.every((value): value is string => value !== undefined) ? values : undefined
}

/** 这个位置上对 eval 或 Function 的引用；不是引用，或者用法拿不到代码执行能力时为 undefined。 */
function referenceAt(visit: Visit): Reference | undefined {
  // 引用总在某个表达式或声明里，只有根节点（Program）没有父节点
  const { parent } = visit
  const name = parent === undefined ? undefined : referencedName(visit)
  if (parent === undefined || name === undefined)
    return undefined
  const usage = usageOf(parent, visit.field)
  if (usage === undefined)
    return undefined
  const invoked = usage === 'call' || usage === 'new' ? literalArguments(parent) : undefined
  return { name, usage, index: visit.node.start, ...(invoked === undefined ? {} : { literalArguments: invoked }) }
}

const TIMERS: ReadonlySet<string> = new Set(['setTimeout', 'setInterval', 'setImmediate'])

function isTimer(value: unknown): value is TimerName {
  return typeof value === 'string' && TIMERS.has(value)
}

/** 可选链的外壳去掉之后的表达式：(a?.b)(…) 的调用对象是包着 a?.b 的 ChainExpression */
function withoutChain(node: unknown): unknown {
  return isNode(node) && node.type === 'ChainExpression' ? node.expression : node
}

/** Reflect 上名为 method 的方法：Reflect.get、globalThis.Reflect.get、Reflect["apply"] 这类写法 */
function isReflectMethod(callee: unknown, method: string): boolean {
  const member = withoutChain(callee)
  if (!isNode(member) || member.type !== 'MemberExpression' || propertyName(member) !== method)
    return false
  const object = withoutChain(member.object)
  return isNode(object) && ((object.type === 'Identifier' && object.name === 'Reflect') || (object.type === 'MemberExpression' && propertyName(object) === 'Reflect'))
}

/**
 * 这个表达式静态地就是一个定时器：标识符；属性名静态可知的成员访问（任何对象上的同名属性都算，与 eval、Function 的口径一致，
 * 包括计算的字符串下标 globalThis["setTimeout"]）；逗号表达式的最后一项；Reflect.get(任何对象, "定时器名") 的结果
 */
function timerOf(node: unknown): TimerName | undefined {
  let expression = withoutChain(node)
  // 逗号表达式的值是最后一项；嵌套的逗号表达式逐层取（不递归）
  while (isNode(expression) && expression.type === 'SequenceExpression' && Array.isArray(expression.expressions))
    expression = withoutChain(expression.expressions.at(-1))
  if (!isNode(expression))
    return undefined
  switch (expression.type) {
    case 'Identifier':
      return isTimer(expression.name) ? expression.name : undefined
    case 'MemberExpression': {
      const name = propertyName(expression)
      return isTimer(name) ? name : undefined
    }
    case 'CallExpression': {
      if (!isReflectMethod(expression.callee, 'get') || !Array.isArray(expression.arguments))
        return undefined
      const name = staticString(expression.arguments[1])
      return isTimer(name) ? name : undefined
    }
    default:
      return undefined
  }
}

/**
 * 值一定是字符串的表达式：字符串字面量、模板字符串（带插值的也是字符串）、有一侧是字符串的 + 拼接。
 * 拼接里任何一处是字符串，整个拼接的结果就是字符串；很长的拼接在语法树里很深，用显式的栈，不递归
 */
function isStringExpression(node: unknown): boolean {
  const pending: unknown[] = [node]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (!isNode(current))
      continue
    if ((current.type === 'Literal' && typeof current.value === 'string') || current.type === 'TemplateLiteral')
      return true
    if (current.type === 'BinaryExpression' && current.operator === '+')
      pending.push(current.left, current.right)
  }
  return false
}

/** 数组字面量的第一项是字符串：.apply 与 Reflect.apply 的参数列表 */
function firstElementIsString(node: unknown): boolean {
  return isNode(node) && node.type === 'ArrayExpression' && Array.isArray(node.elements) && isStringExpression(node.elements[0])
}

/**
 * 以字符串为代码的定时器调用（Codex 评审 CX11）：
 * - 调用对象是定时器（见 timerOf），代码是第一个参数：setTimeout("…")、globalThis["setTimeout"]("…")、(0,setTimeout)("…")、
 *   Reflect.get(globalThis,"setTimeout")("…")；
 * - 定时器的 .call(thisArg, 代码) 与 .apply(thisArg, [代码])；Reflect.apply(定时器, thisArg, [代码])。
 * 静态判断不了的由没有 'unsafe-eval' 的 CSP 兜底：经变量的别名（const t=setTimeout; t("…")）、运行时才算出的名字
 * （globalThis["set"+name]）、代码参数是变量（setTimeout(code)）。
 */
function stringTimerAt(node: SyntaxNode): StringTimerCall | undefined {
  if (node.type !== 'CallExpression' || !Array.isArray(node.arguments))
    return undefined
  const args: unknown[] = node.arguments
  const found = (name: TimerName | undefined, isCode: boolean): StringTimerCall | undefined => (name !== undefined && isCode ? { name, index: node.start } : undefined)
  const direct = timerOf(node.callee)
  if (direct !== undefined)
    return found(direct, isStringExpression(args[0]))
  const callee = withoutChain(node.callee)
  if (!isNode(callee) || callee.type !== 'MemberExpression')
    return undefined
  const method = propertyName(callee)
  if (method === 'call')
    return found(timerOf(callee.object), isStringExpression(args[1]))
  if (method !== 'apply')
    return undefined
  return isReflectMethod(callee, 'apply') ? found(timerOf(args[0]), firstElementIsString(args[2])) : found(timerOf(callee.object), firstElementIsString(args[1]))
}

function visitChildren(visit: Visit, stack: Visit[]): void {
  for (const [field, value] of Object.entries(visit.node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child))
        stack.push({ node: child, parent: visit.node, grandparent: visit.parent, field })
    }
  }
}

function cookedText(element: unknown): string {
  if (!isNode(element) || typeof element.value !== 'object' || element.value === null)
    return ''
  const { cooked, raw } = element.value as { cooked?: unknown, raw?: unknown }
  // 带非法转义的标签模板没有 cooked，用原文
  return typeof cooked === 'string' ? cooked : typeof raw === 'string' ? raw : ''
}

/** 这个节点写着的文字：字符串的值、模板字符串（插值写成占位）、正则的原文。 */
function textAt(node: SyntaxNode): TextValue | undefined {
  if (node.type === 'Literal') {
    if (typeof node.value === 'string')
      return { kind: 'string', text: node.value, index: node.start }
    const regex = node.regex as { pattern?: unknown } | undefined
    return typeof regex?.pattern === 'string' ? { kind: 'regexp', text: regex.pattern, index: node.start } : undefined
  }
  if (node.type === 'TemplateLiteral' && Array.isArray(node.quasis))
    return { kind: 'template', text: node.quasis.map(cookedText).join(INTERPOLATION_PLACEHOLDER), index: node.start }
  return undefined
}

/**
 * content 是一个 JS 文件（ES 模块或脚本）：对 eval 与 Function 的引用、以字符串为代码的定时器调用，以及可能写着地址的文字。
 * 解析失败时返回错误，由调用方按违规处理，不当作没有引用。
 */
export function analyzeJavaScript(content: string): AnalysisOutcome {
  const { program, comments, errors } = parseSync('artifact.js', content, { lang: 'js', sourceType: 'unambiguous', preserveParens: false })
  if (errors.length > 0 || !isNode(program))
    return { error: errors.map(error => error.message).join('；') || '解析结果不是语法树' }
  // 解构的简写（const { Function } = globalThis）里键与值是同一个位置，按位置去重
  const references = new Map<number, Reference>()
  const stringTimers: StringTimerCall[] = []
  const texts: TextValue[] = comments.map(comment => ({ kind: 'comment', text: comment.value, index: comment.start }))
  // 显式的栈：压缩后的代码可能有很深的表达式（例如很长的字符串拼接），递归会耗尽调用栈
  const stack: Visit[] = [{ node: program, parent: undefined, grandparent: undefined, field: '' }]
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    visitChildren(visit, stack)
    const reference = referenceAt(visit)
    if (reference !== undefined && !references.has(reference.index))
      references.set(reference.index, reference)
    const timer = stringTimerAt(visit.node)
    if (timer !== undefined)
      stringTimers.push(timer)
    const text = textAt(visit.node)
    if (text !== undefined)
      texts.push(text)
  }
  return {
    references: [...references.values()].sort((a, b) => a.index - b.index),
    texts: texts.sort((a, b) => a.index - b.index),
    stringTimers: stringTimers.sort((a, b) => a.index - b.index),
  }
}

/** 只要对 eval 与 Function 的引用。 */
export function findEvalAndFunction(content: string): ScanOutcome {
  const outcome = analyzeJavaScript(content)
  return 'error' in outcome ? outcome : { references: outcome.references }
}

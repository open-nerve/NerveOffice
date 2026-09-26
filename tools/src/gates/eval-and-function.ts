// A01 产物扫描：JS 产物里对 eval 与 Function 的每一处引用（审查 B3）。
// 这两个全局绑定是把字符串变成代码的入口。按写法匹配只认得出直接调用：先赋给变量（let e=Function; new e(code)）、
// 当作参数传出（Reflect.construct(Function, …)）、用下标从全局对象上取（globalThis["Function"]）都会漏掉，
// 字符串里的 "[object Function]" 反而会误报。所以按语法树找引用，只放过几种拿不到代码执行能力的用法。
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

function visitChildren(visit: Visit, stack: Visit[]): void {
  for (const [field, value] of Object.entries(visit.node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child))
        stack.push({ node: child, parent: visit.node, grandparent: visit.parent, field })
    }
  }
}

/** content 是一个 JS 文件（ES 模块或脚本）。解析失败时返回错误，由调用方按违规处理，不当作没有引用。 */
export function findEvalAndFunction(content: string): ScanOutcome {
  const { program, errors } = parseSync('artifact.js', content, { lang: 'js', sourceType: 'unambiguous', preserveParens: false })
  if (errors.length > 0 || !isNode(program))
    return { error: errors.map(error => error.message).join('；') || '解析结果不是语法树' }
  // 解构的简写（const { Function } = globalThis）里键与值是同一个位置，按位置去重
  const references = new Map<number, Reference>()
  // 显式的栈：压缩后的代码可能有很深的表达式（例如很长的字符串拼接），递归会耗尽调用栈
  const stack: Visit[] = [{ node: program, parent: undefined, grandparent: undefined, field: '' }]
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    visitChildren(visit, stack)
    const reference = referenceAt(visit)
    if (reference !== undefined && !references.has(reference.index))
      references.set(reference.index, reference)
  }
  return { references: [...references.values()].sort((a, b) => a.index - b.index) }
}

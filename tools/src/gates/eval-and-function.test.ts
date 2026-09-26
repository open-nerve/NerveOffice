import type { Reference } from './eval-and-function.ts'
import { describe, expect, it } from 'vitest'
import { findEvalAndFunction } from './eval-and-function.ts'

function references(code: string): Reference[] {
  const outcome = findEvalAndFunction(code)
  if ('error' in outcome)
    throw new Error(`样例解析失败：${outcome.error}`)
  return outcome.references
}

function usages(code: string): string[] {
  return references(code).map(r => `${r.name} ${r.usage}`)
}

describe('US-M1-11 A01 产物里 eval 与 Function 的引用（语法树）', () => {
  it.each([
    ['直接调用', 'eval("1+1")', ['eval call']],
    ['可选调用', 'eval?.(code)', ['eval call']],
    ['new Function', 'new Function("a","return a")', ['Function new']],
    ['不带括号的 new Function', 'new Function', ['Function new']],
    ['标签模板', 'Function`return 1`', ['Function tag']],
    ['标识符里的转义', '\\u0065val(code)', ['eval call']],
    ['全局对象上的属性', 'globalThis.eval(code);window.Function("x");self.eval?.(c);this.eval(c)', ['eval call', 'Function call', 'eval call', 'eval call']],
    ['任何对象用字符串下标取', 'a["eval"](c);b[`Function`]("x");self["\\x65val"](c)', ['eval call', 'Function call', 'eval call']],
  ])('调用：%s', (_case, code, expected) => {
    expect(usages(code)).toEqual(expected)
  })

  it.each([
    ['先赋给变量再 new（审查 B3）', 'let F=Function;new F(code)'],
    ['先赋给变量再调用', 'const F=Function;F("x")()'],
    ['全局对象上的 Function 赋给变量', 'const F=globalThis.Function;F(code)()'],
    ['用下标从全局对象上取', 'const F=window["Function"]'],
    ['Reflect.construct 的参数', 'Reflect.construct(Function,["x"])'],
    ['apply、call、bind', 'Function.apply(null,["x"])'],
    ['逗号表达式里的间接 eval', '(0,eval)(code)'],
    ['eval 赋给变量', 'const e=eval;e(code)'],
    ['放进数组', '[eval][0](code)'],
    ['当作参数传出', 'run(eval)'],
    ['逻辑表达式', 'x=y||Function'],
    ['从全局对象解构', 'const {Function:F}=globalThis'],
    ['解构的简写（键与值同一个位置，只算一次）', 'const {eval}=self'],
    ['instanceof 的左边（会交给右边的 Symbol.hasInstance）', 'Function instanceof X'],
    ['计算属性的键', 'o[Function]=1'],
  ])('当作值引用：%s', (_case, code) => {
    expect(usages(code)).toHaveLength(1)
    expect(references(code)[0]?.usage).toBe('value')
  })

  it('apply、call、bind 都拿到了构造函数本身', () => {
    expect(usages('Function.apply(null,["x"]);Function.call(null,"x");Function.bind(null,"x")()')).toEqual(['Function value', 'Function value', 'Function value'])
  })

  it.each([
    ['名字里含 Function 或 eval 的标识符', 'isFunction(x);b.myFunction("x");obj.eval2=1;a.evaluate(x)'],
    ['字符串与模板里的字样', 'const t="[object Function]";const u=\'AsyncFunction\';const v=`GeneratorFunction eval(x)`'],
    ['typeof、instanceof 的右边与相等比较', 'typeof x==="function";x instanceof Function;typeof Function;f===Function;g!=eval'],
    ['取 prototype', 'Function.prototype.call.bind(f);Function.prototype.toString.call(f);Function["prototype"];window.Function.prototype'],
    ['其他对象上的同名属性与方法', 'node.eval(scope);obj.Function(x)'],
    ['对象的键、方法名与类的成员', '({Function:1,eval(){}});class A{eval(){}static Function=1}'],
    ['注释与正则字面量', '/* eval(x) Function(y) */ /Function\\(/.test(s)'],
  ])('不算引用：%s', (_case, code) => {
    expect(references(code)).toEqual([])
  })

  it('调用的参数都是字符串字面量时给出参数的值（识别全局对象探测与空探测）', () => {
    expect(references('Function("return this")()')[0]?.literalArguments).toEqual(['return this'])
    expect(references('Function(``)')[0]?.literalArguments).toEqual([''])
    expect(references('Function(code)')[0]?.literalArguments).toBeUndefined()
    // 样例是带插值的模板字符串原文，不是要插值
    // eslint-disable-next-line no-template-curly-in-string
    expect(references('Function(`a${b}`)')[0]?.literalArguments).toBeUndefined()
  })

  it('位置是字符下标：中文与表情符号之后也对得上', () => {
    const code = 'const s="请求失败😀";const F=Function'
    expect(references(code).map(r => code.slice(r.index, r.index + 8))).toEqual(['Function'])
  })

  it('很深的表达式（很长的拼接）不会耗尽调用栈', () => {
    const code = `x=${Array.from({ length: 20_000 }).fill('a').join('+')}+Function`
    expect(usages(code)).toEqual(['Function value'])
  })

  it('解析失败时返回错误，不当作没有引用', () => {
    expect(findEvalAndFunction('let x = ;')).toHaveProperty('error')
  })
})

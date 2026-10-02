import type { Reference } from './eval-and-function.ts'
import { describe, expect, it } from 'vitest'
import { analyzeJavaScript, findEvalAndFunction } from './eval-and-function.ts'

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
    ['new 的参数', 'new Proxy(Function,{})'],
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

  // 全局对象可以先赋给别的名字，也可以经 window.self、top、parent、frames 取到；按名字取时只剩字符串（复验 R5）
  it.each([
    ['全局对象的别名', 'const g=globalThis;new g.Function("x")', ['Function new']],
    ['window 的别名', 'var w=window;w.eval(code)', ['eval call']],
    ['多级引用', 'window.self.Function("x");globalThis.window.eval(c)', ['Function call', 'eval call']],
    ['其他窗口对象', 'top.eval(c);parent.Function("x");frames.eval(c)', ['eval call', 'Function call', 'eval call']],
    ['任何对象上的同名属性与方法', 'node.eval(scope);obj.Function(x)', ['eval call', 'Function call']],
    ['按名字取：Reflect.get', 'Reflect.get(globalThis,"Function")', ['Function value']],
    ['按名字取：属性描述', 'Object.getOwnPropertyDescriptor(globalThis,\'eval\')', ['eval value']],
    ['名字先放进变量', 'const k=`Function`;globalThis[k]("x")', ['Function value']],
    ['字符串下标只算一次（成员访问本身已经算了）', 'a["eval"](c)', ['eval call']],
    ['解构里字符串写的键：是从对象上取出这个属性', 'const {"Function":F}=globalThis', ['Function value']],
    ['计算键里的字符串', '({["eval"]:1})', ['eval value']],
  ])('别名与按名字取：%s', (_case, code, expected) => {
    expect(usages(code)).toEqual(expected)
  })

  it('apply、call、bind 都拿到了构造函数本身', () => {
    expect(usages('Function.apply(null,["x"]);Function.call(null,"x");Function.bind(null,"x")()')).toEqual(['Function value', 'Function value', 'Function value'])
  })

  it.each([
    ['名字里含 Function 或 eval 的标识符', 'isFunction(x);b.myFunction("x");obj.eval2=1;a.evaluate(x)'],
    ['字符串与模板里的字样（不是恰好这两个名字）', 'const t="[object Function]";const u=\'AsyncFunction\';const v=`GeneratorFunction eval(x)`;const w="function";const x="evaluate"'],
    ['typeof、instanceof 的右边与相等比较', 'typeof x==="function";x instanceof Function;typeof Function;f===Function;g!=eval'],
    ['其他一元与二元运算', 'const a=!eval,b=+Function,c="call" in Function,d=Function+""'],
    ['取 prototype', 'Function.prototype.call.bind(f);Function.prototype.toString.call(f);Function["prototype"];window.Function.prototype'],
    ['对象的键、方法名与类的成员', '({Function:1,eval(){}});class A{eval(){}static Function=1}'],
    // 只是定义名字或拿来比较，不是按名字取属性（复验 S6）
    ['字符串写的对象键与类成员名', '({"eval":1,\'Function\':2});class B{"eval"(){}static "Function"=1}'],
    ['switch 的 case', 'switch(t){case "Function":break;case Function:break}'],
    ['私有字段', 'class C{#eval=1;#Function(){}m(){return this.#eval+this.#Function()}}'],
    ['注释与正则字面量', '/* eval(x) Function(y) */ /Function\\(/.test(s)'],
  ])('不算引用：%s', (_case, code) => {
    expect(references(code)).toEqual([])
  })

  it('调用的参数都是字符串字面量时给出参数的值（识别全局对象探测与空探测）', () => {
    expect(references('Function("return this")()')[0]?.literalArguments).toEqual(['return this'])
    expect(references('Function(``)')[0]?.literalArguments).toEqual([''])
    expect(references('Function(code)')[0]?.literalArguments).toBeUndefined()
    // eslint-disable-next-line no-template-curly-in-string -- 样例是带插值的模板字符串原文，不是要插值
    expect(references('Function(`a${b}`)')[0]?.literalArguments).toBeUndefined()
  })

  it('位置是字符下标：中文与表情符号之后也对得上', () => {
    const code = 'const s="请求失败😀";const F=Function'
    expect(references(code).map(r => code.slice(r.index, r.index + 8))).toEqual(['Function'])
  })

  it('很深的表达式（很长的拼接）不会耗尽调用栈', () => {
    // 左结合的拼接里，最左边的操作数在语法树的最深处
    const code = `x=f(Function)+${Array.from({ length: 20_000 }).fill('a').join('+')}`
    expect(usages(code)).toEqual(['Function value'])
  })

  it('解析失败时返回错误，不当作没有引用', () => {
    expect(findEvalAndFunction('let x = ;')).toHaveProperty('error')
  })
})

describe('US-M1-11 A01 以字符串为代码的定时器调用（语法树，Codex 评审 CX11）', () => {
  function timers(code: string): string[] {
    const outcome = analyzeJavaScript(code)
    if ('error' in outcome)
      throw new Error(`样例解析失败：${outcome.error}`)
    return outcome.stringTimers.map(timer => timer.name)
  }

  it.each([
    // Vite 压缩之后的原文：按写法匹配认不出（门禁原来放过）
    ['压缩之后的 Reflect.get（Codex 的样例）', 'Reflect.get(globalThis,`setTimeout`)(`globalThis.codexGateProof = 1`,0)', ['setTimeout']],
    ['直接调用', 'setTimeout("alert(1)",10);setInterval(\'tick()\',10);setImmediate(`x`)', ['setTimeout', 'setInterval', 'setImmediate']],
    ['全局对象上的属性与可选调用', 'window.setTimeout("x",1);globalThis?.setTimeout?.("x")', ['setTimeout', 'setTimeout']],
    ['计算的字符串下标', 'globalThis["setTimeout"]("alert(1)",0);self[`setInterval`](`x`)', ['setTimeout', 'setInterval']],
    ['逗号表达式的最后一项', '(0,setTimeout)("x");(0,(1,window.setInterval))("x")', ['setTimeout', 'setInterval']],
    ['可选链的外壳', '(globalThis?.setTimeout)("x")', ['setTimeout']],
    ['Reflect.get 的各种写法', 'globalThis.Reflect.get(self,"setInterval")("x");Reflect["get"](window,"setTimeout")("x")', ['setInterval', 'setTimeout']],
    ['.call 与 .apply', 'setTimeout.call(null,"x");window.setTimeout.apply(window,["x",1])', ['setTimeout', 'setTimeout']],
    ['Reflect.apply', 'Reflect.apply(setTimeout,null,["x"])', ['setTimeout']],
    // eslint-disable-next-line no-template-curly-in-string -- 样例是带插值的模板字符串原文，不是要插值
    ['代码是拼接的字符串或带插值的模板', 'setTimeout("a"+b);setTimeout(b+(c+"a"));setTimeout(`a${b}`)', ['setTimeout', 'setTimeout', 'setTimeout']],
  ])('认得出：%s', (_case, code, expected) => {
    expect(timers(code)).toEqual(expected)
  })

  it.each([
    ['参数是函数', 'setTimeout(()=>{},0);setTimeout(function(){},1);window.setTimeout(fn,2);setInterval(tick,10)'],
    ['不是定时器的调用带着字符串参数', 'log("setTimeout");obj.set("x");timer.start("x");Reflect.get(o,"fetch")("x")'],
    ['.call 的第一个参数是 this，不是代码', 'setTimeout.call("x",fn)'],
    ['.apply 的参数列表里第一项不是字符串', 'setTimeout.apply(null,[fn,"x"])'],
    ['数值相加不是字符串', 'setTimeout(a+1)'],
    // 静态判断不了的边界：由没有 unsafe-eval 的 CSP 兜底（文件开头与 artifacts.ts 的说明）
    ['代码是变量', 'setTimeout(code,0)'],
    ['经变量的别名', 'const t=setTimeout;t("x")'],
    ['运行时才算出的名字', 'globalThis["set"+name]("x")'],
  ])('不算：%s', (_case, code) => {
    expect(timers(code)).toEqual([])
  })

  it('位置是调用开头的字符下标', () => {
    const code = 'const s="请求失败😀";Reflect.get(globalThis,"setTimeout")("x")'
    const outcome = analyzeJavaScript(code)
    expect('error' in outcome ? [] : outcome.stringTimers.map(timer => code.slice(timer.index, timer.index + 11))).toEqual(['Reflect.get'])
  })

  it('代码是很长的拼接时不会耗尽调用栈', () => {
    expect(timers(`setTimeout(${Array.from({ length: 20_000 }).fill('a').join('+')}+"x")`)).toEqual(['setTimeout'])
  })
})

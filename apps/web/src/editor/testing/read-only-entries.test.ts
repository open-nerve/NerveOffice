// 只读入口的共用清单（read-only-entries.ts）：提示的说法与语言包一致；每个 Facade 入口的调用只用参数（E2E 把它序列化到页面里执行），
// 序列化之后照样调得到它要调的 Facade；写公式的 mutation 写的就是登记的那一格。
import { describe, expect, it } from 'vitest'
import { READ_ONLY_PERMISSION_TEXTS } from '../profile/locale.ts'
import { ANY_READ_ONLY_ALERT, FACADE_ENTRIES, FORMULA_MUTATION_CELL, FORMULA_MUTATION_ID, READ_ONLY_ALERT, SHORTCUT_OUTCOMES, writeFormulaMutation } from './read-only-entries.ts'

/** 语言包里的全部文字 */
function leaves(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]
  if (Array.isArray(value))
    return value.flatMap(leaves)
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(leaves)
  return []
}

/** 一次调用：方法的路径与参数 */
interface Call {
  readonly path: string
  readonly args: readonly unknown[]
}

/**
 * 记录调用的假 Facade：读任何属性都得到一个函数，调用它记下路径与参数、返回下一层的假对象；then 读出 undefined（不是 thenable，
 * 可以 await）；数组的方法（getImages()[0]）同样是假对象
 */
function recorder(calls: Call[], path = ''): unknown {
  const target = function fake(): void {}
  return new Proxy(target, {
    get: (_target, key) => {
      if (key === 'then' || typeof key === 'symbol')
        return undefined
      return recorder(calls, path === '' ? key : `${path}.${key}`)
    },
    apply: (_target, _this, args: unknown[]) => {
      calls.push({ path, args })
      return recorder(calls, `${path}()`)
    },
  })
}

/** 把调用序列化再求值（与 E2E 的 runFacade 相同的做法：函数的源码在另一个作用域里重新求值），在假 Facade 上执行 */
async function runSerialized(call: (scope: never) => unknown): Promise<Call[]> {
  const calls: Call[] = []
  const scope = { api: recorder(calls, 'api'), workbook: recorder(calls, 'workbook'), sheet: recorder(calls, 'sheet') }
  // eslint-disable-next-line no-new-func, ts/no-implied-eval -- 就是要核对序列化之后的源码在别的作用域里照样能执行（不引用外面的变量）
  const revive = new Function(`return (${call.toString()})`) as () => (scope: unknown) => unknown
  await revive()(scope)
  return calls
}

describe('只读入口的共用清单：提示的说法', () => {
  it('每一种提示都是语言包里改成只读说法的那些（editor/profile/locale.ts），都符合"任何一种只读的提示"', () => {
    const texts = leaves(READ_ONLY_PERMISSION_TEXTS)
    for (const [key, text] of Object.entries(READ_ONLY_ALERT)) {
      expect(texts, key).toContain(text)
      expect(text, key).toMatch(ANY_READ_ONLY_ALERT)
    }
  })

  it('入口与快捷键的预期里，被拦下时的提示都是登记的说法', () => {
    const alerts = Object.values(READ_ONLY_ALERT) as string[]
    const outcomes = [...FACADE_ENTRIES.flatMap(entry => [entry.read, entry.edit]), ...Object.values(SHORTCUT_OUTCOMES).flatMap(outcome => [outcome.read, outcome.edit])]
    for (const outcome of outcomes) {
      if ('blocked' in outcome)
        expect(alerts).toContain(outcome.alert)
    }
  })
})

describe('只读入口的共用清单：Facade 入口', () => {
  it('M0 的 21 项另加"取消已有的超链接"，名称不重复；能编辑时不改动的只有超链接（M5 之前被入口守卫取消）', () => {
    expect(FACADE_ENTRIES).toHaveLength(22)
    expect(new Set(FACADE_ENTRIES.map(entry => entry.name)).size).toBe(22)
    expect(FACADE_ENTRIES.filter(entry => entry.unchangedWhenEditable).map(entry => entry.name)).toEqual(['超链接'])
  })

  it.each(FACADE_ENTRIES.map(entry => [entry.name, entry] as const))('%s：序列化之后在别的作用域里照样调到 Facade（只用参数，不引用外面的变量）', async (_name, entry) => {
    const calls = await runSerialized(entry.call)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => /^(?:api|workbook|sheet)\b/.test(call.path))).toBe(true)
  })

  it('写公式的 mutation：序列化之后照样执行，写的是登记的那一格（FORMULA_MUTATION_CELL）与那条 mutation', async () => {
    const calls = await runSerialized(writeFormulaMutation)
    const execute = calls.find(call => call.path === 'api.executeCommand')
    expect(execute?.args[0]).toBe(FORMULA_MUTATION_ID)
    const params = execute?.args[1] as { cellValue: Record<number, Record<number, { f: string }>> }
    expect(params.cellValue[FORMULA_MUTATION_CELL.row]?.[FORMULA_MUTATION_CELL.column]).toEqual({ f: '=1+1' })
  })
})

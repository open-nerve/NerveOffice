import { extractAssetIds } from '@nerve-office/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMAGE_ORIGIN, IMAGE_SOURCE, imageFormulaEngine } from '../image-function/image-formula-source.test-support.ts'
import { normalizeImageFormula } from './image-formula-address.ts'

const ABSOLUTE = `${IMAGE_ORIGIN}${IMAGE_SOURCE}`
const ID = IMAGE_SOURCE.slice('/api/assets/'.length)
/** JS 的 \s 与 String.prototype.trim 去掉的是同一组码位（都在基本平面里）：SDK 的首参来源证明与 imageLiteralSource 用 trim */
const WHITESPACE = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter(char => /^\s$/u.test(char))
/** 不是空白的对照：trim 不去掉，SDK 不认作字面量 */
const NOT_WHITESPACE = ['\u200B', '\u180E', '\u00AD', '\u2060']

function placements(char: string): readonly (readonly [string, string])[] {
  return [
    ['首参前', `=IMAGE(${char}"${ABSOLUTE}")`],
    ['首参后', `=IMAGE("${ABSOLUTE}"${char},"说明")`],
    ['括号组内', `=IMAGE((${char}"${ABSOLUTE}"${char}))`],
  ]
}

function label(char: string): string {
  return `U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
}

let engine: Awaited<ReturnType<typeof imageFormulaEngine>>
beforeEach(async () => {
  engine = await imageFormulaEngine()
})
afterEach(() => engine.dispose())

/** 真实解释器是否以本站地址执行了原 IMAGE（经平台的首参来源限制） */
function executedWith(formula: string): string | undefined {
  engine.recording.calls.length = 0
  engine.execute(formula)
  const first: unknown = engine.recording.calls[0]?.[0]?.getValue()
  return engine.recording.calls.length === 1 && typeof first === 'string' ? first : undefined
}

describe('IMAGE 首参两侧的空白：写入规范与固定 SDK 的解释一致（M5-P9 CX2）', () => {
  it('Unicode 空白集合与 trim 一致，且包含报告与实测的几种写法', () => {
    expect(WHITESPACE.map(label)).toEqual(expect.arrayContaining(['U+0020', 'U+00A0', 'U+2003', 'U+3000', 'U+FEFF']))
    for (const char of WHITESPACE)
      expect(`a${char}`.trim()).toBe('a')
    for (const char of NOT_WHITESPACE)
      expect(`a${char}`.trim()).not.toBe('a')
  })

  it('每个空白码位放在首参前、首参后与括号组内：SDK 以本站地址执行原 IMAGE 的，规范都改写为相对地址并能提取引用', () => {
    const mismatches: string[] = []
    for (const char of WHITESPACE) {
      for (const [where, formula] of placements(char)) {
        const executed = executedWith(formula)
        const normalized = normalizeImageFormula(formula, IMAGE_ORIGIN)
        const rewritten = normalized !== formula
        if ((executed === ABSOLUTE) !== rewritten) {
          mismatches.push(`${label(char)} ${where}：SDK ${executed === undefined ? '未执行' : '执行'}，规范${rewritten ? '改写' : '未改写'}`)
          continue
        }
        if (!rewritten)
          continue
        // 改写之后仍是同一个 IMAGE 调用，只是地址变成相对地址；服务端按它登记引用
        if (executedWith(normalized) !== IMAGE_SOURCE)
          mismatches.push(`${label(char)} ${where}：改写之后 SDK 不再以相对地址执行`)
        if (extractAssetIds(normalized).join() !== ID)
          mismatches.push(`${label(char)} ${where}：改写之后提取不到引用`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('不是空白的字符（零宽空格等）SDK 不认作字面量，规范也不改写', () => {
    for (const char of NOT_WHITESPACE) {
      for (const [where, formula] of placements(char)) {
        expect(executedWith(formula), `${label(char)} ${where}`).not.toBe(ABSOLUTE)
        expect(normalizeImageFormula(formula, IMAGE_ORIGIN), `${label(char)} ${where}`).toBe(formula)
      }
    }
  })
})

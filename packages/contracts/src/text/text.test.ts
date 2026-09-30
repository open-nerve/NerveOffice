// 文本规则（M2-P6 复核 B2）。看不见的字符一律写成 \u 转义：源码里直接出现它们，审阅时看不出来。
import { describe, expect, it } from 'vitest'
import { displayNameSchema } from '../users/users.ts'
import { codePointLength, hasBidiControls, hasControlCharacters, hasLineSeparators, hasVisibleCharacters, nameTextSchema, titleTextSchema } from './text.ts'

const nameSchema = nameTextSchema({ label: '名称', maxLength: 20 })
const titleSchema = titleTextSchema({ label: '标题', maxLength: 20 })

/** 解析失败时的第一条说明；成功时为 undefined */
function problemOf(schema: typeof nameSchema | typeof titleSchema, value: string): string | undefined {
  const result = schema.safeParse(value)
  return result.success ? undefined : result.error.issues[0]?.message
}

/** 双向控制字符：阿拉伯字母标记、LRM、RLM、LRE、RLE、PDF、LRO、RLO、LRI、RLI、FSI、PDI */
const BIDI_CONTROLS = ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']

/** 单独构成整个名称时看不见的字符：零宽空格、词连接符、BOM、韩文填充符（三种）、蒙古文元音分隔符、零宽连接符与不连字、变体选择符、盲文空白、软连字符 */
const INVISIBLE = ['\u200B', '\u2060', '\uFEFF', '\u3164', '\u115F', '\u1160', '\uFFA0', '\u180E', '\u200D', '\u200C', '\uFE0E', '\uFE0F', '\u2800', '\u00AD']

/**
 * 正常的名字：表情组合（零宽连接符连起来的一家人、带变体选择符的心、国旗、肤色）、阿拉伯文、希伯来文、
 * 波斯文里的零宽不连字、天城文里的零宽连接符、韩文、左右混排（不带控制字符）
 */
const ORDINARY_NAMES = [
  '张三',
  'Zhang San',
  '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
  '\u2764\uFE0F',
  '\u2764\uFE0E',
  '\u{1F1E8}\u{1F1F3}',
  '\u{1F44D}\u{1F3FD}',
  '\u0645\u062D\u0645\u062F',
  '\u05D3\u05D5\u05D3',
  '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645',
  '\u0915\u094D\u200D\u0937',
  '\uAE40\uBBFC\uC218',
  'Ali \u0639\u0644\u064A',
]

describe('文本规则', () => {
  it('长度按码点计，表情符号算一个字符', () => {
    expect(codePointLength('周报')).toBe(2)
    expect(codePointLength('\u{1F600}a')).toBe(2)
    expect(codePointLength('')).toBe(0)
  })

  it('控制字符：C0、DEL 与 C1', () => {
    for (const control of ['\u0000', '\n', '\r', '\t', '\u001B', '\u001F', '\u007F', '\u0085', '\u009F'])
      expect(hasControlCharacters(`a${control}b`), JSON.stringify(control)).toBe(true)
    for (const text of ['周报 2026', 'a b', '\u{1F600}', ' ', '\u00A0', '\u3000'])
      expect(hasControlCharacters(text), JSON.stringify(text)).toBe(false)
  })

  it('双向控制字符：每一个都认得出；正常的阿拉伯文、希伯来文与左右混排不算', () => {
    for (const control of BIDI_CONTROLS)
      expect(hasBidiControls(`a${control}b`), JSON.stringify(control)).toBe(true)
    for (const name of ORDINARY_NAMES)
      expect(hasBidiControls(name), JSON.stringify(name)).toBe(false)
  })

  it('行分隔符与段分隔符', () => {
    expect(hasLineSeparators('a\u2028b')).toBe(true)
    expect(hasLineSeparators('a\u2029b')).toBe(true)
    expect(hasLineSeparators('a b\u3000c')).toBe(false)
  })

  it('去掉看不见的字符之后还有没有字', () => {
    for (const invisible of INVISIBLE)
      expect(hasVisibleCharacters(invisible), JSON.stringify(invisible)).toBe(false)
    expect(hasVisibleCharacters('\u200B \u3164\u3000\u200D')).toBe(false)
    expect(hasVisibleCharacters('张\u200B三')).toBe(true)
    for (const name of ORDINARY_NAMES)
      expect(hasVisibleCharacters(name), JSON.stringify(name)).toBe(true)
  })
})

describe('名称的规则（显示名、团队空间名称、文件夹名称共用）', () => {
  it.each(ORDINARY_NAMES.map(name => [JSON.stringify(name), name]))('正常的名字照常通过：%s', (_label, name) => {
    expect(nameSchema.parse(name)).toBe(name)
  })

  it('先 NFC 归一：组合写法（e + 组合重音符）存成预组写法，两种写法因此是同一个名字', () => {
    expect(nameSchema.parse('Jose\u0301')).toBe('Jos\u00E9')
    expect(nameSchema.parse('Jos\u00E9')).toBe('Jos\u00E9')
    // 按归一之后的码点计长度：20 个"e 加组合重音符"归一之后正好 20 个字符
    expect(nameSchema.safeParse('e\u0301'.repeat(20)).success).toBe(true)
  })

  it.each(BIDI_CONTROLS.map(control => [JSON.stringify(control), control]))('拒绝双向控制字符 %s', (_label, control) => {
    expect(problemOf(nameSchema, `张${control}三`)).toBe('名称不能包含改变文字方向的控制字符')
  })

  it('拒绝行分隔符与段分隔符；只在首尾时随空白一起去掉', () => {
    expect(problemOf(nameSchema, '张\u2028三')).toBe('名称不能包含换行符')
    expect(problemOf(nameSchema, '张\u2029三')).toBe('名称不能包含换行符')
    expect(nameSchema.parse('\u2028张三\u2029')).toBe('张三')
  })

  it.each(INVISIBLE.map(invisible => [JSON.stringify(invisible), invisible]))('整个名称只有看不见的字符 %s：拒绝', (_label, invisible) => {
    expect(nameSchema.safeParse(invisible).success).toBe(false)
    expect(nameSchema.safeParse(`${invisible}${invisible}`).success).toBe(false)
  })

  it('看不见的字符混着空白也不算有字；夹在字中间的零宽字符、韩文填充符不拒绝', () => {
    expect(problemOf(nameSchema, '\u3164 \u200B')).toBe('名称不能只有空白或看不见的字符')
    expect(problemOf(nameSchema, '\u200D\uFE0F')).toBe('名称不能只有空白或看不见的字符')
    expect(nameSchema.parse('张\u200B三')).toBe('张\u200B三')
  })

  it('控制字符、长度照旧', () => {
    expect(problemOf(nameSchema, '张\n三')).toBe('名称不能包含控制字符')
    expect(problemOf(nameSchema, '')).toBe('名称为 1–20 个字符')
    expect(problemOf(nameSchema, 'a'.repeat(21))).toBe('名称为 1–20 个字符')
  })

  it('显示名用的就是这套规则', () => {
    expect(displayNameSchema.safeParse('\u202E文张').success).toBe(false)
    expect(displayNameSchema.safeParse('\u3164').success).toBe(false)
    expect(displayNameSchema.parse('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 张三')).toBe('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 张三')
  })
})

describe('标题的规则', () => {
  it.each(ORDINARY_NAMES.map(name => [JSON.stringify(name), name]))('正常的标题照常通过：%s', (_label, title) => {
    expect(titleSchema.parse(title)).toBe(title)
  })

  it('原样保存，不做 NFC 归一', () => {
    expect(titleSchema.parse('Jose\u0301')).toBe('Jose\u0301')
  })

  it('拒绝双向控制字符与行、段分隔符', () => {
    for (const control of BIDI_CONTROLS)
      expect(problemOf(titleSchema, `报告${control}fdp.exe`), JSON.stringify(control)).toBe('标题不能包含改变文字方向的控制字符')
    expect(problemOf(titleSchema, '周\u2028报')).toBe('标题不能包含换行符')
    expect(problemOf(titleSchema, '周\u2029报')).toBe('标题不能包含换行符')
  })

  it('不能只有看不见的字符；夹在字中间的零宽字符照常保存', () => {
    for (const invisible of INVISIBLE)
      expect(titleSchema.safeParse(invisible).success, JSON.stringify(invisible)).toBe(false)
    expect(titleSchema.parse('周\u200B报')).toBe('周\u200B报')
  })
})

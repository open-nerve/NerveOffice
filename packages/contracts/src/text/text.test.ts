// 文本规则（M2-P6 复核 B2；名称里夹着看不见的字符，复验 N6；格式字符与蒙古文元音分隔符，M2-P6 复验 建议-2、一般-5）。
// 看不见的字符与蒙古文一律写成 \u 转义：源码里直接出现它们，审阅时看不出来。
import { describe, expect, it } from 'vitest'
import { folderNameSchema } from '../folders/folders.ts'
import { spaceNameSchema } from '../spaces/spaces.ts'
import { displayNameSchema } from '../users/users.ts'
import { BLANK_LOOKING_CHARACTERS, codePointLength, collapseNameBlanks, collapseSpaces, hasBidiControls, hasControlCharacters, hasHiddenCharacters, hasLineSeparators, hasVisibleCharacters, NAME_BLANK_CHARACTERS, NAME_KEY_IGNORED_CHARACTERS, nameTextSchema, titleTextSchema } from './text.ts'

const nameSchema = nameTextSchema({ label: '名称', maxLength: 20 })
const titleSchema = titleTextSchema({ label: '标题', maxLength: 20 })

/** 解析失败时的第一条说明；成功时为 undefined */
function problemOf(schema: typeof nameSchema | typeof titleSchema, value: string): string | undefined {
  const result = schema.safeParse(value)
  return result.success ? undefined : result.error.issues[0]?.message
}

/** 双向控制字符：阿拉伯字母标记、LRM、RLM、LRE、RLE、PDF、LRO、RLO、LRI、RLI、FSI、PDI */
const BIDI_CONTROLS = ['\u061C', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']

/** 单独构成整个名称时看不见的字符：零宽空格、词连接符、BOM、韩文填充符（三种）、蒙古文元音分隔符、零宽连接符与不连字、变体选择符、盲文空白、软连字符、契丹小字填充符、乐谱的空符头 */
const INVISIBLE = ['\u200B', '\u2060', '\uFEFF', '\u3164', '\u115F', '\u1160', '\uFFA0', '\u180E', '\u200D', '\u200C', '\uFE0E', '\uFE0F', '\u2800', '\u00AD', '\u{16FE4}', '\u{1D159}']

/** 一段空白存成它自己的三种：普通空格、不换行空格、全角空格 */
const KEPT_SPACES = [' ', '\u00A0', '\u3000']
/**
 * 换成普通空格的空格类分隔符：欧甘文空格、en quad 到发丝空格（U+2000–U+200A）、窄不换行空格、中数学空格。
 * 其中五种窄的空白（NARROW_SPACES）夹在字中间与不夹只差 0.84–2.97 像素（M2-P6 复验第二轮实测）
 */
const REPLACED_SPACES = ['\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u202F', '\u205F']
/** 发丝空格、细空格、六分之一空格、窄不换行空格、中数学空格 */
const NARROW_SPACES = ['\u200A', '\u2009', '\u2006', '\u202F', '\u205F']

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

  it('看不见的字符混着空白也不算有字：说明是"只有看不见的字符"，而不是"不能包含"', () => {
    expect(problemOf(nameSchema, '\u3164 \u200B')).toBe('名称不能只有空白或看不见的字符')
    expect(problemOf(nameSchema, '\u200D\uFE0F')).toBe('名称不能只有空白或看不见的字符')
  })

  it('控制字符、长度照旧', () => {
    expect(problemOf(nameSchema, '张\n三')).toBe('名称不能包含控制字符')
    expect(problemOf(nameSchema, '')).toBe('名称为 1–20 个字符')
    expect(problemOf(nameSchema, 'a'.repeat(21))).toBe('名称为 1–20 个字符')
  })

  it('空格类的分隔符（\\p{Zs}）恰好是保留的三种加上换成普通空格的那些：下面几个用例逐个核对的就是全部', () => {
    const mismatches: string[] = []
    for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint += 1) {
      if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
        continue
      const character = String.fromCodePoint(codePoint)
      if (/^\p{Zs}$/u.test(character) !== [...KEPT_SPACES, ...REPLACED_SPACES].includes(character))
        mismatches.push(codePoint.toString(16))
    }
    expect(mismatches).toEqual([])
  })

  it('名字里的每一段空白只存成一个字符：这一段的第一个是普通空格、不换行空格、全角空格时保留它，单个的与连续的一样（M2-P6 复核 B 的 M-1、复验 R-G4、第二轮 N1）', () => {
    for (const space of KEPT_SPACES) {
      expect(collapseSpaces(`a${space}b`), JSON.stringify(space)).toBe(`a${space}b`)
      for (const next of [...KEPT_SPACES, ...REPLACED_SPACES])
        expect(collapseSpaces(`a${space}${next}b`), JSON.stringify([space, next])).toBe(`a${space}b`)
    }
    expect(nameSchema.parse('Zhang San')).toBe('Zhang San')
    expect(nameSchema.parse('Finance  Team')).toBe('Finance Team')
    expect(nameSchema.parse('山田\u3000太郎')).toBe('山田\u3000太郎')
    expect(nameSchema.parse('山田\u3000\u3000太郎')).toBe('山田\u3000太郎')
    expect(nameSchema.parse('Finance\u00A0Team')).toBe('Finance\u00A0Team')
    expect(nameSchema.parse('Finance\u00A0\u00A0Team')).toBe('Finance\u00A0Team')
    // 合并之后按码点计长度：20 个字符加一段长空白仍然合法
    expect(nameSchema.safeParse(`${'a'.repeat(10)}${' '.repeat(30)}${'b'.repeat(9)}`).success).toBe(true)
  })

  it('别的空白（窄的空白、各种宽度的空格、欧甘文空格）单个的与连续的都存成一个普通空格：夹在字中间的窄空白存下来看得出是一个空格（M2-P6 复验第二轮 N1）', () => {
    for (const space of REPLACED_SPACES) {
      expect(collapseSpaces(`a${space}b`), JSON.stringify(space)).toBe('a b')
      // 这一段的第一个决定存成什么："窄空白 + 普通空格"存成普通空格，不再存成窄空白
      for (const next of [...KEPT_SPACES, ...REPLACED_SPACES])
        expect(collapseSpaces(`a${space}${next}b`), JSON.stringify([space, next])).toBe('a b')
    }
    for (const space of NARROW_SPACES)
      expect(nameSchema.parse(`采${space}购部`), JSON.stringify(space)).toBe('采 购部')
    expect(nameSchema.parse('Finance\u2002\u202F Team')).toBe('Finance Team')
    expect(nameSchema.parse('\u3000 财务\u205F\u1680部 \u00A0')).toBe('财务 部')
    // 几段分开的空白各自按这一段的第一个
    expect(nameSchema.parse('a\u3000b c\u00A0d\u2009 e\u200Af')).toBe('a\u3000b c\u00A0d e f')
  })

  it('蒙古文：两个蒙古文字母之间单独的一个窄不换行空格原样保留（连接词干与后缀）；别处的、连着别的空白的照样换成普通空格', () => {
    // mongγol-un（"蒙古的"）：词干 mongγol（ma、o、ang、ga、o、la）与属格后缀 un（u、na）之间是窄不换行空格
    const stem = '\u182E\u1823\u1829\u182D\u1823\u182F'
    const suffix = '\u1824\u1828'
    expect(nameSchema.parse(`${stem}\u202F${suffix}`)).toBe(`${stem}\u202F${suffix}`)
    expect(nameSchema.parse(`${stem}\u202F${suffix}  ${stem}\u202F${suffix}`)).toBe(`${stem}\u202F${suffix} ${stem}\u202F${suffix}`)
    // 一边不是蒙古文字母：拉丁字母、数字、蒙古文数字一
    expect(collapseSpaces('a\u202Fb')).toBe('a b')
    expect(collapseSpaces(`${stem}\u202F1`)).toBe(`${stem} 1`)
    expect(collapseSpaces(`a\u202F${suffix}`)).toBe(`a ${suffix}`)
    expect(collapseSpaces(`${stem}\u202F\u1811`)).toBe(`${stem} \u1811`)
    // 不是单独的一个：连着别的空白
    expect(collapseSpaces(`${stem}\u202F\u202F${suffix}`)).toBe(`${stem} ${suffix}`)
    expect(collapseSpaces(`${stem}\u202F ${suffix}`)).toBe(`${stem} ${suffix}`)
    expect(collapseSpaces(`${stem} \u202F${suffix}`)).toBe(`${stem} ${suffix}`)
    // 蒙古文里别的窄空白照样换掉
    for (const space of NARROW_SPACES.filter(space => space !== '\u202F'))
      expect(collapseSpaces(`${stem}${space}${suffix}`), JSON.stringify(space)).toBe(`${stem} ${suffix}`)
    // 开头与末尾的由 trim 去掉
    expect(nameSchema.parse(`\u202F${stem}\u202F`)).toBe(stem)
  })

  it('空白的合并不碰控制字符与行、段分隔符：它们照旧按各自的说明拒绝', () => {
    expect(problemOf(nameSchema, '张\t三')).toBe('名称不能包含控制字符')
    expect(problemOf(nameSchema, '张 \n 三')).toBe('名称不能包含控制字符')
    expect(problemOf(nameSchema, '张 \u2028 三')).toBe('名称不能包含换行符')
    expect(collapseSpaces('a\t\tb\u2029c')).toBe('a\t\tb\u2029c')
  })

  it('空白合并之后仍然不能只有看不见的字符；夹在放行的字符之间的连续空白同样合并', () => {
    expect(problemOf(nameSchema, '\u200D \u3000\u200D')).toBe('名称不能只有空白或看不见的字符')
    expect(nameSchema.parse('\u2764\uFE0F\u3000\u3000Team')).toBe('\u2764\uFE0F\u3000Team')
  })

  it('显示名用的就是这套规则', () => {
    expect(displayNameSchema.safeParse('\u202E文张').success).toBe(false)
    expect(displayNameSchema.safeParse('\u3164').success).toBe(false)
    expect(displayNameSchema.safeParse('张\u200B三').success).toBe(false)
    expect(displayNameSchema.parse('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 张三')).toBe('\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 张三')
  })

  it('显示名、团队空间名称、文件夹名称都把每一段空白存成一个字符：全角空格保留，窄的空白换成普通空格', () => {
    for (const schema of [displayNameSchema, spaceNameSchema, folderNameSchema]) {
      expect(schema.parse(' 研发\u3000\u3000二部 ')).toBe('研发\u3000二部')
      expect(schema.parse('研发\u3000二部')).toBe('研发\u3000二部')
      expect(schema.parse('研发\u200A二部')).toBe('研发 二部')
    }
  })
})

describe('比较名称时算作空白的字符（NAME_BLANK_CHARACTERS，M2-P6 复验 G1）', () => {
  it('恰好是 Unicode 的 White_Space 加上显示成空白的非格式字符；collapseNameBlanks 把这些、且只把这些换成空格（逐个码点）', () => {
    const mismatches: string[] = []
    for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint += 1) {
      if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
        continue
      const character = String.fromCodePoint(codePoint)
      const blank = /^\p{White_Space}$/u.test(character) || within(BLANK_LOOKING_CHARACTERS, codePoint)
      if (within(NAME_BLANK_CHARACTERS, codePoint) !== blank || (collapseNameBlanks(character) === ' ') !== blank)
        mismatches.push(codePoint.toString(16))
    }
    expect(mismatches).toEqual([])
  })

  it('collapseNameBlanks：每一段合成一个普通空格，不去首尾；看不见的格式字符不算空白，LIKE 的通配符原样', () => {
    expect(collapseNameBlanks('山田\u3000太郎')).toBe('山田 太郎')
    expect(collapseNameBlanks('Jean\u00A0Dupont')).toBe('Jean Dupont')
    expect(collapseNameBlanks('a \u3000\t\u2800b')).toBe('a b')
    expect(collapseNameBlanks('\u2028a\u{1D159}\u{16FE4}b ')).toBe(' a b ')
    expect(collapseNameBlanks('a\u200Bb\u200Dc\u3164d')).toBe('a\u200Bb\u200Dc\u3164d')
    expect(collapseNameBlanks('50%\u3000a_b')).toBe('50% a_b')
  })
})

/** 一个码点在不在这些闭区间里 */
function within(ranges: readonly (readonly [number, number])[], codePoint: number): boolean {
  return ranges.some(([first, last]) => codePoint >= first && codePoint <= last)
}

describe('判重时不算区别的字符（NAME_KEY_IGNORED_CHARACTERS，M2-P6 复核 B 的 M-1）', () => {
  it('恰好是名字里放行的格式字符与默认可忽略字符，加上蒙古文元音分隔符：名字的规则放行什么，判重就忽略什么', () => {
    const formatOrIgnorable = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u
    const mismatches: string[] = []
    for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint += 1) {
      // 代理项不是字符
      if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
        continue
      const character = String.fromCodePoint(codePoint)
      if (!formatOrIgnorable.test(character))
        continue
      // 夹在两个普通字母之间还能留在名字里的（蒙古文元音分隔符只在正字法位置上放行，这里单独算进去）
      const allowed = (!hasHiddenCharacters(`a${character}a`) && !hasBidiControls(character)) || codePoint === 0x180E
      if (allowed !== within(NAME_KEY_IGNORED_CHARACTERS, codePoint))
        mismatches.push(codePoint.toString(16))
    }
    expect(mismatches).toEqual([])
  })

  it('清单里只有看不见的字符：没有字母、数字与空白', () => {
    for (const [first, last] of NAME_KEY_IGNORED_CHARACTERS) {
      for (let codePoint = first; codePoint <= last; codePoint += 1)
        expect(/^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u.test(String.fromCodePoint(codePoint)), codePoint.toString(16)).toBe(true)
    }
  })
})

/**
 * 名字里放行的几类默认可忽略字符的正例（复验 N6）：零宽连接符连起来的一家人、带 VS16 的心、国旗与英格兰旗（标签字符）、
 * 带零宽不连字的波斯文、带零宽连接符的天城文、带异体字选择符的汉字（葛飾的"葛"取另一个字形），
 * 以及组合用字形连接符、蒙古文的自由变体选择符
 */
const ALLOWED_IN_NAMES: readonly (readonly [string, string])[] = [
  ['零宽连接符连起来的一家人', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} 张三'],
  ['带 VS16 的心', '\u2764\uFE0F 李四'],
  ['国旗', '\u{1F1E8}\u{1F1F3} 王五'],
  ['英格兰旗（黑旗加标签字符）', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} Alice'],
  ['带零宽不连字的波斯文', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'],
  ['带零宽连接符的天城文', '\u0915\u094D\u200D\u0937'],
  ['带异体字选择符的汉字', '\u845B\u{E0100}\u98FE'],
  ['带组合用字形连接符的拉丁字母', 'Zu\u034F\u0308rich'],
  ['带自由变体选择符的蒙古文', '\u182E\u1823\u1829\u182D\u180B\u1823\u182F'],
  ['带第四个自由变体选择符的蒙古文', '\u1820\u180F\u1828'],
  ['两个变体选择符（范围的两头）', '\u845B\uFE00\u845B\u{E01EF}'],
]

/**
 * 名字里不放行的默认可忽略字符（复验 N6）：零宽空格、韩文填充符（三种）、词连接符、BOM、软连字符、蒙古文元音分隔符
 * （不在正字法位置上时，见下）、高棉文的两个固有元音、不可见的运算符（四个）、语言标签、速记格式控制符、乐谱的连梁控制符；
 * 以及不属于默认可忽略、同样不放行的格式字符（M2-P6 复验 建议-2）：行间注释字符（三个）、阿拉伯文的数字符号与经文结束符、
 * 叙利亚文的缩写符、埃及圣书体的格式控制符（范围的两头）
 */
const HIDDEN_IN_NAMES = [
  '\u200B',
  '\u3164',
  '\u115F',
  '\u1160',
  '\uFFA0',
  '\u2060',
  '\uFEFF',
  '\u00AD',
  '\u180E',
  '\u17B4',
  '\u17B5',
  '\u2061',
  '\u2062',
  '\u2063',
  '\u2064',
  '\u{E0001}',
  '\u{1BCA0}',
  '\u{1D173}',
  '\uFFF9',
  '\uFFFA',
  '\uFFFB',
  '\u0600',
  '\u06DD',
  '\u070F',
  '\u{13430}',
  '\u{1343F}',
]

describe('名称里夹着看不见的字符（复验 N6）', () => {
  it.each(ALLOWED_IN_NAMES)('放行名字里确有用途的几类：%s', (_label, name) => {
    expect(hasHiddenCharacters(name)).toBe(false)
    expect(nameSchema.parse(name)).toBe(name)
  })

  it.each(HIDDEN_IN_NAMES.map(hidden => [JSON.stringify(hidden), hidden]))('拒绝夹在字中间的 %s，说明是"不能包含看不见的字符"', (_label, hidden) => {
    expect(hasHiddenCharacters(`研${hidden}发部`)).toBe(true)
    expect(problemOf(nameSchema, `研${hidden}发部`)).toBe('名称不能包含看不见的字符（例如零宽空格）')
    expect(problemOf(nameSchema, `Ali${hidden}ce`)).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it('夹在放行的字符旁边也照样拒绝：表情组合里混进零宽空格、异体字选择符后面跟着词连接符', () => {
    expect(problemOf(nameSchema, '\u{1F468}\u200D\u200B\u{1F469}')).toBe('名称不能包含看不见的字符（例如零宽空格）')
    expect(problemOf(nameSchema, '\u845B\u{E0100}\u2060\u98FE')).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it('放行的几类仍然不能单独构成整个名字', () => {
    for (const alone of ['\u200C', '\u200D', '\u034F', '\u180B', '\u180F', '\uFE0F', '\u{E0100}', '\u{E0067}\u{E0062}\u{E007F}'])
      expect(problemOf(nameSchema, alone), JSON.stringify(alone)).toBe('名称不能只有空白或看不见的字符')
  })

  it('双向控制字符也是默认可忽略的字符：说明仍是更具体的"改变文字方向"', () => {
    expect(problemOf(nameSchema, '张\u200F三')).toBe('名称不能包含改变文字方向的控制字符')
    expect(problemOf(nameSchema, '张\u2066三')).toBe('名称不能包含改变文字方向的控制字符')
  })
})

describe('名称里的格式字符：不属于默认可忽略的同样拒绝（M2-P6 复验 建议-2）', () => {
  /** 行间注释字符：锚点 U+FFF9、分隔 U+FFFA、结束 U+FFFB。是格式字符（Cf），但不属于默认可忽略字符；WebKit 里宽度为 0 */
  const ANNOTATION = ['\uFFF9', '\uFFFA', '\uFFFB']

  it.each(ANNOTATION.map(character => [JSON.stringify(character), character]))('单独构成整个名字：按"只有看不见的字符"拒绝 %s', (_label, character) => {
    expect(hasVisibleCharacters(character)).toBe(false)
    expect(hasHiddenCharacters(character)).toBe(true)
    expect(problemOf(nameSchema, character)).toBe('名称不能只有空白或看不见的字符')
    expect(problemOf(nameSchema, character.repeat(3))).toBe('名称不能只有空白或看不见的字符')
  })

  it('三个连在一起算"只有看不见的字符"；夹在字中间、放在名字末尾或开头：按"不能包含"拒绝', () => {
    expect(problemOf(nameSchema, '\uFFF9\uFFFA\uFFFB')).toBe('名称不能只有空白或看不见的字符')
    for (const name of ['张\uFFF9三\uFFFA\uFFFB', '研发部\uFFFB', '\uFFF9张三'])
      expect(problemOf(nameSchema, name), JSON.stringify(name)).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it('显示名、团队空间名称、文件夹名称都按这条规则', () => {
    expect(displayNameSchema.safeParse('\uFFF9').success).toBe(false)
    expect(displayNameSchema.safeParse('张\uFFF9三\uFFFA\uFFFB').success).toBe(false)
    expect(spaceNameSchema.safeParse('\uFFFB').success).toBe(false)
    expect(folderNameSchema.safeParse('\uFFFA').success).toBe(false)
  })

  it('放行的几类照旧：零宽连接符、零宽不连字、标签字符也是格式字符', () => {
    for (const [label, name] of ALLOWED_IN_NAMES)
      expect(hasHiddenCharacters(name), label).toBe(false)
  })
})

/** 显示成空白的非格式字符（M2-P6 复验 R-M1）：盲文空白、契丹小字填充符、乐谱的空符头 */
const BLANK_LOOKING = ['\u2800', '\u{16FE4}', '\u{1D159}']

/** 用例标题里写码点（U+2800），不直接带着看不见的字符 */
function codePointLabel(character: string): string {
  return `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
}

describe('名称里显示成空白的非格式字符：与看不见的字符一样拒绝（M2-P6 复验 R-M1）', () => {
  it('清单里的字符既不是空白，也不是格式字符或默认可忽略的字符：已有的规则管不到它们，所以另列一份', () => {
    const listed = BLANK_LOOKING_CHARACTERS.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => String.fromCodePoint(first + offset)))
    expect(listed).toEqual(BLANK_LOOKING)
    for (const character of listed)
      expect(/^[\p{White_Space}\p{Cf}\p{Default_Ignorable_Code_Point}]$/u.test(character), JSON.stringify(character)).toBe(false)
  })

  it('名称规则里"不是格式字符、也不是默认可忽略的字符，却也拒绝"的，恰好是这份清单（判重键把同一份清单当空白）', () => {
    const formatOrIgnorable = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u
    const mismatches: string[] = []
    for (let codePoint = 0; codePoint <= 0x10FFFF; codePoint += 1) {
      // 代理项不是字符
      if (codePoint >= 0xD800 && codePoint <= 0xDFFF)
        continue
      const character = String.fromCodePoint(codePoint)
      if (formatOrIgnorable.test(character))
        continue
      if (hasHiddenCharacters(`a${character}a`) !== within(BLANK_LOOKING_CHARACTERS, codePoint))
        mismatches.push(codePoint.toString(16))
    }
    expect(mismatches).toEqual([])
  })

  it.each(BLANK_LOOKING.map(character => [codePointLabel(character), character]))('%s 在末尾、开头、字中间、代替空格：说明与零宽空格相同，是"不能包含看不见的字符"', (_label, character) => {
    for (const name of [`财务部${character}`, `${character}财务部`, `财${character}务部`, `财 务${character}部`, `Finance${character}Team`])
      expect(problemOf(nameSchema, name), JSON.stringify(name)).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it.each(BLANK_LOOKING.map(character => [codePointLabel(character), character]))('整个名称只有 %s（或者它与空白）：说明是"只有看不见的字符"', (_label, character) => {
    expect(hasVisibleCharacters(character)).toBe(false)
    expect(problemOf(nameSchema, character)).toBe('名称不能只有空白或看不见的字符')
    expect(problemOf(nameSchema, `${character} ${character}`)).toBe('名称不能只有空白或看不见的字符')
  })

  it('显示名、团队空间名称、文件夹名称都按这条规则', () => {
    for (const character of BLANK_LOOKING) {
      for (const schema of [displayNameSchema, spaceNameSchema, folderNameSchema])
        expect(schema.safeParse(`研发部${character}`).success, JSON.stringify(character)).toBe(false)
    }
  })

  it('标题：只有它们时拒绝（列表里就是一行空白）；夹在字中间照常保存（标题的规则比名称宽）', () => {
    for (const character of BLANK_LOOKING) {
      expect(problemOf(titleSchema, character), JSON.stringify(character)).toBe('标题不能只有空白或看不见的字符')
      expect(titleSchema.parse(`周${character}报`)).toBe(`周${character}报`)
    }
  })
})

/** 蒙古文字母：a U+1820、e U+1821、na U+1828、ra U+1837、ha U+182C、ta U+1832；元音分隔符 MVS U+180E、自由变体选择符 FVS1 U+180B */
const MONGOLIAN = { a: '\u1820', e: '\u1821', na: '\u1828', ra: '\u1837', ha: '\u182C', ta: '\u1832', mvs: '\u180E', fvs1: '\u180B' }
/** 蒙古文里 a、e 之外的元音：i、o、u、ö、ü、ee（U+1822–U+1827） */
const OTHER_MONGOLIAN_VOWELS = ['\u1822', '\u1823', '\u1824', '\u1825', '\u1826', '\u1827']

describe('名称里的蒙古文元音分隔符：只在正字法要求的位置放行（M2-P6 复验 一般-5）', () => {
  const { a, e, na, ra, ha, ta, mvs, fvs1 } = MONGOLIAN

  it.each([
    ['nar-a（"太阳"，名字"娜拉"的蒙古文写法）', `${na}${a}${ra}${mvs}${a}`],
    ['qar-a（"黑"）', `${ha}${a}${ra}${mvs}${a}`],
    ['词尾的 e：ter-e', `${ta}${e}${ra}${mvs}${e}`],
    ['词尾的元音后面跟着自由变体选择符', `${na}${a}${ra}${mvs}${a}${fvs1}`],
    ['与汉字、空格混排', `娜拉 ${na}${a}${ra}${mvs}${a}`],
  ])('前面是蒙古文字母、紧跟着词尾的 a 或 e：放行，%s', (_label, name) => {
    expect(hasHiddenCharacters(name)).toBe(false)
    expect(nameSchema.parse(name)).toBe(name)
    expect(displayNameSchema.parse(name)).toBe(name)
  })

  it.each([
    ['夹在汉字之间', `张${mvs}三`],
    ['夹在拉丁字母之间', `Ali${mvs}ce`],
    ['在名字开头、后面是 a', `${mvs}${a}`],
    ['在蒙古文字母之后、名字末尾', `${na}${a}${ra}${mvs}`],
    ['后面不是 a、e', `${na}${a}${ra}${mvs}${na}`],
    ['后面是拉丁字母 a', `${na}${a}${ra}${mvs}a`],
    ['前面是汉字、后面是 a', `张${mvs}${a}`],
    ['前面是自由变体选择符（不是字母）', `${na}${a}${ra}${fvs1}${mvs}${a}`],
    ['前面是蒙古文数字', `\u1810${mvs}${a}`],
    ['连着两个', `${na}${a}${ra}${mvs}${mvs}${a}`],
  ])('其他位置照旧拒绝：%s', (_label, name) => {
    expect(hasHiddenCharacters(name)).toBe(true)
    expect(problemOf(nameSchema, name)).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it.each(OTHER_MONGOLIAN_VOWELS.map(vowel => [JSON.stringify(vowel), vowel]))('后面是 a、e 之外的蒙古文元音 %s：拒绝（正字法只在词尾的 a、e 之前用它，第三轮复验 一般-C）', (_label, vowel) => {
    expect(hasHiddenCharacters(`${na}${a}${ra}${mvs}${vowel}`)).toBe(true)
    expect(problemOf(nameSchema, `${na}${a}${ra}${mvs}${vowel}`)).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it('同一个位置上换成别的看不见的字符（零宽空格、词连接符、行间注释字符、软连字符）：照旧拒绝，放行的只有元音分隔符', () => {
    for (const hidden of ['\u200B', '\u2060', '\uFFF9', '\u00AD'])
      expect(problemOf(nameSchema, `${na}${a}${ra}${hidden}${a}`), JSON.stringify(hidden)).toBe('名称不能包含看不见的字符（例如零宽空格）')
  })

  it('单独一个，或者只有它与空白：说明是"只有看不见的字符"', () => {
    expect(problemOf(nameSchema, mvs)).toBe('名称不能只有空白或看不见的字符')
    expect(problemOf(nameSchema, `${mvs} ${mvs}`)).toBe('名称不能只有空白或看不见的字符')
  })

  it('团队空间名称、文件夹名称同样放行正字法位置上的，拒绝别处的', () => {
    const nara = `${na}${a}${ra}${mvs}${a}`
    expect(spaceNameSchema.parse(nara)).toBe(nara)
    expect(folderNameSchema.parse(nara)).toBe(nara)
    expect(spaceNameSchema.safeParse(`研${mvs}发部`).success).toBe(false)
    expect(folderNameSchema.safeParse(`资料${mvs}`).success).toBe(false)
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

  it('不能只有看不见的字符；夹在字中间的零宽字符照常保存（复验 N6 只改名称，标题的规则不变）', () => {
    for (const invisible of INVISIBLE)
      expect(titleSchema.safeParse(invisible).success, JSON.stringify(invisible)).toBe(false)
    expect(titleSchema.parse('周\u200B报')).toBe('周\u200B报')
    for (const hidden of HIDDEN_IN_NAMES)
      expect(titleSchema.parse(`周${hidden}报`), JSON.stringify(hidden)).toBe(`周${hidden}报`)
  })

  it('只由行间注释字符组成的标题：拒绝（WebKit 里宽度为 0，看起来是空标题，M2-P6）；夹在字中间照常保存', () => {
    for (const annotation of ['\uFFF9', '\uFFFA', '\uFFFB', '\uFFF9\uFFFA\uFFFB', ' \uFFFB '])
      expect(problemOf(titleSchema, annotation), JSON.stringify(annotation)).toBe('标题不能只有空白或看不见的字符')
    expect(titleSchema.parse('周\uFFF9报\uFFFA\uFFFB')).toBe('周\uFFF9报\uFFFA\uFFFB')
  })
})

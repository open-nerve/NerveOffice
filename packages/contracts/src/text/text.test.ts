import { describe, expect, it } from 'vitest'
import { codePointLength, hasControlCharacters } from './text.ts'

describe('文本规则', () => {
  it('长度按码点计，表情符号算一个字符', () => {
    expect(codePointLength('周报')).toBe(2)
    expect(codePointLength('😀a')).toBe(2)
    expect(codePointLength('')).toBe(0)
  })

  it('控制字符：C0、DEL 与 C1', () => {
    for (const control of ['\u0000', '\n', '\r', '\t', '\u001B', '\u001F', '\u007F', '\u0085', '\u009F'])
      expect(hasControlCharacters(`a${control}b`), JSON.stringify(control)).toBe(true)
    for (const text of ['周报 2026', 'a b', '😀', ' ', '\u00A0', '\u3000'])
      expect(hasControlCharacters(text), JSON.stringify(text)).toBe(false)
  })
})

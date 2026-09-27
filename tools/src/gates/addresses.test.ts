import { describe, expect, it } from 'vitest'
import { crossOriginAddress, isRegexFlags, originOf } from './addresses.ts'
import { INTERPOLATION_PLACEHOLDER } from './eval-and-function.ts'

const HOLE = INTERPOLATION_PLACEHOLDER

describe('US-M1-11 按浏览器的规则认出跨源地址（DEF-016，复验 RA2–RA4、SA1、SA3）', () => {
  it.each([
    ['//evil.example/x', 'https://evil.example/x'],
    [' \u0001//evil.example/x', 'https://evil.example/x'],
    ['\\\\evil.example/x', 'https://evil.example/x'],
    ['https:\\\\evil.example/x', 'https://evil.example/x'],
    ['wss:evil.example/x', 'wss://evil.example/x'],
    ['//u@evil.example/x', 'https://u@evil.example/x'],
    ['//%65vil.example/x', 'https://evil.example/x'],
    ['//ｅｖｉｌ.example/x', 'https://evil.example/x'],
    ['/\t/evil.example/x', 'https://evil.example/x'],
    ['//intranet/x', 'https://intranet/x'],
    ['//nas:443/x', 'https://nas/x'],
    ['http:/evil.example/x', 'http://evil.example/x'],
    ['//2130706433/x', 'https://127.0.0.1/x'],
    ['//[::1]:8080/x', 'https://[::1]:8080/x'],
    [`${HOLE}//evil.example/x`, 'https://evil.example/x'],
    [`${HOLE}\\\\evil.example/x`, 'https://evil.example/x'],
    [`//evil.example/${HOLE}`, `https://evil.example/${HOLE}`],
    [`https://${HOLE}/x`, `https://${HOLE}/x`],
    // 以连字符开头或结尾、带星号、连续的点：浏览器照样请求（复验 SA1）
    ['//-evil.example/x', 'https://-evil.example/x'],
    ['//x-.attacker.example/x', 'https://x-.attacker.example/x'],
    ['//a*b.evil.example/x', 'https://a*b.evil.example/x'],
    ['//evil.example../x', 'https://evil.example../x'],
    // 协议里有插值、拼接的后半段以 :// 开头、端口是插值：主机是固定的（复验 SA3）
    [`http${HOLE}://evil.example/x`, 'https://evil.example/x'],
    [`${HOLE}://evil.example/x`, 'https://evil.example/x'],
    ['://evil.example/x', 'https://evil.example/x'],
    [`//evil.example:${HOLE}/x`, 'https://evil.example:1/x'],
    // 允许的地址后面接着制表符与另一个域名：浏览器删掉制表符，请求的是另一个主机
    ['https://tailwindcss.com\t.evil.example/x', 'https://tailwindcss.com.evil.example/x'],
    ['http://localhost,@evil.example/x', 'http://localhost,@evil.example/x'],
  ])('地址：%j → %s', (value, expected) => {
    expect(crossOriginAddress(value)).toBe(expected)
  })

  it.each([
    ['同协议、不带斜杠：相对地址', 'https:evil.example/x'],
    ['开头是 U+FEFF：相对地址', '\uFEFF//evil.example/x'],
    ['正则的标志', '//g'],
    ['正则的标志（多个）', '//gim'],
    ['相对路径', '/api/x'],
    ['查不到地址的名字', '\\/*$'],
    ['查不到地址的名字（括号）', '//(.+)'],
    ['不是网络协议', 'mailto:a@example.com'],
    ['脚本协议', 'javascript:alert(1)'],
    ['ftp', 'ftp://evil.example/x'],
    ['只有两个斜杠', '//'],
    ['开头的插值后面不是两个斜杠', `${HOLE}/x`],
  ])('不是跨源地址：%s', (_case, value) => {
    expect(crossOriginAddress(value)).toBeUndefined()
  })

  it('正则的标志：两个斜杠之后只有标志', () => {
    expect(isRegexFlags('//gi')).toBe(true)
    expect(isRegexFlags('//go')).toBe(false)
    expect(isRegexFlags('//intranet')).toBe(false)
  })

  it('地址的来源：协议、主机与端口；JSON 转义的斜杠与插值也认得', () => {
    expect(originOf('https://evil.example/a')).toBe('https://evil.example')
    expect(originOf('https:\\/\\/evil.example:8080/a')).toBe('https://evil.example:8080')
    expect(originOf('//evil.example/a')).toBe('https://evil.example')
    expect(originOf(`https://${HOLE}/x`)).toBe('https://x0hole0x')
    expect(originOf('not a url')).toBe('not a url')
  })
})

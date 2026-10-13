import { describe, expect, it } from 'vitest'
import { createProfileContinuity, parseOwnedPages } from './profile-continuity.ts'

const uuid = '9dd78b07-671f-443e-b107-a0b54f40c3e4'
const ledger = () => ({ windowId: 123, axWindowUuid: uuid, valid: true, urls: ['http://127.0.0.1:41000/previous-owned'] })
const windows = () => [{ windowId: 123, profileMatches: true, tabs: [{ index: 1, knownUrlMatches: true }] }]

describe('专用 Safari 场景的持续独占证明', () => {
  it('只接受本机绑定的有效历史；不能由页面或同名窗口补充归属', () => {
    expect(parseOwnedPages(ledger())).toEqual(ledger())
    for (const change of [{ windowId: 456 }, { axWindowUuid: '11111111-1111-4111-8111-111111111111' }, { valid: false }])
      expect(() => createProfileContinuity({ windowId: 123, axWindowUuid: uuid }, { ...ledger(), ...change })).toThrow()
    for (const value of [{ ...ledger(), extra: true }, { ...ledger(), urls: ['https://example.com/'] }, { ...ledger(), urls: ['http://127.0.0.1:41000/test#secret'] }, { ...ledger(), urls: [] }])
      expect(() => parseOwnedPages(value)).toThrow()
  })

  it('允许既有已知测试页与本轮 landing，但观测过未知页后不能再次获得资格', () => {
    const check = createProfileContinuity({ windowId: 123, axWindowUuid: uuid }, ledger())
    expect(check.accept(windows())).toBe(true)
    expect(check.accept([{ ...windows()[0]!, tabs: [{ index: 1, knownUrlMatches: false }] }])).toBe(false)
    expect(check.accept(windows())).toBe(false)
    expect(check.valid()).toBe(false)
  })

  it.each([
    [],
    [{ ...windows()[0]!, windowId: 456 }],
    [{ ...windows()[0]!, profileMatches: false }],
    [...windows(), { ...windows()[0]!, windowId: 456 }],
    [{ ...windows()[0]!, tabs: [{ index: 1, knownUrlMatches: true }, { index: 2, knownUrlMatches: true }] }],
    [{ ...windows()[0]!, tabs: [] }],
    [{ ...windows()[0]!, tabs: [{ index: 2, knownUrlMatches: true }] }],
    [{ ...windows()[0]!, tabs: [{ index: 1 }] }],
  ].map(value => ({ value })))('任何窗口/标签矛盾永久失效：%j', ({ value }) => {
    const check = createProfileContinuity({ windowId: 123, axWindowUuid: uuid }, ledger())
    expect(check.accept(value)).toBe(false)
    expect(check.accept(windows())).toBe(false)
  })
})

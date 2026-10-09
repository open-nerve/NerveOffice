// 持久上下文的资料目录名（persistent-profile.ts 的 profileDirName）：只有 ASCII——Linux 上 Playwright 的 WebKit（WPE 的 MiniBrowser）遇到
// 非 ASCII 的路径就起不来（P1 审查 B1），所以名字里不带用例标题、name 不合时抛出
import { describe, expect, it } from 'vitest'
import { profileDirName } from './persistent-profile.ts'

describe('持久上下文的资料目录名', () => {
  it('用例的 id、第几次重复、第几次重试与 name 连起来；每条用例、每次重复与重试、每个 name 各不相同', () => {
    expect(profileDirName('42f7ac272757e506f2ee-9a67ee6035f9ab6533b9', 0, 0, 'profile')).toBe('42f7ac272757e506f2ee-9a67ee6035f9ab6533b9-0-0-profile')
    const names = new Set([
      profileDirName('a1', 0, 0, 'profile'),
      profileDirName('a1', 1, 0, 'profile'),
      profileDirName('a1', 0, 1, 'profile'),
      profileDirName('a1', 0, 0, 'quota-profile'),
      profileDirName('a2', 0, 0, 'profile'),
    ])
    expect(names.size).toBe(5)
  })

  it('名字只有 ASCII：name 带中文、空格或斜杠时抛出，用例的 id 不是十六进制一类时也抛出', () => {
    for (const name of ['资料', 'pro file', 'a/b', '', 'é'])
      expect(() => profileDirName('a1', 0, 0, name)).toThrow(/ASCII/)
    expect(() => profileDirName('写入-1', 0, 0, 'profile')).toThrow(/ASCII/)
    expect(profileDirName('a1', 0, 0, 'crash')).toMatch(/^[\x21-\x7E]+$/)
  })
})

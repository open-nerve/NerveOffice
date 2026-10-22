import { describe, expect, it } from 'vitest'
import { isDocumentUpgradeTarget } from './document-upgrade.ts'

describe('升级目标标识', () => {
  it('接受有界 ASCII 标识，不接受结尾换行或嵌入非标识字符', () => {
    for (const value of ['v1', 'univer@next-0.21:rc/1', 'a'.repeat(128)])
      expect(isDocumentUpgradeTarget(value)).toBe(true)
    for (const value of ['', 'a\n', 'a\r\n', 'a\0', 'a b', '版本1', '-a', 'a'.repeat(129)])
      expect(isDocumentUpgradeTarget(value)).toBe(false)
  })
})

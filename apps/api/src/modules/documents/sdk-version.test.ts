// 文档记录的 SDK 版本（documents.sdk_version，写的是 contracts 的 UNIVER_SDK_VERSION）与编辑器实际用的版本一致（复验 RA6）：
// 编辑器用的是 pnpm 目录里的版本（deps 门禁核对目录与安装的实例都等于 UNIVER_POLICY）。快照里的 appVersion 不能代替这个检查：
// Univer 载入快照时沿用其中的 appVersion
import { readFileSync } from 'node:fs'
import { UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'

describe('文档记录的 SDK 版本', () => {
  it('与 pnpm 目录里 @univerjs/core 的版本相同', () => {
    const workspace = readFileSync(new URL('../../../../../pnpm-workspace.yaml', import.meta.url), 'utf8')
    // 版本可以写成带引号的 YAML 字符串（复验 SA9）
    expect(/^\s*'@univerjs\/core':\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(workspace)?.[1]).toBe(UNIVER_SDK_VERSION)
  })
})

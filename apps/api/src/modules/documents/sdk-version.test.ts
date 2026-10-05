// 文档记录的 SDK 版本（documents.sdk_version，写的是 contracts 的 UNIVER_SDK_VERSION）与编辑器实际用的版本一致（复验 RA6）：
// 编辑器用的是 pnpm 目录里的版本（deps 门禁核对目录与安装的实例都等于 UNIVER_POLICY）。快照里的 appVersion 不能代替这个检查：
// Univer 载入快照时沿用其中的 appVersion
import { readFileSync } from 'node:fs'
import { DOCUMENT_PROFILE_OF, parseVersion, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { documentTooNew } from './client-format-gate.ts'

const workspaceSchema = z.object({ catalog: z.record(z.string(), z.unknown()) })

describe('文档记录的 SDK 版本', () => {
  it('与 pnpm 目录里 @univerjs/core 的版本相同', () => {
    // 按 YAML 解析：键与版本的引号、行尾的注释都不影响（复验 SA9、TA10）
    const workspace = workspaceSchema.parse(parse(readFileSync(new URL('../../../../../pnpm-workspace.yaml', import.meta.url), 'utf8')))
    expect(workspace.catalog['@univerjs/core']).toBe(UNIVER_SDK_VERSION)
  })

  it('是认得出的 x.y.z 写法（审查 A10）：认不出的写法（例如带预发布后缀）按"比服务端新"处理，这台服务端写的每一份文档都会变成 DOCUMENT_TOO_NEW', () => {
    expect(parseVersion(UNIVER_SDK_VERSION)).toBeDefined()
    expect(documentTooNew({ type: 'sheet', profile: DOCUMENT_PROFILE_OF.sheet, formatVersion: PLATFORM_FORMAT_VERSION, sdkVersion: UNIVER_SDK_VERSION })).toBe(false)
  })
})

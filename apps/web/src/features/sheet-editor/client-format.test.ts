import { DOCUMENT_PROFILE_OF, parseVersion, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { ApiError, NetworkError } from '../../shared/api/index.ts'
import { clientFormatParams, documentIsNewer, incompatibilityOf, PAGE_CLIENT_FORMAT } from './client-format.ts'

/** 构建时注入的构建版本（vite.config.ts 的 define，单元测试经同一份配置；取值的规则由 build/client-build.test.ts 核对） */
declare const __NERVE_CLIENT_BUILD__: string

describe('本页的构建与数据格式（M3-P3 设计 §3.5）', () => {
  it('构建版本是构建时注入的值（服务端认得出的 x.y.z 写法）；数据格式取打进本页的 contracts 常量', () => {
    expect(PAGE_CLIENT_FORMAT).toEqual({ clientBuild: __NERVE_CLIENT_BUILD__, univerVersion: UNIVER_SDK_VERSION, profile: DOCUMENT_PROFILE_OF.sheet, formatVersion: PLATFORM_FORMAT_VERSION })
    expect(parseVersion(PAGE_CLIENT_FORMAT.clientBuild)).toBeDefined()
  })

  it('查询参数的写法：四项都是字符串（格式版本是十进制）', () => {
    expect(clientFormatParams()).toEqual({ clientBuild: __NERVE_CLIENT_BUILD__, univerVersion: UNIVER_SDK_VERSION, profile: 'sheet@1', formatVersion: String(PLATFORM_FORMAT_VERSION) })
  })

  it('incompatibilityOf：CLIENT_OUTDATED 是本页过旧、DOCUMENT_TOO_NEW 是文档比服务端新；别的失败不是', () => {
    expect(incompatibilityOf(new ApiError(409, 'CLIENT_OUTDATED', '过旧', { details: { reason: 'build' } }))).toBe('client-outdated')
    expect(incompatibilityOf(new ApiError(409, 'DOCUMENT_TOO_NEW', '太新'))).toBe('document-too-new')
    for (const error of [new ApiError(409, 'EDIT_LEASE_LOST', '失效'), new ApiError(409, 'DOCUMENT_REVISION_CONFLICT', '冲突'), new NetworkError('断网'), new Error('x'), undefined])
      expect(incompatibilityOf(error)).toBeUndefined()
  })

  it('documentIsNewer：文档记录的 SDK 版本比本页的新、认不出时为真；相同（+ 之后的诊断信息不比较）、更旧时为假', () => {
    for (const sdkVersion of ['9.0.0', `${UNIVER_SDK_VERSION.split('.').map((part, index) => index === 2 ? String(Number(part) + 1) : part).join('.')}`, 'nightly', ''])
      expect(documentIsNewer({ sdkVersion }), sdkVersion).toBe(true)
    for (const sdkVersion of [UNIVER_SDK_VERSION, `${UNIVER_SDK_VERSION}+build`, '0.9.0'])
      expect(documentIsNewer({ sdkVersion }), sdkVersion).toBe(false)
  })
})

import type { ClientFormat } from '@nerve-office/contracts'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { AppError } from '../../shared/errors/app-error.ts'
import { checkClient, documentTooNew, requireWritableDocument } from './client-format-gate.ts'
import { clientFormatGate } from './documents.test-support.ts'

const CURRENT: ClientFormat = { clientBuild: '0.1.0', univerVersion: UNIVER_SDK_VERSION, profile: DOCUMENT_PROFILE_OF.sheet, formatVersion: PLATFORM_FORMAT_VERSION }

describe('checkClient：与文档无关的一半（M3-P3 设计 §3.5）', () => {
  it('四项都上报、数据格式等于服务端的：通过，给出核对过的页面（写入时记进信封）', () => {
    expect(checkClient(CURRENT, undefined)).toEqual({ ok: true, client: CURRENT })
  })

  it('数据格式不同或没上报：format（先看数据格式，再看构建）', () => {
    const cases: ClientFormat[] = [
      { ...CURRENT, univerVersion: '1.0.0' },
      { ...CURRENT, univerVersion: '1.0.1+build' },
      { ...CURRENT, profile: 'sheet@2' },
      { ...CURRENT, profile: 'doc@1' },
      { ...CURRENT, formatVersion: 2 },
      { ...CURRENT, univerVersion: undefined },
      { ...CURRENT, profile: undefined },
      { ...CURRENT, formatVersion: undefined },
      // P3 之前的页面：什么也没上报
      {},
      // 构建也没有：仍是 format（数据格式先看）
      { clientBuild: undefined, univerVersion: '0.9.0' },
    ]
    for (const format of cases)
      expect(checkClient(format, undefined), JSON.stringify(format)).toEqual({ ok: false, reason: 'format' })
  })

  it('构建没上报：build；设了运维开关时低于它的（认不出的写法按低于它）：build；等于、高于它的通过，+ 之后的诊断信息不比较', () => {
    expect(checkClient({ ...CURRENT, clientBuild: undefined }, undefined)).toEqual({ ok: false, reason: 'build' })
    for (const build of ['0.1.9', '0.0.99', '0.1.10+zzz'])
      expect(checkClient({ ...CURRENT, clientBuild: build }, '0.2.0'), build).toEqual({ ok: false, reason: 'build' })
    for (const build of ['0.2.0', '0.2.0+abc', '0.10.0', '1.0.0'])
      expect(checkClient({ ...CURRENT, clientBuild: build }, '0.2.0'), build).toMatchObject({ ok: true })
    // 不设开关：任何合规的构建都通过（数据格式没变的普通发布不打断编辑，US-M3-16）
    expect(checkClient({ ...CURRENT, clientBuild: '0.0.1' }, undefined)).toMatchObject({ ok: true })
  })

  it('ClientFormatGate.require：过旧时 409 CLIENT_OUTDATED，details 带原因；通过时交回核对过的页面', () => {
    const gate = clientFormatGate('0.2.0')
    expect(gate.require({ ...CURRENT, clientBuild: '0.2.1' })).toEqual({ ...CURRENT, clientBuild: '0.2.1' })
    for (const [format, reason] of [[{ ...CURRENT, clientBuild: '0.1.0' }, 'build'], [{ ...CURRENT, formatVersion: 3 }, 'format']] as const) {
      let error: unknown
      try {
        gate.require(format)
      }
      catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(AppError)
      expect(error).toMatchObject({ code: 'CLIENT_OUTDATED', status: 409, details: { reason } })
    }
  })
})

describe('documentTooNew：与文档有关的一半（回滚之后，M3-P3 设计 §3.5）', () => {
  const DOCUMENT = { type: 'sheet', profile: 'sheet@1', formatVersion: 1, sdkVersion: UNIVER_SDK_VERSION } as const

  it('SDK 版本比服务端的新、认不出：太新；相同、更旧（升级之后的存量）：不是', () => {
    for (const sdkVersion of ['1.0.2', '1.1.0', '2.0.0', 'garbage', ''])
      expect(documentTooNew({ ...DOCUMENT, sdkVersion }), sdkVersion).toBe(true)
    for (const sdkVersion of [UNIVER_SDK_VERSION, '1.0.0', '0.9.9', `${UNIVER_SDK_VERSION}+local`])
      expect(documentTooNew({ ...DOCUMENT, sdkVersion }), sdkVersion).toBe(false)
  })

  it('档案或平台格式版本不是服务端对这类文档写的：太新（不能改写成旧格式）', () => {
    expect(documentTooNew({ ...DOCUMENT, profile: 'sheet@2' as 'sheet@1' })).toBe(true)
    expect(documentTooNew({ ...DOCUMENT, formatVersion: 2 })).toBe(true)
  })

  it('requireWritableDocument：太新时 409 DOCUMENT_TOO_NEW', () => {
    expect(() => requireWritableDocument({ ...DOCUMENT, sdkVersion: '9.0.0' })).toThrow(expect.objectContaining({ code: 'DOCUMENT_TOO_NEW', status: 409 }))
    expect(() => requireWritableDocument(DOCUMENT)).not.toThrow()
  })
})

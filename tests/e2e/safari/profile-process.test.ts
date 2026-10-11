import type { ProfilePageSnapshot } from './profile-process.ts'
import { describe, expect, it } from 'vitest'
import { identifyProfilePage, revalidateProfilePage } from './profile-process.ts'

const WEB_CONTENT = '/System/Volumes/Preboot/Cryptexes/Incoming/OS/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'
const URL = 'http://127.0.0.1:40001/documents/owned?selftest=crash-recovery&next=unique'
const NAME = 'NerveOffice M4-P3 验证'
const NOW = 1_790_000_000_000
const context = () => ({ url: URL, uid: 501, mainPid: 10, deadline: NOW + 10_000, profile: { name: NAME, windowId: 123, axWindowUuid: '9dd78b07-671f-443e-b107-a0b54f40c3e4', exclusiveFromCreation: true as const, extensionsDisabled: true as const, createdAt: NOW - 9000, baseline: { capturedAt: NOW - 10_000, pids: [1, 10, 11] } } })
const process = () => ({ pid: 42, uid: 501, executable: WEB_CONTENT, startedAtUs: String(BigInt(NOW - 8000) * 1000n), bundleId: 'com.apple.WebKit.WebContent', asn: 'ASN:0x0-0xa:', appleSigned: true })
const snapshot = (): ProfilePageSnapshot => ({ capturedAt: NOW, finishedAt: NOW + 20, desktop: { idleSeconds: 150, locked: false, returned: false }, processes: [process()], windows: [{ windowId: 123, profileMatches: true, tabs: [{ index: 1, pid: 42, urlMatches: true }] }, { windowId: 456, profileMatches: false, tabs: [{ index: 1, pid: 11, urlMatches: false }] }] })
const identify = (changes: Partial<ReturnType<typeof snapshot>> = {}) => identifyProfilePage(context(), { ...snapshot(), ...changes }, NOW + 30)

describe('新建专用 Safari profile 的页面进程资格', () => {
  it('创建证明、精确窗口/URL与内核签名共同成立才交回单个 PID', () => {
    expect(identify()).toMatchObject({ kind: 'identified', target: { ...process(), windowId: 123, url: URL, profileName: NAME, observedAt: NOW } })
  })

  it.each([
    { pid: 10 },
    { pid: 11 },
    { pid: 0 },
    { pid: -42 },
    { pid: 42.5 },
    { uid: 502 },
    { appleSigned: false },
    { bundleId: 'com.apple.Safari' },
    { executable: '/tmp/com.apple.WebKit.WebContent' },
    { executable: '/Applications/Safari.app/Contents/MacOS/Safari' },
    { startedAtUs: 'unknown' },
    { startedAtUs: String(BigInt(NOW - 20_000) * 1000n) },
    { startedAtUs: String(BigInt(NOW + 1) * 1000n) },
    { asn: '' },
  ])('拒绝错误或既有内核身份 %j', (change) => {
    expect(identify({ processes: [{ ...process(), ...change }] }).kind).toBe('refused')
  })

  it.each([
    { idleSeconds: 119.99 },
    { idleSeconds: undefined },
    { idleSeconds: Number.NaN },
    { locked: true },
    { returned: true },
  ])('桌面条件 %j 不支持操作', (change) => {
    expect(identify({ desktop: { ...snapshot().desktop, ...change } }).kind).toBe('refused')
  })

  it.each([
    [],
    [{ windowId: 123, profileMatches: false, tabs: [{ index: 1, pid: 42, urlMatches: true }] }],
    [{ windowId: 321, profileMatches: true, tabs: [{ index: 1, pid: 42, urlMatches: true }] }],
    [{ windowId: 123, profileMatches: true, tabs: [{ index: 1, pid: 42, urlMatches: false }] }],
    [{ windowId: 123, profileMatches: true, tabs: [] }],
    [{ windowId: 123, profileMatches: true, tabs: [{ index: 1, pid: 42, urlMatches: true }, { index: 2, pid: 43, urlMatches: false }] }],
    [...snapshot().windows, snapshot().windows[0]!],
    [...snapshot().windows, { windowId: 999, profileMatches: true, tabs: [{ index: 1, pid: 99, urlMatches: false }] }],
    [...snapshot().windows, { windowId: 999, profileMatches: false, tabs: [{ index: 1, pid: 42, urlMatches: false }] }],
    [...snapshot().windows, { windowId: 999, profileMatches: false, tabs: [{ index: 1, pid: 43, urlMatches: true }] }],
  ].map(windows => ({ windows })))('窗口或标签映射不唯一、与创建时绑定不符则拒绝：%j', ({ windows }) => {
    expect(identify({ windows }).kind).toBe('refused')
  })

  it.each([
    { capturedAt: NOW - 3000 },
    { capturedAt: NOW + 40 },
    { finishedAt: NOW - 1 },
    { processes: [] },
    { processes: [process(), process()] },
  ])('过时、不完整或重复快照拒绝：%j', (change) => {
    expect(identify(change).kind).toBe('refused')
  })

  it('没有从创建起独占、扩展关闭和创建前基线的证明，不能凭同名窗口认领', () => {
    const base = context()
    for (const change of [{ exclusiveFromCreation: false }, { extensionsDisabled: false }, { name: '' }, { axWindowUuid: 'invalid' }, { createdAt: NOW - 20_000 }, { baseline: { capturedAt: NOW, pids: [] } }]) {
      expect(identifyProfilePage({ ...base, profile: { ...base.profile, ...change } }, snapshot(), NOW + 30).kind).toBe('refused')
    }
  })

  it('执行前必须有新鲜的第二次全部映射；同 PID 换了出生身份仍拒绝', () => {
    const first = identify()
    expect(first.kind).toBe('identified')
    if (first.kind !== 'identified')
      throw new Error('缺少准备目标')
    const next = { ...snapshot(), capturedAt: NOW + 40, finishedAt: NOW + 50 }
    expect(revalidateProfilePage(first.target, context(), snapshot(), NOW + 60).kind).toBe('refused')
    expect(revalidateProfilePage(first.target, context(), next, NOW + 60).kind).toBe('identified')
    for (const change of [{ startedAtUs: String(BigInt(NOW - 7000) * 1000n) }, { asn: 'ASN:0x0-0xb:' }, { executable: WEB_CONTENT.replace('/System/Volumes/Preboot/Cryptexes/Incoming/OS', '') }]) {
      expect(revalidateProfilePage(first.target, context(), { ...next, processes: [{ ...process(), ...change }] }, NOW + 60).kind).toBe('refused')
    }
  })
})

import type { SafariPageContext, SafariPageObservation, SafariPageSnapshot } from './page-process.ts'
import { describe, expect, it } from 'vitest'
import { identifySafariPage, revalidateSafariPage } from './page-process.ts'

const NOW = 1_791_722_500_000
const ORIGIN = 'http://127.0.0.1:49177'
const EXECUTABLE = '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent'
const context: SafariPageContext = { origin: ORIGIN, uid: 501, mainPid: 100, baseline: { capturedAt: NOW - 10_000, pids: [1, 100, 200] } }
const page: SafariPageObservation = { pid: 300, uid: 501, startedAtUs: `${(NOW - 5_000) * 1000}`, executable: EXECUTABLE, bundleId: 'com.apple.WebKit.WebContent', asn: 'ASN:0x0-0x123:', origins: [ORIGIN] }

function snapshot(processes: readonly SafariPageObservation[] = [page]): SafariPageSnapshot {
  return { capturedAt: NOW - 10, processes, desktop: { idleSeconds: 180, locked: false, returned: false } }
}

function identified() {
  const result = identifySafariPage(context, snapshot(), NOW)
  expect(result.kind).toBe('identified')
  if (result.kind !== 'identified')
    throw new Error(result.reason)
  return result.target
}

describe('真实 Safari 页面进程的纯资格判定', () => {
  it('只接受本次启动之后出现、来源列表唯一对应测试 origin 的 WebContent；报告不包含其他页面', () => {
    const other = { ...page, pid: 400, origins: ['https://unrelated.invalid'] }
    const result = identifySafariPage(context, snapshot([other, page]), NOW)
    expect(result).toEqual({ kind: 'identified', target: { ...page, origins: [ORIGIN], observedAt: NOW - 10 } })
  })

  it('支持系统 Safari 更新后的 Cryptex WebKit 路径；相同 basename 的任意其他路径不能通过', () => {
    const updated = { ...page, executable: `/System/Volumes/Preboot/Cryptexes/App${EXECUTABLE}` }
    expect(identifySafariPage(context, snapshot([updated]), NOW).kind).toBe('identified')
    expect(identifySafariPage(context, snapshot([{ ...page, executable: `/tmp${EXECUTABLE}` }]), NOW).kind).toBe('refused')
  })

  it.each([
    ['没有候选', []],
    ['两个候选', [page, { ...page, pid: 301 }]],
    ['同 PID 重复记录也拒绝', [page, page]],
    ['同 PID 的第二条记录属于其他来源', [page, { ...page, origins: ['https://unrelated.invalid'] }]],
    ['同 PID 的第二条记录没有来源', [page, { ...page, origins: undefined }]],
    ['同 PID 的第二条记录有不同 ASN', [page, { ...page, asn: 'ASN:0x0-0x456:', origins: [] }]],
    ['未知来源', [{ ...page, origins: undefined }]],
    ['空来源', [{ ...page, origins: [] }]],
    ['还承载另一个来源', [{ ...page, origins: [ORIGIN, 'https://unrelated.invalid'] }]],
    ['两个同来源页面也拒绝', [{ ...page, origins: [ORIGIN, ORIGIN] }]],
    ['只有字符串前缀相同', [{ ...page, origins: [`${ORIGIN}.invalid`] }]],
    ['其他来源', [{ ...page, origins: ['http://127.0.0.1:49178'] }]],
    ['地址带用户信息', [{ ...page, origins: ['http://user@127.0.0.1:49177'] }]],
    ['不是来源而是页面路径', [{ ...page, origins: [`${ORIGIN}/documents/123`] }]],
  ] as const)('%s', (_label, processes) => {
    expect(identifySafariPage(context, snapshot(processes), NOW).kind).toBe('refused')
  })

  it.each([
    ['Safari 主进程', { pid: 100 }],
    ['基线已有的未知页面', { pid: 200 }],
    ['其他 UID', { uid: 502 }],
    ['Safari 主程序路径', { executable: '/Applications/Safari.app/Contents/MacOS/Safari' }],
    ['Playwright WebKit', { bundleId: 'org.webkit.WebKitTestRunner' }],
    ['主程序 bundle', { bundleId: 'com.apple.Safari' }],
    ['无启动时刻', { startedAtUs: '' }],
    ['出生早于基线', { startedAtUs: `${(NOW - 11_000) * 1000}` }],
    ['出生晚于观测', { startedAtUs: `${(NOW + 1) * 1000}` }],
    ['无 ASN', { asn: '' }],
    ['系统 PID', { pid: 1 }],
    ['负 PID', { pid: -300 }],
    ['非整数 PID', { pid: 300.5 }],
  ] as const)('%s 不作为目标', (_label, change) => {
    expect(identifySafariPage(context, snapshot([{ ...page, ...change }]), NOW).kind).toBe('refused')
  })

  it.each([
    ['锁屏', { idleSeconds: 180, locked: true, returned: false }],
    ['用户回来过', { idleSeconds: 180, locked: false, returned: true }],
    ['空闲不足两分钟', { idleSeconds: 119.9, locked: false, returned: false }],
    ['空闲读不到', { idleSeconds: undefined, locked: false, returned: false }],
    ['空闲读值无效', { idleSeconds: Number.NaN, locked: false, returned: false }],
  ] as const)('%s 拒绝', (_label, desktop) => {
    expect(identifySafariPage(context, { ...snapshot(), desktop }, NOW).kind).toBe('refused')
  })

  it.each([NOW - 2_001, NOW + 1, Number.NaN])('不是当前新鲜观测（%s）时拒绝', (capturedAt) => {
    expect(identifySafariPage(context, { ...snapshot(), capturedAt }, NOW).kind).toBe('refused')
  })

  it('只接收本次独占的回环 origin，缺失基线或基线晚于观测时拒绝', () => {
    for (const origin of ['https://example.com', 'http://127.0.0.1', `${ORIGIN}/page`, `${ORIGIN}?x=1`])
      expect(identifySafariPage({ ...context, origin }, snapshot(), NOW).kind).toBe('refused')
    expect(identifySafariPage({ ...context, baseline: { capturedAt: NOW, pids: [] } }, snapshot(), NOW).kind).toBe('refused')
    expect(identifySafariPage({ ...context, baseline: { ...context.baseline, pids: [] } }, snapshot(), NOW).kind).toBe('refused')
  })

  it('保留初次认出的事实副本，调用者之后改原观测不能改变目标', () => {
    const origins = [ORIGIN]
    const mutable = { ...page, origins }
    const result = identifySafariPage(context, snapshot([mutable]), NOW)
    expect(result.kind).toBe('identified')
    origins.push('https://unrelated.invalid')
    mutable.pid = 999
    if (result.kind === 'identified') {
      expect(result.target.pid).toBe(300)
      expect(result.target.origins).toEqual([ORIGIN])
      expect(Object.isFrozen(result.target)).toBe(true)
      expect(Object.isFrozen(result.target.origins)).toBe(true)
    }
  })
})

describe('执行前重新读取并核对同一个 Safari 页面进程', () => {
  it('新观测仍是同 PID、UID、出生时刻、路径、bundle、ASN 与来源才通过', () => {
    expect(revalidateSafariPage(identified(), context, { ...snapshot(), capturedAt: NOW }, NOW).kind).toBe('identified')
  })

  it.each([
    ['PID 换了', { pid: 301 }],
    ['PID 被复用', { startedAtUs: `${(NOW - 4_000) * 1000}` }],
    ['ASN 换了', { asn: 'ASN:0x0-0x456:' }],
    ['UID 换了', { uid: 502 }],
    ['可执行文件换了', { executable: `/System/Volumes/Preboot/Cryptexes/App${EXECUTABLE}` }],
    ['来源换了', { origins: ['http://127.0.0.1:49178'] }],
  ] as const)('%s 拒绝', (_label, change) => {
    expect(revalidateSafariPage(identified(), context, { ...snapshot([{ ...page, ...change }]), capturedAt: NOW }, NOW).kind).toBe('refused')
  })

  it('执行前锁屏、出现用户活动、多了候选或用了旧观测都拒绝', () => {
    const target = identified()
    const current = { ...snapshot(), capturedAt: NOW }
    expect(revalidateSafariPage(target, context, { ...current, desktop: { ...current.desktop, locked: true } }, NOW).kind).toBe('refused')
    expect(revalidateSafariPage(target, context, { ...current, desktop: { ...current.desktop, returned: true } }, NOW).kind).toBe('refused')
    expect(revalidateSafariPage(target, context, { ...current, processes: [page, { ...page, pid: 301 }] }, NOW).kind).toBe('refused')
    expect(revalidateSafariPage(target, context, { ...current, processes: [page, { ...page, origins: ['https://unrelated.invalid'] }] }, NOW).kind).toBe('refused')
    expect(revalidateSafariPage(target, context, { ...current, processes: [page, { ...page, origins: undefined }] }, NOW).kind).toBe('refused')
    expect(revalidateSafariPage(target, context, { ...current, capturedAt: target.observedAt }, NOW).kind).toBe('refused')
    expect(revalidateSafariPage(target, context, { ...current, capturedAt: target.observedAt - 1 }, NOW).kind).toBe('refused')
  })
})

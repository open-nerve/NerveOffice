// 仅验证诊断的选择、脱敏与限额；不模拟 Playwright，也不证明原 WebKit 波动已修复。
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createLoginPopupLog, isLoginPopupTarget, isLoginPopupUrl } from './login-popup-diagnostic.ts'

const TARGET = {
  file: '/repo/tests/e2e/specs/editor/autosave.spec.ts',
  title: 'US-M3-02 登录过期：自动保存的上传得到 401 之后暂停（页头说暂停保存、登录回来之后自动保存），之后不再发请求——没有 401 接连不断；本人在新标签页登录回来之后自动上传',
  project: 'webkit',
}

describe('登录 popup 的有界诊断（补证，不修改测试结果）', () => {
  it('只有显式开关和精确 WebKit 原故事启用，近似标题或其他文件不启用', () => {
    expect(isLoginPopupTarget(TARGET, '1')).toBe(true)
    for (const enabled of [undefined, '', '0', 'true'])
      expect(isLoginPopupTarget(TARGET, enabled)).toBe(false)
    for (const target of [
      { ...TARGET, title: `${TARGET.title} 另一个故事` },
      { ...TARGET, file: '/repo/tests/e2e/specs/accounts/autosave.spec.ts' },
      { ...TARGET, file: `${TARGET.file}.backup` },
      { ...TARGET, project: 'chrome' },
    ]) {
      expect(isLoginPopupTarget(target, '1')).toBe(false)
    }
  })

  it('保留请求关联、时序和状态；URL 只保留 path，额外敏感字段不进入附件', () => {
    const log = createLoginPopupLog()
    const privateMarker = 'PRIVATE-DIAGNOSTIC-MARKER'
    const input = {
      kind: 'response' as const,
      at: '2026-10-29T00:00:00.000Z',
      monotonicMs: 42.5,
      pageId: 2,
      requestId: 1,
      status: 200,
      url: `http://${privateMarker}@127.0.0.1:1234/login?token=${privateMarker}#${privateMarker}`,
      headers: { cookie: privateMarker },
      body: privateMarker,
      errorText: privateMarker,
    }
    log.record(input)
    const report = log.snapshot()
    expect(report.events).toEqual([{
      kind: 'response',
      at: input.at,
      monotonicMs: 42.5,
      pageId: 2,
      requestId: 1,
      status: 200,
      path: '/login',
    }])
    expect(JSON.stringify(report)).not.toContain(privateMarker)
    expect(report.truncated).toBe(false)
    expect(report.dropped).toBe(0)
  })

  it('默认最多 256 个事件，超限只记截断和丢弃数量，不继续保存完整事件', () => {
    const log = createLoginPopupLog()
    for (let requestId = 1; requestId <= 300; requestId++)
      log.record({ kind: 'request', at: '2026-10-29T00:00:00.000Z', monotonicMs: requestId, requestId, url: 'http://127.0.0.1/login' })
    const report = log.snapshot()
    expect(report.events).toHaveLength(256)
    expect(report.events[0]?.requestId).toBe(1)
    expect(report.events.at(-1)?.requestId).toBe(256)
    expect(report.truncated).toBe(true)
    expect(report.dropped).toBe(44)
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(128 * 1024)
  })

  it('KiB 样例按整个附件的编码字节计量，保留前缀与截断说明也不能越界', () => {
    const log = createLoginPopupLog({ maxBytes: 1024 })
    for (let requestId = 1; requestId <= 30; requestId++)
      log.record({ kind: 'frame', at: '2026-10-29T00:00:00.000Z', monotonicMs: requestId, requestId, url: `http://127.0.0.1/${'文'.repeat(12)}` })
    const report = log.snapshot()
    expect(report.events.length).toBeGreaterThan(0)
    expect(report.events.length).toBeLessThan(30)
    expect(report.events[0]?.requestId).toBe(1)
    expect(report.truncated).toBe(true)
    expect(report.dropped).toBe(30 - report.events.length)
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(1024)
  })

  it('地址不可解析时记录未知 path，不把原字符串或采集异常当产品失败', () => {
    const log = createLoginPopupLog()
    expect(() => log.record({ kind: 'requestfailed', at: '2026-10-29T00:00:00.000Z', monotonicMs: 1, requestId: 1, url: 'PRIVATE-INVALID-URL' })).not.toThrow()
    expect(log.snapshot().events[0]?.path).toBeNull()
    expect(JSON.stringify(log.snapshot())).not.toContain('PRIVATE-INVALID-URL')
  })

  it('已记录的事件不持有调用方原对象，后续原对象修改不能改写证据', () => {
    const log = createLoginPopupLog()
    const input = { kind: 'request' as const, at: '2026-10-29T00:00:00.000Z', monotonicMs: 1, requestId: 1, url: 'http://127.0.0.1/login' }
    log.record(input)
    input.requestId = 999
    input.url = 'http://127.0.0.1/changed'
    expect(log.snapshot().events[0]).toMatchObject({ requestId: 1, path: '/login' })
  })

  it('首次观察页已在同源登录地址时可以识别；about:blank、异源与其他路径不冒充登录页', () => {
    const origin = 'http://127.0.0.1:1234'
    expect(isLoginPopupUrl(`${origin}/login?returnTo=private`, origin)).toBe(true)
    for (const url of ['about:blank', 'invalid', `${origin}/login/other`, 'http://127.0.0.1:9999/login'])
      expect(isLoginPopupUrl(url, origin)).toBe(false)
    const log = createLoginPopupLog()
    log.record({ kind: 'page-observed', at: '2026-10-29T00:00:00.000Z', monotonicMs: 2, pageId: 1, url: `${origin}/login` })
    expect(log.snapshot().events.map(event => event.kind)).toEqual(['page-observed'])
  })

  it('同步封存后迟到事件和采集错误不能改写附件；重复封存得到相同字节', () => {
    const log = createLoginPopupLog()
    log.record({ kind: 'request', at: '2026-10-29T00:00:00.000Z', monotonicMs: 1, requestId: 1, url: 'http://127.0.0.1/login' })
    const sealed = log.seal()
    log.record({ kind: 'load', at: '2026-10-29T00:00:01.000Z', monotonicMs: 2, pageId: 1, url: 'http://127.0.0.1/login' })
    log.markIncomplete()
    expect(log.seal()).toBe(sealed)
    expect(JSON.stringify(log.snapshot())).toBe(sealed)
    expect(log.snapshot().events.map(event => event.kind)).toEqual(['request'])
    expect(log.snapshot().incomplete).toBe(false)
  })
})

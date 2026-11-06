import { describe, expect, it } from 'vitest'
import { parseContainerEvents, upgradeOrder } from './compose-upgrade-order.ts'

const BASE = 1_730_000_000_000_000_000
function line(action: string, id: string, service: string, offsetMs: number, extra: Record<string, string> = {}, type = 'container'): string {
  return JSON.stringify({ Type: type, Action: action, Actor: { ID: id, Attributes: { 'com.docker.compose.service': service, ...extra } }, timeNano: BASE + offsetMs * 1e6 })
}

describe('M5-P7 Q-08 compose 升级时旧 app 停止与 migrate 启动的先后', () => {
  it('旧 app 先退出、迁移随后启动并成功：与部署说明一致', () => {
    const events = parseContainerEvents([
      line('kill', 'old', 'app', 0, { signal: '15' }),
      line('die', 'old', 'app', 900, { exitCode: '0' }),
      line('exec_start: /bin/sh -c pg_isready', 'db1', 'db', 950),
      line('start', 'mig2', 'migrate', 1200),
      line('die', 'mig2', 'migrate', 2600, { exitCode: '0' }),
      line('start', 'new', 'app', 2700),
      line('pull', 'img', 'app', 2800, {}, 'image'),
    ].join('\n'))
    expect(events.map(event => event.action)).toEqual(['kill', 'die', 'start', 'die', 'start'])
    expect(upgradeOrder(events, 'old')).toMatchObject({ verdict: 'old-app-stopped-before-migrate', oldAppDiedMs: 900, migrateStartedMs: 1200, migrateExitCode: '0', newAppStartedMs: 2700 })
  })

  it('迁移在旧 app 退出之前启动：与部署说明不一致', () => {
    const events = parseContainerEvents([
      line('start', 'mig2', 'migrate', 0),
      line('die', 'mig2', 'migrate', 1000, { exitCode: '0' }),
      line('kill', 'old', 'app', 1100, { signal: '15' }),
      line('die', 'old', 'app', 1500, { exitCode: '0' }),
      line('start', 'new', 'app', 1600),
    ].join('\n'))
    expect(upgradeOrder(events, 'old').verdict).toBe('migrate-started-while-old-app-running')
  })

  it('缺少任何一个关键事件时不下结论；时间线只标旧 app，不带容器 ID', () => {
    const order = upgradeOrder(parseContainerEvents(`${line('die', 'old', 'app', 0)}\n${line('start', 'mig2', 'migrate', 5)}\n`), 'old')
    expect(order.verdict).toBe('incomplete')
    expect(order.timeline).toEqual([{ ms: 0, service: 'app', role: 'old-app', action: 'die' }, { ms: 5, service: 'migrate', role: 'other', action: 'start' }])
    expect(JSON.stringify(order)).not.toContain('mig2')
  })

  it('不是 docker events 的 JSON 时直接失败', () => {
    expect(() => parseContainerEvents('not json')).toThrow()
    expect(() => parseContainerEvents(JSON.stringify({ Type: 'container' }))).toThrow()
  })
})

import type { ConnectionView } from '../../shared/lib/connection-state.ts'
import { describe, expect, it } from 'vitest'
import { createConnectionState } from '../../shared/lib/connection-state.ts'
import { localSaveTransportFailed } from './selftest-local-save-connection.ts'

describe('离线测量的客户端实际连接失败', () => {
  it('租约心跳先失败、上传因此暂停时仍能证明实际 API 传输失败', () => {
    const connection = createConnectionState({ online: true, now: () => 150 })
    const generation = connection.view().generation
    connection.failed(connection.beginRequest())
    expect(localSaveTransportFailed(connection.view(), generation, 100)).toBe(true)
  })
  it.each([
    { available: true },
    { browserOnline: false, problem: 'offline' },
    { problem: undefined },
    { generation: 2 },
    { since: 99 },
    { since: undefined },
  ] as Partial<ConnectionView>[])('已恢复、浏览器离线信号或本轮之前的失败不作为新 API 失败 %j', (change) => {
    const view: ConnectionView = { browserOnline: true, available: false, problem: 'unresponsive', since: 150, generation: 3, ...change }
    expect(localSaveTransportFailed(view, 2, 100)).toBe(false)
  })
})

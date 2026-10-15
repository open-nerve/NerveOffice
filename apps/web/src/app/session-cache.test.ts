import type { SessionResponse } from '@nerve-office/contracts'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SESSION_QUERY_KEY, sessionQueryOptions } from '../features/auth/index.ts'
import { associatedSessionPermit, rememberSessionPermit } from '../shared/api/session-association.ts'
import { createQueryClient } from './query-client.ts'

const USER_ID = '0199a2c4-1f2e-7a3b-8c4d-00000000000a'
const FIRST = { userId: USER_ID, generation: '0199a2c4-1f2e-7a3b-8c4d-000000000001' }
const NEXT = { userId: USER_ID, generation: '0199a2c4-1f2e-7a3b-8c4d-000000000002' }

function response(csrfToken = 'csrf-1'): SessionResponse {
  return {
    user: { id: USER_ID, username: 'alice', displayName: '爱丽丝', systemRole: 'member' },
    personalSpace: { id: USER_ID, name: '爱丽丝' },
    csrfToken,
    features: { localDraftsEnabled: true },
  }
}

function appClient() {
  return createQueryClient({ unauthenticated: vi.fn(), sessionExpired: vi.fn(), signedIn: vi.fn(), signedOut: vi.fn(), sessionStale: vi.fn(), requestSucceeded: vi.fn() })
}

describe('会话缓存保留请求对象的来源资格', () => {
  for (const mode of ['set', 'fetch'] as const) {
    for (const change of ['new-csrf', 'same-fields', 'unqualified'] as const) {
      it(`${mode} / ${change}：新响应的资格不能丢失，也不能借用旧响应的资格`, async () => {
        // set 覆盖尚未挂载会话查询的登录/改密写缓存；fetch 验证查询选项本身的约束。
        const client = mode === 'set' ? appClient() : new QueryClient()
        onTestFinished(() => client.clear())
        const original = response()
        rememberSessionPermit(original, FIRST)
        client.setQueryData(SESSION_QUERY_KEY, original)
        const next = response(change === 'new-csrf' ? 'csrf-2' : 'csrf-1')
        const permit = change === 'unqualified' ? undefined : NEXT
        rememberSessionPermit(next, permit)
        if (mode === 'set')
          client.setQueryData(SESSION_QUERY_KEY, next)
        else
          await client.fetchQuery({ ...sessionQueryOptions(), staleTime: 0, queryFn: async () => next })
        const cached = client.getQueryData<SessionResponse>(SESSION_QUERY_KEY)!
        expect(associatedSessionPermit(cached)).toEqual(permit)
        expect(cached).toBe(next)
        expect(associatedSessionPermit(original)).toEqual(FIRST)
      })
    }
  }

  it('其他查询仍保留结构复用的默认行为', () => {
    const client = appClient()
    onTestFinished(() => client.clear())
    const original = { name: 'document' }
    client.setQueryData(['documents'], original)
    client.setQueryData(['documents'], { name: 'document' })
    expect(client.getQueryData(['documents'])).toBe(original)
  })
})

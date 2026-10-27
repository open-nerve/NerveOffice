import { requestBackgroundSession, requestSession } from '../../shared/api/session.ts'
import { sessionRequestCases } from '../../shared/testing/session-requests.test-support.ts'
import { login } from './session.ts'

sessionRequestCases([
  { name: '查询', kind: 'query', method: 'GET', path: '/api/auth/session', call: async () => requestSession() },
  { name: '后台查询', kind: 'query', method: 'GET', path: '/api/auth/session/check', call: async () => requestBackgroundSession() },
  { name: '登录', kind: 'mutation', method: 'POST', path: '/api/auth/login', call: async () => login({ username: 'alice', password: 'test-password' }) },
])

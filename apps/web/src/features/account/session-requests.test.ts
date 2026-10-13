import { sessionRequestCases } from '../../shared/testing/session-requests.test-support.ts'
import { changePassword } from './account-api.ts'
import { acceptInvitation, completePasswordReset } from './links-api.ts'

sessionRequestCases([
  { name: '改密', kind: 'mutation', method: 'PUT', path: '/api/auth/password', call: async () => changePassword({ currentPassword: 'before-password', newPassword: 'after-password' }) },
  { name: '接受邀请', kind: 'mutation', method: 'POST', path: '/api/auth/invitations/accept', call: async () => acceptInvitation({ token: 'invitation', displayName: '爱丽丝', password: 'test-password' }) },
  { name: '完成重置', kind: 'mutation', method: 'POST', path: '/api/auth/password-resets/complete', call: async () => completePasswordReset({ token: 'password-reset', password: 'test-password' }) },
])

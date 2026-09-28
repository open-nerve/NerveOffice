import { Navigate } from 'react-router'
import { ADMIN_PATHS } from '../../shared/lib/admin-paths.ts'

/** /admin 默认打开账户页 */
export function AdminIndex() {
  return <Navigate to={ADMIN_PATHS.users} replace />
}

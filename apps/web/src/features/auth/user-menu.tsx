import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { isAuthenticationError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Button } from '../../shared/ui/index.ts'
import { HANDLES_AUTHENTICATION, logout, sessionQueryOptions } from './session.ts'

/**
 * 页头右侧：当前用户与退出（US-M1-02）。退出后清空全部缓存的数据，以替换历史记录的方式回到登录页：
 * 按后退键回到之前的页面时，数据要重新请求，得到 401 后又回到登录页，看不到内容。
 */
export function UserMenu() {
  const session = useQuery(sessionQueryOptions())
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: logout,
    meta: HANDLES_AUTHENTICATION,
    onSettled: (_data, error) => {
      // 会话已经不在了也算退出成功；网络等其他错误留在原页面，提示重试
      if (error === null || isAuthenticationError(error)) {
        queryClient.clear()
        void navigate('/login', { replace: true })
      }
    },
  })
  return (
    <div className="flex items-center gap-3">
      {session.data !== undefined && <span className="text-sm text-muted-foreground">{session.data.user.displayName}</span>}
      {mutation.isError && !isAuthenticationError(mutation.error) && <span role="alert" className="text-sm text-destructive">{messages.auth.logoutFailed}</span>}
      <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? messages.auth.loggingOut : messages.auth.logout}
      </Button>
    </div>
  )
}

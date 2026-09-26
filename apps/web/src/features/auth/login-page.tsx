import type { SyntheticEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { describeError } from '../../shared/api/index.ts'
import { messages } from '../../shared/i18n/index.ts'
import { Alert, AlertDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from '../../shared/ui/index.ts'
import { redirectTarget } from './login-path.ts'
import { HANDLES_AUTHENTICATION, login, SESSION_QUERY_KEY, sessionQueryOptions } from './session.ts'

/** 登录页（US-M1-02）：已登录时直接回去；错误分别提示；提交中不能重复提交。 */
export function LoginPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = useQuery(sessionQueryOptions())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const usernameId = useId()
  const passwordId = useId()
  const target = redirectTarget(params.get('from'))
  const mutation = useMutation({
    mutationFn: login,
    meta: HANDLES_AUTHENTICATION,
    onSuccess: (data) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, data)
      void navigate(target, { replace: true })
    },
  })

  if (session.data !== undefined && !mutation.isPending)
    return <Navigate to={target} replace />

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!mutation.isPending)
      mutation.mutate({ username, password })
  }

  const error = mutation.isError ? describeError(mutation.error) : undefined
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg">{messages.app.name}</h1>
          </CardTitle>
          <CardDescription>{messages.auth.loginDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate aria-label={messages.auth.loginTitle}>
            {params.get('reason') === 'expired' && error === undefined && (
              <Alert>
                <AlertDescription>{messages.auth.sessionExpired}</AlertDescription>
              </Alert>
            )}
            {error !== undefined && (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor={usernameId}>{messages.auth.username}</Label>
              <Input id={usernameId} name="username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={passwordId}>{messages.auth.password}</Label>
              <Input id={passwordId} name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
            </div>
            <Button type="submit" disabled={mutation.isPending || username.trim() === '' || password === ''}>
              {mutation.isPending ? messages.auth.submitting : messages.auth.submit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}

import { Link } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { buttonVariants } from '../../shared/ui/index.ts'

export function NotFoundPage() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-3 p-6">
      <h1 className="text-xl font-semibold">{messages.notFound.title}</h1>
      <p className="text-muted-foreground">{messages.notFound.description}</p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>{messages.common.backHome}</Link>
    </main>
  )
}

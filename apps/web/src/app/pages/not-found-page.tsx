import { Link } from 'react-router'
import { messages } from '../../shared/i18n/index.ts'
import { buttonVariants } from '../../shared/ui/index.ts'

/** 页面不存在。显示在登录后的页面框架里（它提供 main 地标），这里不再套一层 main。 */
export function NotFoundPage() {
  return (
    <section className="flex max-w-md flex-col items-start gap-3" aria-labelledby="not-found-title">
      <h1 id="not-found-title" className="text-xl font-semibold">{messages.notFound.title}</h1>
      <p className="text-muted-foreground">{messages.notFound.description}</p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>{messages.common.backHome}</Link>
    </section>
  )
}

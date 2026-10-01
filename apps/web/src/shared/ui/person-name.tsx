// 界面上的人名（M2-P6 复核 M2）：同事选择的候选与已选、成员表、管理界面、审计、回收站的删除者、页头的账户都用它。
import { messages } from '../i18n/index.ts'

interface PersonNameProps {
  readonly person: { readonly displayName: string, readonly username: string }
  readonly className?: string
  /** 收窄成省略号的地方（页头）给出完整的名字：用 messages.people.text */
  readonly title?: string
}

/**
 * 一个人：登录名在前、显示名在后，分开呈现。
 * - 登录名放在自己的元素里，等宽、灰色、前面带 @。登录名只含 [a-z0-9._-]、全库唯一，排在最前：显示名是本人填的，什么都能写
 *   （例如"李四 @lisi"），放在后面就冒充不了开头——看的人与读屏用户从第一个词就分得清是谁（M2-P6 复核第二批 M-1；
 *   原来显示名在前，同事选择的候选读出来是"李四 @lisi"与"李四 @lisi @eve"，开头相同）；
 * - 显示名用 <bdi> 包住：从右到左的显示名（希伯来文、阿拉伯文）不打乱两边的字，例如回收站里"删除者，时间"的那一格。
 * 视觉上同样是登录名在前：按钮、标题的可读名称取自这里的文字，看到的与读出来的是同一串（WCAG 2.5.3），各处的人名也是同一个样子。
 * 两段之间是一个真的空格：拼成可读名称（按钮的名字、表格的单元格）时两段不粘在一起。
 * 拼进纯文字的地方（确认框的标题、aria-label、title）用 messages.people.text，同样登录名在前。
 */
export function PersonName({ person, className, title }: PersonNameProps) {
  return (
    <span data-slot="person-name" className={className} title={title}>
      <span data-slot="person-username" className="font-mono text-[0.9em] font-normal text-muted-foreground">{messages.people.username(person.username)}</span>
      {' '}
      <bdi data-slot="person-display-name">{person.displayName}</bdi>
    </span>
  )
}

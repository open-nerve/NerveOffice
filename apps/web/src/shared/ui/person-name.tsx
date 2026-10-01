// 界面上的人名（M2-P6 复核 M2）：同事选择的候选与已选、成员表、管理界面、审计、回收站的删除者、页头的账户都用它。
import { messages } from '../i18n/index.ts'

interface PersonNameProps {
  readonly person: { readonly displayName: string, readonly username: string }
  readonly className?: string
  /** 收窄成省略号的地方（页头）给出完整的名字：用 messages.people.text */
  readonly title?: string
}

/**
 * 一个人：显示名与登录名分开呈现。
 * - 显示名用 <bdi> 包住：从右到左的显示名（希伯来文、阿拉伯文）不打乱两边的字，例如回收站里"删除者，时间"的那一格；
 * - 登录名放在另一个元素里，等宽、灰色、前面带 @。显示名是本人填的，可以写成"李四（lisi）"：登录名的样式与它明显不同，
 *   显示名里的字冒充不了登录名，选人时不会把"李四 @mallory"看成李四。
 * 两段之间是一个真的空格：拼成可读名称（按钮的名字、表格的单元格）时两段不粘在一起。
 * 拼进纯文字的地方（确认框的标题、aria-label、title）用 messages.people.text。
 */
export function PersonName({ person, className, title }: PersonNameProps) {
  return (
    <span data-slot="person-name" className={className} title={title}>
      <bdi data-slot="person-display-name">{person.displayName}</bdi>
      {' '}
      <span data-slot="person-username" className="font-mono text-[0.9em] font-normal text-muted-foreground">{messages.people.username(person.username)}</span>
    </span>
  )
}

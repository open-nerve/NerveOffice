// 界面上的人名（M2-P6 复核 M2，第二批 M-1）：登录名在前、显示名在后，分开呈现（PersonName：登录名在单独的元素里、前面带 @，
// 显示名在 <bdi> 里）；拼进纯文字的地方（确认框的标题、按钮与选择框的 aria-label）同样登录名在前，显示名用 FSI…PDI 隔离。
// 登录名排在最前：显示名是本人填的、什么都能写（例如"李四 @lisi"），放在后面冒充不了开头。

interface Person {
  readonly displayName: string
  readonly username: string
}

/** 界面上看到的、以及按钮的可读名称里的人名：@登录名、一个空格、显示名 */
export function shownName(person: Person): string {
  return `@${person.username} ${person.displayName}`
}

/** 纯文字里的人名（aria-label、确认框的标题）：与 apps/web 的 messages.people.text 相同的写法 */
export function plainName(person: Person): string {
  return `@${person.username} \u2068${person.displayName}\u2069`
}

// 界面上的人名（M2-P6 复核 M2）：显示名与登录名分开呈现（PersonName：显示名在 <bdi> 里，登录名在另一个元素里、前面带 @）；
// 拼进纯文字的地方（确认框的标题、按钮与选择框的 aria-label）把显示名用 FSI…PDI 隔离，登录名照样带 @ 标出。

interface Person {
  readonly displayName: string
  readonly username: string
}

/** 界面上看到的、以及按钮的可读名称里的人名：显示名、一个空格、@登录名 */
export function shownName(person: Person): string {
  return `${person.displayName} @${person.username}`
}

/** 纯文字里的人名（aria-label、确认框的标题）：与 apps/web 的 messages.people.text 相同的写法 */
export function plainName(person: Person): string {
  return `\u2068${person.displayName}\u2069 @${person.username}`
}

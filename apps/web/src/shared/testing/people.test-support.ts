// 测试用：人名的写法（M2-P6 复核 M2，第二批 M-1）。界面上用 PersonName 呈现（登录名在前、在单独的元素里、前面带 @，显示名在后、在 <bdi> 里），
// 纯文字的地方（确认框的标题、aria-label、title）同样登录名在前，显示名用 FSI…PDI 隔离。
import { within } from '@testing-library/react'

/** 纯文字里的人名：与 messages.people.text 相同的写法，测试里写出来，免得只是拿实现对实现 */
export function plainName(displayName: string, username: string): string {
  return `@${username} \u2068${displayName}\u2069`
}

/** 读屏与按钮的可读名称里的人名（PersonName 的文字内容）：@登录名、一个空格、显示名 */
export function shownName(displayName: string, username: string): string {
  return `@${username} ${displayName}`
}

/**
 * 容器里呈现这个人的 PersonName：登录名在单独的元素里、排在前面，显示名在 <bdi> 里、排在后面（DOM 断言，M2-P6 复核 M2、第二批 M-1）。
 * 找不到、不止一个，或者登录名没有排在显示名前面时抛错
 */
export function personIn(container: HTMLElement, displayName: string, username: string): HTMLElement {
  const found = within(container).queryAllByText((_content, element) => element?.getAttribute('data-slot') === 'person-name'
    && element.querySelector('bdi')?.textContent === displayName
    && element.querySelector('[data-slot="person-username"]')?.textContent === `@${username}`)
  if (found.length !== 1)
    throw new Error(`找到 ${found.length} 个"@${username} ${displayName}"`)
  const person = found[0] as HTMLElement
  const shown = person.querySelector('bdi')
  const login = person.querySelector('[data-slot="person-username"]')
  if (shown === null || login === null || (login.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING) === 0)
    throw new Error(`"@${username} ${displayName}"的登录名没有排在显示名前面`)
  return person
}

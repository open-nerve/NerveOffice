// 测试用：人名的写法（M2-P6 复核 M2）。界面上用 PersonName 呈现（显示名在 <bdi> 里，登录名在另一个元素里、前面带 @），
// 纯文字的地方（确认框的标题、aria-label、title）用 FSI…PDI 隔离显示名。
import { within } from '@testing-library/react'

/** 纯文字里的人名：与 messages.people.text 相同的写法，测试里写出来，免得只是拿实现对实现 */
export function plainName(displayName: string, username: string): string {
  return `\u2068${displayName}\u2069 @${username}`
}

/** 读屏与按钮的可读名称里的人名（PersonName 的文字内容）：显示名、一个空格、@登录名 */
export function shownName(displayName: string, username: string): string {
  return `${displayName} @${username}`
}

/**
 * 容器里呈现这个人的 PersonName：显示名在 <bdi> 里、登录名在单独的元素里（DOM 断言，M2-P6 复核 M2）。
 * 找不到或者不止一个时抛错
 */
export function personIn(container: HTMLElement, displayName: string, username: string): HTMLElement {
  const found = within(container).queryAllByText((_content, element) => element?.getAttribute('data-slot') === 'person-name'
    && element.querySelector('bdi')?.textContent === displayName
    && element.querySelector('[data-slot="person-username"]')?.textContent === `@${username}`)
  if (found.length !== 1)
    throw new Error(`找到 ${found.length} 个"${displayName} @${username}"`)
  return found[0] as HTMLElement
}

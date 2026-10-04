// 页面自检在页面上的操作（M3-P2 设计 §3.5，只在测试构建里，随 ./selftest.ts 动态引入）：合成的指针与按键事件、按角色与名称找界面上的元素。
// - 合成事件不是可信的输入（isTrusted 为假），浏览器不给它们默认行为（不会输入文字、不会弹出原生菜单），只走页面里的监听：
//   Univer 的快捷键服务与画布的指针处理都不看 isTrusted，所以快捷键、点选单元格、右键这些到得了 SDK；可信的键盘输入与输入法
//   不在自检的范围里（由 Playwright 的 WebKit 覆盖，设计 §3.5 第 4 条）；
// - 找元素按可访问的角色与名称（与 E2E 的 getByRole 同样的看法），不用 SDK 的 DOM 标记 data-u-comp（它只在 internal-api 登记，lint 拦下）；
//   画布按 SDK 给它的 id 前缀找（与 E2E 的 support/sheet.ts 相同）。

/** Univer 是不是把这个页面当作苹果的平台（与 ui 的 PlatformService.isMac 同一个判断，E2E 的 support/keyboard.ts 也这样判断） */
export function univerIsMac(): boolean {
  return /Mac/.test(navigator.appVersion)
}

/** 等到 predicate 为真，最多等 timeoutMs；返回最后一次的结果 */
export async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (predicate())
      return true
    if (performance.now() >= deadline)
      return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * 等两个动画帧：SDK 在动画帧里结算的状态（右键菜单的弹出、对话框的渲染）这时已经处理完（与 E2E 的 nextFrames 相同）。
 * 页面隐藏时浏览器不给动画帧：timeoutMs 之后返回 false
 */
export async function nextFrames(timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs, false)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve(true)
    }))
  })
}

// ---- 按键 ----

/** 一个组合键：主修饰键（primary）按 Univer 对平台的判断取 Meta 或 Control；ctrl 是 Control 键本身（苹果的平台上是 MAC_CTRL） */
export interface KeyCombo {
  readonly key: string
  readonly code: string
  /** Univer 按 keyCode 换算绑定（ui 的 shortcut.service.ts 的 _deriveBindingFromEvent） */
  readonly keyCode: number
  readonly primary?: true
  readonly shift?: true
  readonly alt?: true
  readonly ctrl?: true
}

/**
 * 按键事件的目标：页面的焦点在编辑器的容器里时就是它，否则是画布。SDK 只派发目标在它的容器（#sheet-editor）里的按键
 * （shortcut.service.ts 的 dispatch：checkElementInCurrentContainers）；快捷键的前提条件看的是 SDK 的上下文（聚焦的单元等），不看 DOM 的焦点
 */
export function keyboardTarget(surface: HTMLElement): Element {
  const active = document.activeElement
  if (active !== null && active !== document.body && surface.contains(active))
    return active
  return sheetCanvas(surface) ?? surface
}

function keyboardEvent(type: 'keydown' | 'keyup', combo: KeyCombo): KeyboardEvent {
  const mac = univerIsMac()
  const event = new KeyboardEvent(type, {
    key: combo.key,
    code: combo.code,
    bubbles: true,
    cancelable: true,
    composed: true,
    metaKey: combo.primary === true && mac,
    ctrlKey: (combo.primary === true && !mac) || combo.ctrl === true,
    shiftKey: combo.shift === true,
    altKey: combo.alt === true,
  })
  // keyCode 是遗留的只读属性，构造参数里不一定认（各浏览器不同）：在这个事件对象上定义它
  Object.defineProperty(event, 'keyCode', { get: () => combo.keyCode })
  Object.defineProperty(event, 'which', { get: () => combo.keyCode })
  return event
}

/** 按下再松开一个组合键（合成事件） */
export function pressKeys(target: Element, combo: KeyCombo): void {
  target.dispatchEvent(keyboardEvent('keydown', combo))
  target.dispatchEvent(keyboardEvent('keyup', combo))
}

// ---- 指针 ----

/**
 * 合成的指针事件（鼠标）。pointerId 用鼠标的 1：浏览器总把鼠标当作活动的指针，SDK 在按下时对它 setPointerCapture
 * （工作表标签的 slide-tab-bar.ts）；用别的号会抛出 NotFoundError，成为页面错误
 */
function pointerInit(x: number, y: number, button: number, buttons: number): PointerEventInit {
  return { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true, detail: 1 }
}

/** 在页面上这一点（视口坐标）左键点一下：pointerdown、mousedown、pointerup、mouseup、click */
export function clickAt(target: Element, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent('pointerdown', pointerInit(x, y, 0, 1)))
  target.dispatchEvent(new MouseEvent('mousedown', pointerInit(x, y, 0, 1)))
  target.dispatchEvent(new PointerEvent('pointerup', pointerInit(x, y, 0, 0)))
  target.dispatchEvent(new MouseEvent('mouseup', pointerInit(x, y, 0, 0)))
  target.dispatchEvent(new MouseEvent('click', pointerInit(x, y, 0, 0)))
}

/** 在页面上这一点右键点一下（苹果平台上浏览器的顺序：按下时就送出 contextmenu） */
export function rightClickAt(target: Element, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent('pointerdown', pointerInit(x, y, 2, 2)))
  target.dispatchEvent(new MouseEvent('mousedown', pointerInit(x, y, 2, 2)))
  target.dispatchEvent(new MouseEvent('contextmenu', pointerInit(x, y, 2, 2)))
  target.dispatchEvent(new PointerEvent('pointerup', pointerInit(x, y, 2, 0)))
  target.dispatchEvent(new MouseEvent('mouseup', pointerInit(x, y, 2, 0)))
}

/** 元素的中心（视口坐标） */
export function centerOf(element: Element): { readonly x: number, readonly y: number } {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

// ---- 找元素 ----

/** 表格的主画布（SDK 给它的 id 是 univer-sheet-main-canvas_<unitId>，与 E2E 的 support/sheet.ts 相同） */
export function sheetCanvas(surface: HTMLElement): HTMLCanvasElement | null {
  return surface.querySelector<HTMLCanvasElement>('canvas[id^="univer-sheet-main-canvas_"]')
}

/** 看得见：在文档里、有布局的方框、没有被 visibility 藏起来（与 Playwright 的"可见"同样的看法） */
export function isVisible(element: Element): boolean {
  return element.isConnected && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
}

/**
 * 显示出来：看得见，而且它与上层都不是完全透明的。SDK 的弹出层关上之后留在页面上、透明度为 0（ui 的 AnchoredContextMenu），
 * isVisible（Playwright 的看法）认不出它已经关上
 */
export function isShown(element: Element): boolean {
  if (!isVisible(element))
    return false
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).opacity === '0')
      return false
  }
  return true
}

function normalized(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/** 可访问的名称（简化的算法：aria-labelledby、aria-label、文字、title，够这里用到的元素） */
export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const text = labelledBy.split(/\s+/).map(id => normalized(document.getElementById(id)?.textContent)).join(' ').trim()
    if (text !== '')
      return text
  }
  const label = normalized(element.getAttribute('aria-label'))
  if (label !== '')
    return label
  const text = normalized(element.textContent)
  return text !== '' ? text : normalized(element.getAttribute('title'))
}

/** 自检用到的几个角色：对应的元素（显式的 role 与有这个隐含角色的标签） */
const ROLE_SELECTORS = {
  button: 'button, [role="button"]',
  dialog: '[role="dialog"], [role="alertdialog"], dialog[open]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
  tab: '[role="tab"]',
  toolbar: '[role="toolbar"]',
} as const

/** 页面上（或 root 里）这个角色的元素；name 给出时按可访问的名称完全相同筛选 */
export function byRole(role: keyof typeof ROLE_SELECTORS, options: { readonly name?: string, readonly root?: ParentNode } = {}): HTMLElement[] {
  const found = [...(options.root ?? document).querySelectorAll<HTMLElement>(ROLE_SELECTORS[role])]
  return options.name === undefined ? found : found.filter(element => accessibleName(element) === options.name)
}

/** 页面上（或 root 里）文字恰好是 text 的元素（与 E2E 的 getByText(text, { exact: true }) 同样的看法：取最里层的那个） */
export function byExactText(text: string, root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('*')].filter(element => normalized(element.textContent) === text
    && ![...element.children].some(child => normalized(child.textContent) === text))
}

/** 标题恰好是 title 的对话框（对话框自己的名称，或者里面的标题） */
export function dialogTitled(title: string): HTMLElement | undefined {
  return byRole('dialog').find(dialog => accessibleName(dialog) === title || byRole('heading', { root: dialog }).some(heading => accessibleName(heading) === title))
}

/** 工作表标签栏里的一个标签（SDK 给标签栏的可访问名称是"工作表标签页"，与 E2E 的 support/sheet.ts 相同） */
export function sheetTab(name: string): HTMLElement | undefined {
  const tablist = document.querySelector('[role="tablist"][aria-label="工作表标签页"]')
  return tablist === null ? undefined : byRole('tab', { name, root: tablist })[0]
}

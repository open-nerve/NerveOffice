// Univer 自己的快捷键怎么按（P3 审查 B1）。
// Univer 按页面的 navigator.appVersion 判断是不是苹果平台（ui 的 PlatformService.isMac），苹果平台上主修饰键是 Meta，别的平台是
// Control；删除选中图片的键也按它（sheets-drawing-ui 的 drawing.shortcut.ts：苹果平台 Backspace，别的平台 Delete）。
// Playwright 的 ControlOrMeta 按运行测试的机器选，而 Playwright 的 WebKit 在 Linux 上的 UA 也是 Mac：在 Linux（CI）的 WebKit 里
// ControlOrMeta 按下的是 Control，Univer 却等 Meta，复制、查找、加粗等都没有反应。所以：
// - Univer 自己的快捷键（复制、剪切、加粗/斜体/下划线、撤销、重做、查找）用 pressUniverShortcut，按页面的判断取修饰键；
//   "搜索功能"与快速求和的组合另有 featureSearchKeys、quickSumKeys；SDK 注册的任意一个快捷键按探针给出的绑定用 shortcutKeys 换算
//   （只读的快捷键回归，M2-P6 复核 F1、F2 之后）；
// - 浏览器原生处理的组合键（粘贴 Ctrl/Cmd+V 的 paste 事件、改名时的全选）与平台自己的快捷键（保存，按 navigator.platform）
//   仍用 ControlOrMeta；
// - 替换的快捷键在两种平台上都是 Control+H（find-replace 的 find-replace.shortcut.ts：苹果平台绑定的是 MAC_CTRL），不用这里的辅助
import type { Page } from '@playwright/test'

/** Univer 是不是把这个页面当作苹果平台（与 ui 的 PlatformService.isMac 同一个判断） */
export async function univerIsMac(page: Page): Promise<boolean> {
  return page.evaluate(() => /Mac/.test(navigator.appVersion))
}

/** 按 Univer 的快捷键：keys 是主修饰键之外的部分（例如 'C'、'Shift+Z'），主修饰键按页面的判断取 Meta 或 Control */
export async function pressUniverShortcut(page: Page, keys: string): Promise<void> {
  await page.keyboard.press(`${(await univerIsMac(page)) ? 'Meta' : 'Control'}+${keys}`)
}

/** 删除选中图片的键：Univer 在苹果平台上绑定 Backspace，别的平台是 Delete */
export async function deleteDrawingKey(page: Page): Promise<'Backspace' | 'Delete'> {
  return (await univerIsMac(page)) ? 'Backspace' : 'Delete'
}

/** 快速求和的快捷键（sheets-formula-ui 的 quick-sum.shortcut.ts：Alt+=，苹果的平台上 Cmd+Option+=） */
export async function quickSumKeys(page: Page): Promise<string> {
  return (await univerIsMac(page)) ? 'Meta+Alt+Equal' : 'Alt+Equal'
}

/** "搜索功能"面板的快捷键（ui 的 feature-search.controller.ts：Ctrl/Cmd+Shift+P） */
export async function featureSearchKeys(page: Page): Promise<string> {
  return `${(await univerIsMac(page)) ? 'Meta' : 'Control'}+Shift+KeyP`
}

// ---- 按 SDK 注册的任意一个快捷键（只读的快捷键回归，M2-P6 复核 F1、F2 之后）----
// 绑定是 KeyCode 与修饰键的组合（ui 的 services/shortcut/keycode.ts）：低 8 位是浏览器的 keyCode，修饰键在它上面的几位。
// SDK 收到按键时同样按页面的平台把事件换算成绑定（shortcut.service.ts 的 _deriveBindingFromEvent）：苹果的平台上 Meta 是 CTRL_COMMAND、
// Control 是 MAC_CTRL；别的平台上 Control 是 CTRL_COMMAND，没有按键能得出 MAC_CTRL

/** ui 的 MetaKeys */
const META_KEYS = { SHIFT: 1 << 10, ALT: 1 << 11, CTRL_COMMAND: 1 << 12, MAC_CTRL: 1 << 13 } as const
/** 绑定里认得的位：keyCode 与上面四个修饰键；别的位（SDK 新加的修饰键）回归不知道怎么按 */
const KNOWN_BITS = 0xFF | META_KEYS.SHIFT | META_KEYS.ALT | META_KEYS.CTRL_COMMAND | META_KEYS.MAC_CTRL

/** 有名字的 keyCode → Playwright 的键名（美式键盘布局，Playwright 按它送出同样的 keyCode）；数字、字母与 F1–F12 按规律换算 */
const NAMED_KEYS: Readonly<Record<number, string>> = {
  8: 'Backspace',
  9: 'Tab',
  13: 'Enter',
  16: 'Shift',
  17: 'Control',
  27: 'Escape',
  32: 'Space',
  35: 'End',
  36: 'Home',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  45: 'Insert',
  46: 'Delete',
  144: 'NumLock',
  145: 'ScrollLock',
  187: 'Equal',
  188: 'Comma',
  189: 'Minus',
  190: 'Period',
  220: 'Backslash',
}

/** Univer 把这个页面当作哪个平台（与 ui 的 PlatformService 同样的判断） */
export interface UniverPlatform {
  readonly isMac: boolean
  readonly isWindows: boolean
  readonly isLinux: boolean
}

export async function univerPlatform(page: Page): Promise<UniverPlatform> {
  return page.evaluate(() => ({ isMac: /Mac/.test(navigator.appVersion), isWindows: /Windows/.test(navigator.appVersion), isLinux: /Linux/.test(navigator.appVersion) }))
}

/** 快捷键在各平台的绑定（探针给出的，与 SDK 的 IShortcutItem 同名的字段） */
export interface ShortcutBindings {
  readonly binding?: number | undefined
  readonly mac?: number | undefined
  readonly win?: number | undefined
  readonly linux?: number | undefined
}

/** 这个页面上生效的绑定：与 SDK 的 _getBindingFromItem 同样的规则（平台专用的绑定是真值时优先） */
export function effectiveBinding(item: ShortcutBindings, platform: UniverPlatform): number | undefined {
  if (platform.isMac && Boolean(item.mac))
    return item.mac
  if (platform.isWindows && Boolean(item.win))
    return item.win
  if (platform.isLinux && Boolean(item.linux))
    return item.linux
  return item.binding
}

/** 一次按键（keydown）里 SDK 换算绑定时用到的部分 */
export interface KeyEventFields {
  readonly keyCode: number
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

/**
 * SDK 把一次按键换算成的绑定：与 shortcut.service.ts 的 _deriveBindingFromEvent 同样的规则（苹果的平台上 Meta 是 CTRL_COMMAND、
 * Control 是 MAC_CTRL，别的平台上 Control 是 CTRL_COMMAND）。快捷键回归按它核对浏览器收到的按键就是要按的组合（M2-P6 复验 N1）
 */
export function bindingOf(event: KeyEventFields, platform: UniverPlatform): number {
  let binding = event.keyCode
  if (event.shiftKey)
    binding |= META_KEYS.SHIFT
  if (event.altKey)
    binding |= META_KEYS.ALT
  if (platform.isMac ? event.metaKey : event.ctrlKey)
    binding |= META_KEYS.CTRL_COMMAND
  if (platform.isMac && event.ctrlKey)
    binding |= META_KEYS.MAC_CTRL
  return binding
}

/** keyCode → Playwright 的键名；不认识的返回 undefined */
function keyNameOf(keyCode: number): string | undefined {
  if (keyCode >= 48 && keyCode <= 57)
    return `Digit${keyCode - 48}`
  if (keyCode >= 65 && keyCode <= 90)
    return `Key${String.fromCharCode(keyCode)}`
  if (keyCode >= 112 && keyCode <= 123)
    return `F${keyCode - 111}`
  return NAMED_KEYS[keyCode]
}

/**
 * 一个绑定在这个页面上怎么按：
 * - keys：Playwright 的 press 写法；
 * - unreachable：SDK 在这个平台上本来就派发不到它，不用按（只有一种：非苹果的平台上带 MAC_CTRL 的绑定）；
 * - unknown：回归不知道怎么按（keyCode 没有对应的键名，或者有不认得的修饰位）。快捷键回归按这种情况失败，要补上这里的键名表，
 *   不能悄悄地少按一个（M2-P6 复验 N1）
 */
export type ShortcutKeys = { readonly keys: string } | { readonly unreachable: string } | { readonly unknown: string }

export function shortcutKeys(binding: number, platform: UniverPlatform): ShortcutKeys {
  if ((binding & META_KEYS.MAC_CTRL) !== 0 && !platform.isMac)
    return { unreachable: 'MAC_CTRL：SDK 只在苹果的平台上由 Control 键得出它（shortcut.service.ts 的 _deriveBindingFromEvent），别的平台上没有按键能派发到这个绑定' }
  if ((binding & ~KNOWN_BITS) !== 0)
    return { unknown: `绑定 ${binding} 里有不认得的修饰位（${binding & ~KNOWN_BITS}）` }
  const keyCode = binding & 0xFF
  const key = keyNameOf(keyCode)
  if (key === undefined)
    return { unknown: `keyCode ${keyCode} 没有对应的键名` }
  const modifiers = [
    ...((binding & META_KEYS.CTRL_COMMAND) !== 0 ? [platform.isMac ? 'Meta' : 'Control'] : []),
    ...((binding & META_KEYS.MAC_CTRL) !== 0 ? ['Control'] : []),
    ...((binding & META_KEYS.SHIFT) !== 0 ? ['Shift'] : []),
    ...((binding & META_KEYS.ALT) !== 0 ? ['Alt'] : []),
  ]
  return { keys: [...modifiers, key].join('+') }
}

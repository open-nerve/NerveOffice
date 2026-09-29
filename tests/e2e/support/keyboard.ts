// Univer 自己的快捷键怎么按（P3 审查 B1）。
// Univer 按页面的 navigator.appVersion 判断是不是苹果平台（ui 的 PlatformService.isMac），苹果平台上主修饰键是 Meta，别的平台是
// Control；删除选中图片的键也按它（sheets-drawing-ui 的 drawing.shortcut.ts：苹果平台 Backspace，别的平台 Delete）。
// Playwright 的 ControlOrMeta 按运行测试的机器选，而 Playwright 的 WebKit 在 Linux 上的 UA 也是 Mac：在 Linux（CI）的 WebKit 里
// ControlOrMeta 按下的是 Control，Univer 却等 Meta，复制、查找、加粗等都没有反应。所以：
// - Univer 自己的快捷键（复制、剪切、加粗/斜体/下划线、撤销、重做、查找）用 pressUniverShortcut，按页面的判断取修饰键；
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

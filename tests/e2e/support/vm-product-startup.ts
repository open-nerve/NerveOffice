import type { VmBrowser } from './vm-guest.ts'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { guestQuote } from './vm-guest.ts'

interface PreparationPorts {
  readonly browser: VmBrowser
  readonly kind: 'qemu' | 'tart'
  readonly run: (command: string, timeout: number) => Promise<string>
  readonly now?: () => number
  readonly wait?: () => Promise<void>
}

const closedWindows = z.strictObject({ closedWindows: z.number().int().positive(), remainingWindows: z.literal(0) })

/** 仅在本任务独占客体、产品来源尚未转发时运行；不读写浏览器存储。 */
export function safariWindowCleanupScript(): string {
  return `(() => {
    const app = Application('Safari');
    const openingDeadline = Date.now() + 15000;
    while (app.windows().length === 0 && Date.now() < openingDeadline) delay(0.2);
    const windows = app.windows();
    if (windows.length === 0) throw new Error('Safari 没有实际打开测试窗口');
    const initialWindowIds = windows.map(window => window.id());
    windows.forEach(window => window.close());
    const closingDeadline = Date.now() + 15000;
    while (app.windows().length !== 0 && Date.now() < closingDeadline) delay(0.2);
    const remainingWindows = app.windows().length;
    if (remainingWindows !== 0) throw new Error('Safari 旧测试窗口未在期限内关闭: ' + JSON.stringify({initialWindowIds, remainingWindowIds: app.windows().map(window => window.id())}));
    return JSON.stringify({closedWindows: windows.length, remainingWindows});
  })()`
}

export async function prepareVmProductBrowser(ports: PreparationPorts) {
  if (ports.browser !== 'safari')
    return { kind: 'not-needed' } as const
  assert(ports.kind === 'tart', 'Safari 窗口准备只接受 macOS 客体')
  const now = ports.now ?? Date.now
  const wait = ports.wait ?? (async () => {
    await delay(500)
  })
  const deadline = now() + 60_000
  for (;;) {
    assert(now() < deadline, '客体桌面未在期限内就绪')
    try {
      await ports.run('test "$(/usr/bin/stat -f %Su /dev/console)" = admin && /bin/launchctl print gui/501 >/dev/null && /usr/bin/pgrep -u 501 -x Finder >/dev/null', 5000)
      break
    }
    catch {
      await wait()
    }
  }
  assert(now() < deadline, '客体桌面未在期限内就绪')
  const desktopReadyAt = now()
  await ports.run('/usr/bin/open -a Safari about:blank', 10_000)
  const result = closedWindows.parse(JSON.parse(await ports.run(`/usr/bin/osascript -l JavaScript -e ${guestQuote(safariWindowCleanupScript())}`, 35_000)))
  return { kind: 'safari-windows-closed', ...result, desktopReadyAt, closedAt: now() } as const
}

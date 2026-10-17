import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { prepareVmProductBrowser, safariWindowCleanupScript } from './vm-product-startup.ts'

describe('产品 VM 的 Safari 窗口准备', () => {
  function windows(options: { closeDelay?: number, neverCloses?: boolean, initiallyAbsent?: boolean } = {}) {
    let now = 0
    let closeAt: number | undefined
    let signals = 0
    const window = { id: () => 17, close: () => {
      signals++
      closeAt = now
    } }
    const context = {
      Application: () => ({ windows: () => {
        if (options.initiallyAbsent)
          return []
        if (closeAt === undefined || options.neverCloses || now - closeAt < (options.closeDelay ?? 5400))
          return [window]
        return []
      } }),
      Date: { now: () => now },
      delay: (seconds: number) => { now += seconds * 1000 },
    }
    return { context, elapsed: () => now, signals: () => signals }
  }

  it('执行实际客体脚本，等待异步关闭完成后才返回零窗口', () => {
    const fixture = windows()
    const result: unknown = JSON.parse(runInNewContext(safariWindowCleanupScript(), fixture.context) as string)
    expect(result).toEqual({ closedWindows: 1, remainingWindows: 0 })
    expect(fixture.elapsed()).toBeGreaterThanOrEqual(5400)
    expect(fixture.signals()).toBe(1)
  })

  it('窗口一直存在时有界失败，不返回可供产品来源放行的回执', () => {
    const fixture = windows({ neverCloses: true })
    expect(() => {
      runInNewContext(safariWindowCleanupScript(), fixture.context)
    }).toThrow('关闭')
    expect(fixture.elapsed()).toBe(15_000)
    expect(fixture.signals()).toBe(1)
  })

  it('Safari 没有实际打开窗口时不能把空列表当清理成功', () => {
    const fixture = windows({ initiallyAbsent: true })
    expect(() => {
      runInNewContext(safariWindowCleanupScript(), fixture.context)
    }).toThrow('窗口')
    expect(fixture.signals()).toBe(0)
    expect(fixture.elapsed()).toBe(15_000)
  })

  function ports(reply = '{"closedWindows":1,"remainingWindows":0}', desktopFailures = 0) {
    let now = 1000
    let calls = 0
    const commands: string[] = []
    return {
      commands,
      value: {
        browser: 'safari' as const,
        kind: 'tart' as const,
        now: () => now,
        wait: async () => { now += 500 },
        run: async (command: string) => {
          commands.push(command)
          if (++calls <= desktopFailures)
            throw new Error('桌面尚未就绪')
          return command.includes('osascript') ? reply : ''
        },
      },
    }
  }

  it('等待客体桌面后取得严格回执，准备期间不会建立转发或打开产品来源', async () => {
    const fixture = ports(undefined, 2)
    expect(await prepareVmProductBrowser(fixture.value)).toEqual({ kind: 'safari-windows-closed', closedWindows: 1, remainingWindows: 0, desktopReadyAt: 2000, closedAt: 2000 })
    expect(fixture.commands.some(command => command.includes('127.0.0.1'))).toBe(false)
    expect(fixture.commands.filter(command => command.startsWith('/usr/bin/open'))).toEqual(['/usr/bin/open -a Safari about:blank'])
  })

  it.each([
    '{"closedWindows":1,"remainingWindows":1}',
    '{"closedWindows":0,"remainingWindows":0}',
    '{"closedWindows":1,"remainingWindows":0,"unexpected":true}',
    '{"closedWindows":"1","remainingWindows":0}',
    'not-json',
  ])('拒绝不合格关闭回执：%s', async (reply) => {
    await expect(prepareVmProductBrowser(ports(reply).value)).rejects.toThrow()
  })

  it('客体桌面一直不可用时有界失败，不能操作 Safari', async () => {
    const fixture = ports(undefined, Number.POSITIVE_INFINITY)
    await expect(prepareVmProductBrowser(fixture.value)).rejects.toThrow('桌面')
    expect(fixture.commands.some(command => command.includes('Safari'))).toBe(false)
  })

  it('Linux 浏览器不运行 macOS 窗口操作', async () => {
    const fixture = ports()
    expect(await prepareVmProductBrowser({ ...fixture.value, kind: 'qemu', browser: 'chrome' })).toEqual({ kind: 'not-needed' })
    expect(fixture.commands).toEqual([])
  })

  it('拒绝把 Safari 窗口操作发给 Linux 客体', async () => {
    const fixture = ports()
    await expect(prepareVmProductBrowser({ ...fixture.value, kind: 'qemu' })).rejects.toThrow('macOS')
    expect(fixture.commands).toEqual([])
  })
})

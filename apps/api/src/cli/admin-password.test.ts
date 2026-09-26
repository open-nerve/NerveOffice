import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../app/index.ts'
import { readAdminPassword } from './admin-password.ts'
import { UsageError } from './init-admin-arguments.ts'

/** 假的标准输入：isTTY 可选；终端模式下由测试逐段送入按键，管道模式下读出给定的内容。 */
function fakeStdin(isTTY: boolean, piped = '') {
  const stream = Readable.from([piped])
  return Object.assign(stream, {
    isTTY,
    setRawMode: vi.fn(),
    setEncoding: vi.fn(() => stream),
    resume: vi.fn(() => stream),
    pause: vi.fn(() => stream),
  })
}

function fakeTerminal() {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: vi.fn(),
    setEncoding: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
    async* [Symbol.asyncIterator](): AsyncGenerator<string> {},
  })
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

const stderr = { write: vi.fn() }

describe('readAdminPassword', () => {
  it('--password-stdin 且标准输入是管道：读出密码', async () => {
    expect(await readAdminPassword(true, { stdin: fakeStdin(false, 'correct horse battery staple\n'), stderr })).toBe('correct horse battery staple')
  })

  it('--password-stdin 但标准输入是终端：用法错误（在终端里敲的密码会显示在屏幕上）', async () => {
    await expect(readAdminPassword(true, { stdin: fakeStdin(true), stderr })).rejects.toThrow(UsageError)
    await expect(readAdminPassword(true, { stdin: fakeStdin(true), stderr })).rejects.toThrow(/在终端里请去掉它/)
  })

  it('没有 --password-stdin 又不是终端：用法错误', async () => {
    await expect(readAdminPassword(false, { stdin: fakeStdin(false), stderr })).rejects.toThrow(/请用 --password-stdin/)
  })

  it('终端里输入两次：一致时返回，不一致时报错', async () => {
    for (const [first, second, expected] of [['same secret\r', 'same secret\r', 'same secret'], ['one secret\r', 'another\r', undefined]] as const) {
      const stdin = fakeTerminal()
      const reading = readAdminPassword(false, { stdin, stderr })
      await flush()
      stdin.emit('data', first)
      await flush()
      stdin.emit('data', second)
      if (expected === undefined) {
        await expect(reading).rejects.toBeInstanceOf(AppError)
        await expect(reading).rejects.toThrow('两次输入的密码不一致')
      }
      else {
        expect(await reading).toBe(expected)
      }
    }
  })
})

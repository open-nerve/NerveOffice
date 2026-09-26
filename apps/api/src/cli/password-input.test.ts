import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { InputCancelled, promptHidden, readPasswordFromStream } from './password-input.ts'

/** 假的终端：记下原始模式的切换，由测试逐段送入按键。 */
function fakeTerminal() {
  const input = Object.assign(new EventEmitter(), {
    setRawMode: vi.fn(),
    setEncoding: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  })
  const written: string[] = []
  return { input, output: { write: (text: string) => written.push(text) }, written }
}

describe('readPasswordFromStream', () => {
  it('读取全部内容，只去掉末尾的一个换行', async () => {
    expect(await readPasswordFromStream(Readable.from(['correct horse ', 'battery staple\n']))).toBe('correct horse battery staple')
    expect(await readPasswordFromStream(Readable.from(['密码 带空格 \r\n']))).toBe('密码 带空格 ')
    expect(await readPasswordFromStream(Readable.from(['two\n\n']))).toBe('two\n')
  })
})

describe('promptHidden', () => {
  it('逐个字符读取直到回车，不回显；支持退格与一次粘贴多个字符；结束后恢复终端', async () => {
    const { input, output, written } = fakeTerminal()
    const reading = promptHidden(input, output, '密码：')
    input.emit('data', 'secr')
    input.emit('data', 'x\u007F')
    input.emit('data', 'et密码\r')
    expect(await reading).toBe('secret密码')
    expect(written.join('')).toBe('密码：\n')
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(input.pause).toHaveBeenCalled()
    expect(input.listenerCount('data')).toBe(0)
  })

  it('Ctrl+C，或者还没输入时按 Ctrl+D：取消', async () => {
    for (const key of ['abc\u0003', '\u0004']) {
      const { input, output } = fakeTerminal()
      const reading = promptHidden(input, output, '密码：')
      input.emit('data', key)
      await expect(reading).rejects.toBeInstanceOf(InputCancelled)
      expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    }
  })
})

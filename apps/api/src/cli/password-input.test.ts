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
  it('读取全部内容，只去掉末尾的一个换行（echo 与 printf 的输出都能用）', async () => {
    expect(await readPasswordFromStream(Readable.from(['correct horse ', 'battery staple\n']))).toBe('correct horse battery staple')
    expect(await readPasswordFromStream(Readable.from(['密码 带空格 \r\n']))).toBe('密码 带空格 ')
    expect(await readPasswordFromStream(Readable.from(['printf 的输出没有换行']))).toBe('printf 的输出没有换行')
  })

  it('多出的换行不去掉，原样交给密码规则：规则拒绝控制字符，初始化失败，而不是设下一个登录不上的密码', async () => {
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

  it('方向键、功能键、Alt 组合键与其他控制键都忽略，不混进密码；拆在两段里的按键序列也能识别', async () => {
    const { input, output } = fakeTerminal()
    const reading = promptHidden(input, output, '密码：')
    // 上、左（CSI）；F1（SS3）；Delete（带参数的 CSI）；Alt+b；Ctrl+U、Tab；已经输入过字符时的 Ctrl+D
    input.emit('data', 'ab\u001B[A\u001B[D')
    input.emit('data', 'c\u001BOP\u001B[3~')
    input.emit('data', '\u001Bbd\u0015\t\u0004e\u001B')
    input.emit('data', '[1;5Cf\r')
    expect(await reading).toBe('abcdef')
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

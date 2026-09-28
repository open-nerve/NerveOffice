import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../app/index.ts'
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

  describe('按 UTF-8 流式解码：一个字符的几个字节分在几块里也能还原（Codex 评审 CX3）', () => {
    const PASSWORD = '密码安全正确非常重要😀1234\n'
    const bytes = Buffer.from(PASSWORD, 'utf8')

    it('在每个字节位置切成两块', async () => {
      for (let cut = 1; cut < bytes.length; cut++)
        expect(await readPasswordFromStream(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]))).toBe(PASSWORD.slice(0, -1))
    })

    it('在每两个字节位置切成三块（包括把一个 emoji 的四个字节分进三块）', async () => {
      for (let first = 1; first < bytes.length - 1; first++) {
        for (let second = first + 1; second < bytes.length; second++) {
          const chunks = [bytes.subarray(0, first), bytes.subarray(first, second), bytes.subarray(second)]
          expect(await readPasswordFromStream(Readable.from(chunks))).toBe(PASSWORD.slice(0, -1))
        }
      }
    })

    it('逐字节送入', async () => {
      expect(await readPasswordFromStream(Readable.from([...bytes].map(byte => Buffer.from([byte]))))).toBe(PASSWORD.slice(0, -1))
    })

    it('开头的 BOM 去掉（它不是密码的一部分）', async () => {
      expect(await readPasswordFromStream(Readable.from([Buffer.from([0xEF, 0xBB]), Buffer.from([0xBF]), bytes]))).toBe(PASSWORD.slice(0, -1))
    })

    it.each([
      ['不可能出现的字节', [Buffer.from([0x61, 0xFF, 0x62])]],
      ['单独的后续字节', [Buffer.from([0x80]), Buffer.from('abcdefghijkl')]],
      ['过长的编码', [Buffer.from([0xC0, 0xAF])]],
      ['编码了代理项', [Buffer.from([0xED, 0xA0, 0x80])]],
      ['结尾只有半个字符', [Buffer.from('密码安全正确'), bytes.subarray(0, 2)]],
      ['半个字符之后是已经解码的字符串块', [bytes.subarray(0, 2), 'rest of the password']],
    ])('不合法的 UTF-8（%s）：报错，不替换成 U+FFFD', async (_case, chunks: (Buffer | string)[]) => {
      const reading = readPasswordFromStream(Readable.from(chunks))
      await expect(reading).rejects.toBeInstanceOf(AppError)
      await expect(reading).rejects.toMatchObject({ code: 'REQUEST_INVALID', message: expect.stringContaining('不是合法的 UTF-8') as unknown })
    })
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

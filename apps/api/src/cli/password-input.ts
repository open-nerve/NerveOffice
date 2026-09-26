// 命令行读取密码（P3 设计 §3.4）：密码不出现在命令行参数与日志里。
import type { Buffer } from 'node:buffer'
import type { EventEmitter } from 'node:events'

/** 用户在终端里按了 Ctrl+C 或 Ctrl+D，放弃输入。 */
export class InputCancelled extends Error {
  override readonly name = 'InputCancelled'
}

/** 从标准输入读取全部内容，去掉末尾的一个换行（`echo` 与 `printf` 的输出都能用）。 */
export async function readPasswordFromStream(input: AsyncIterable<string | Buffer>): Promise<string> {
  let content = ''
  for await (const chunk of input)
    content += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  return content.replace(/\r?\n$/, '')
}

/** 终端的输入流里用到的部分：原始模式逐个字符读取，不回显。 */
export interface TerminalInput extends EventEmitter {
  setRawMode: (mode: boolean) => unknown
  setEncoding: (encoding: BufferEncoding) => unknown
  resume: () => unknown
  pause: () => unknown
}

const ENTER = new Set(['\r', '\n'])
const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const ESCAPE = '\u001B'
const BACKSPACE = new Set(['\u007F', '\b'])
// eslint-disable-next-line no-control-regex -- 要识别的正是控制字符
const CONTROL_CHARACTER = /^[\u0000-\u001F\u007F-\u009F]$/u

/**
 * 按键序列的状态：方向键、功能键等在终端里是以 ESC 开头的一串字符，整串忽略，不能混进密码
 * （密码规则不接受控制字符，混进来的只会让这次输入作废）。
 * - `ESC [` 开头（CSI）：参数与中间字符之后，以 0x40–0x7E 之间的一个字符结束；
 * - `ESC O` 开头（SS3）：再跟一个字符；
 * - 其他 `ESC x`（例如 Alt 加一个键）：连同 x 一起忽略。
 */
type KeyState = 'text' | 'escape' | 'csi' | 'ss3'

/** 在终端里提示并读取一行，输入的字符不显示。提示写到 output（标准错误），不混进标准输出的日志。 */
export async function promptHidden(input: TerminalInput, output: { write: (text: string) => unknown }, question: string): Promise<string> {
  output.write(question)
  input.setRawMode(true)
  input.setEncoding('utf8')
  input.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    let state: KeyState = 'text'
    function onData(chunk: string): void {
      // 粘贴时一次会来好几个字符；按码点逐个处理
      for (const character of chunk) {
        if (state !== 'text') {
          state = nextEscapeState(state, character)
          continue
        }
        if (ENTER.has(character))
          return finish(() => resolve(value))
        if (character === CTRL_C || (character === CTRL_D && value === ''))
          return finish(() => reject(new InputCancelled('已取消')))
        if (BACKSPACE.has(character))
          value = [...value].slice(0, -1).join('')
        else if (character === ESCAPE)
          state = 'escape'
        else if (!CONTROL_CHARACTER.test(character))
          value += character
      }
    }
    function finish(settle: () => void): void {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
      settle()
    }
    input.on('data', onData)
  })
}

function nextEscapeState(state: Exclude<KeyState, 'text'>, character: string): KeyState {
  if (state === 'escape')
    return character === '[' ? 'csi' : character === 'O' ? 'ss3' : 'text'
  if (state === 'csi') {
    const code = character.codePointAt(0) ?? 0
    return code >= 0x40 && code <= 0x7E ? 'text' : 'csi'
  }
  return 'text'
}

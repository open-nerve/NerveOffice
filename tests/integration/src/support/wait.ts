// 等某个条件成立（轮询），超时就失败；用来等异步写出的日志等，不用固定时长的等待。
import { setTimeout as delay } from 'node:timers/promises'

export async function waitFor(condition: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > deadline)
      throw new Error(`${timeoutMs} ms 内没有等到：${description}`)
    await delay(20)
  }
}

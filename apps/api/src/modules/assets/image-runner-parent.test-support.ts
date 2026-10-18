// 真正父进程被终止的测试；这个父进程允许 TS，受限图片子进程始终使用 JS。
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { ImageRunner } from './image-runner.ts'

async function main(): Promise<void> {
  const trace = process.argv[2]
  if (trace === undefined)
    throw new Error('需要测试目录')
  const runner = new ImageRunner({ entry: { script: new URL('./image-runner-child.test-support.mjs', import.meta.url), args: [trace] } })
  await runner.initialize()
  await runner.process({ data: Buffer.from('{"kind":"hang"}'), mimeType: 'image/png', extension: 'png' }, new AbortController().signal)
  await runner.close()
}

void main().catch(() => process.exit(1))

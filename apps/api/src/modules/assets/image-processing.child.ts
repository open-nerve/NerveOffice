import process from 'node:process'
import { imageChildAddressSpaceBytes } from './image-child-runtime.ts'
import { ImageCodecError, processImage } from './image-codec.ts'
import { isMessage, validateImageInput } from './image-process-protocol.ts'

function send(message: object, exit = false): void {
  try {
    process.send?.(message, (error) => {
      if (error !== null || exit)
        process.exit(error === null ? 0 : 1)
    })
  }
  catch {
    process.exit(1)
  }
}

function start(): void {
  let consumed = false
  process.on('message', (message: unknown) => {
    if (consumed || !isMessage(message, ['type', 'input']) || message.type !== 'process') {
      send({ type: 'failed', stage: 'protocol' }, true)
      return
    }
    consumed = true
    const handle = async (): Promise<void> => {
      let input
      try {
        input = validateImageInput(message.input)
      }
      catch {
        send({ type: 'failed', stage: 'protocol' }, true)
        return
      }
      try {
        const result = await processImage(input)
        send('rule' in result ? { type: 'invalid', rule: result.rule } : { type: 'processed', image: result }, true)
      }
      catch (error) {
        send({ type: 'failed', stage: error instanceof ImageCodecError ? error.stage : 'protocol' }, true)
      }
    }
    void handle()
  })
  send({ type: 'ready', protocol: 1, addressSpaceBytes: imageChildAddressSpaceBytes })
}

start()

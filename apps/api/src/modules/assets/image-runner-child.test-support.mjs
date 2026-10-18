// 真正独立的受控故障进程；jitless 下执行 JS，不依赖 Node 的 TS/Wasm 剥离器。
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const [trace, mode = 'normal'] = process.argv.slice(2)
writeFileSync(join(trace, `started-${process.pid}`), '')
process.on('disconnect', () => process.exit(0))
process.on('message', (message) => {
  const task = JSON.parse(Buffer.from(message.input.data).toString())
  writeFileSync(join(trace, `task-${process.pid}.json`), JSON.stringify({ pid: process.pid, environment: process.env, execArgv: process.execArgv }))
  switch (task.kind) {
    case 'hang': return
    case 'disconnect':
      process.disconnect()
      return
    case 'exit':
      process.exit(7)
      break
    case 'heap': {
      const arrays = []
      for (;;) arrays.push(Array.from({ length: 100000 }, () => Math.random()))
    }
    case 'native-allocation': {
      let code = null
      try {
        Buffer.allocUnsafe(2 * 1024 * 1024 * 1024)
      }
      catch (error) {
        code = error.code
      }
      writeFileSync(join(trace, `allocation-${process.pid}.json`), JSON.stringify({ code }))
      process.send(code === 'ERR_MEMORY_ALLOCATION_FAILED' ? { type: 'invalid', rule: 'too-complex' } : { type: 'failed', stage: 'verify' })
      return
    }
    case 'bad': process.send({ type: 'processed', image: { data: Buffer.from('private bytes'), path: '/private/photo' } })
      return
    case 'double': process.send({ type: 'ready', protocol: 1, addressSpaceBytes: null })
      return
    case 'invalid': process.send({ type: 'invalid', rule: 'pixels' })
      return
    case 'bad-rule': process.send({ type: 'invalid', rule: 'private-rule' })
      return
    case 'failed': process.send({ type: 'failed', stage: 'encode', secret: 'must not escape' })
      return
    case 'generic-memory-text': process.stderr.write('Allocation failed - JavaScript heap out of memory')
      process.exit(1)
      break
  }
  const data = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex')
  const image = { data, sha256: createHash('sha256').update(data).digest('hex'), mimeType: 'image/png', width: 1, height: 1, frames: 1, bytes: data.length }
  setTimeout(() => process.send({ type: 'processed', image }), task.delay ?? 0)
})

if (mode !== 'never-ready') {
  let addressSpaceBytes = null
  if (process.platform === 'linux') {
    const row = readFileSync('/proc/self/limits', 'utf8').match(/Max address space\s+(\d+)\s+(\d+)/)
    addressSpaceBytes = row && row[1] === row[2] ? Number(row[1]) : 0
  }
  const ready = () => process.send({ type: 'ready', protocol: 1, addressSpaceBytes })
  if (mode === 'gated-ready') {
    const timer = setInterval(() => {
      if (existsSync(join(trace, 'release-ready'))) {
        clearInterval(timer)
        ready()
      }
    }, 5)
  }
  else {
    ready()
  }
}

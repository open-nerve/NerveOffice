import { readFileSync } from 'node:fs'
import process from 'node:process'
import { preferOomKill } from '../../shared/process-task.ts'
import { IMAGE_LIMITS } from './image-types.ts'

/** 入口先静态导入此模块再导入 codec；先建立断开处理、核对硬限制，再加载原生库。 */
function prepare(): number | null {
  if (process.send === undefined)
    throw new Error('图片处理需要独立 IPC 进程')
  process.on('disconnect', () => process.exit(0))
  preferOomKill()
  if (process.platform !== 'linux')
    return null
  const row = readFileSync('/proc/self/limits', 'utf8').match(/Max address space\s+(\d+)\s+(\d+)/)
  if (row?.[1] !== String(IMAGE_LIMITS.addressSpaceBytes) || row[2] !== row[1])
    throw new Error('图片进程硬限制未生效')
  return IMAGE_LIMITS.addressSpaceBytes
}

export const imageChildAddressSpaceBytes = prepare()

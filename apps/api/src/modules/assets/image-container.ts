import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { ImageContainer } from './container-reader.ts'
import { requireImage } from './container-reader.ts'
import { inspectGif } from './gif-container.ts'
import { inspectJpeg } from './jpeg-container.ts'
import { inspectPng } from './png-container.ts'
import { inspectWebp } from './webp-container.ts'

/** 先匹配三个独立声明，再允许对应 Buffer loader 接触不可信字节。 */
export function inspectContainer(data: Buffer, mimeType: AssetMimeType, extension: AssetExtension): ImageContainer {
  requireImage(data.length > 0)
  let actual: AssetMimeType | undefined
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
    actual = 'image/png'
  else if (data[0] === 0xFF && data[1] === 0xD8)
    actual = 'image/jpeg'
  else if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP')
    actual = 'image/webp'
  else if (['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6)))
    actual = 'image/gif'
  const expectedExtension = actual === 'image/jpeg' ? ['jpg', 'jpeg'] : [actual?.slice(6)]
  requireImage(actual !== undefined && actual === mimeType && expectedExtension.includes(extension), 'type')
  switch (actual) {
    case 'image/png': return inspectPng(data)
    case 'image/jpeg': return inspectJpeg(data)
    case 'image/gif': return inspectGif(data)
    case 'image/webp': return inspectWebp(data)
  }
}

import type { ImageProcessingInput } from './image-types.ts'
import { ASSET_EXTENSIONS, ASSET_MIME_TYPES } from '@nerve-office/contracts'
import { z } from 'zod'
import { IMAGE_LIMITS } from './image-types.ts'

const inputSchema = z.strictObject({
  data: z.instanceof(Uint8Array).refine(data => data.byteLength <= IMAGE_LIMITS.maxBytes),
  mimeType: z.enum(ASSET_MIME_TYPES),
  extension: z.enum(ASSET_EXTENSIONS),
})

export function validateImageInput(value: unknown): ImageProcessingInput {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success)
    throw new Error('图片输入不符合内部协议')
  return parsed.data
}

export function isMessage(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

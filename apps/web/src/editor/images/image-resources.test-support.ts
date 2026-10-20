import type { AssetBytes } from '../../shared/assets/asset-api.ts'
import type { DecodedImage } from './decode-image.ts'
import type { ImageResources, ImageResourcesOptions } from './image-resources.ts'
import { vi } from 'vitest'
import { createImageResources } from './image-resources.ts'

export const SOURCE = '/api/assets/11111111-1111-4111-8111-111111111111'
export const OTHER = '/api/assets/22222222-2222-4222-8222-222222222222'
export const PLACEHOLDER = 'https://app.test/assets/image-unavailable.svg'
export const BYTES: AssetBytes = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }

export function decoded(url = 'blob:https://app.test/first'): DecodedImage {
  const image = document.createElement('img')
  image.src = url
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 120 }, naturalHeight: { value: 80 } })
  return { url, image, dispose: vi.fn(() => image.removeAttribute('src')) }
}

export function resourcesHarness(override: Partial<ImageResourcesOptions> = {}): {
  readonly resources: ImageResources
  readonly options: ImageResourcesOptions
  readonly read: ReturnType<typeof vi.fn<ImageResourcesOptions['read']>>
  readonly decode: ReturnType<typeof vi.fn<ImageResourcesOptions['decode']>>
  readonly changed: ReturnType<typeof vi.fn>
  readonly failed: ReturnType<typeof vi.fn>
} {
  const read = vi.fn<ImageResourcesOptions['read']>(async () => BYTES)
  const decode = vi.fn<ImageResourcesOptions['decode']>(async () => decoded())
  const changed = vi.fn()
  const failed = vi.fn()
  const options = { origin: 'https://app.test', placeholder: PLACEHOLDER, read, decode, changed, failed, ...override }
  return { resources: createImageResources(options), options, read, decode, changed, failed }
}

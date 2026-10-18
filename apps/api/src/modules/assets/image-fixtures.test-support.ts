import type { AssetExtension, AssetMimeType } from '@nerve-office/contracts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

interface Fixture {
  id: string
  file: string
  sha256: string
  bytes: number
  declaredType: AssetMimeType
  extension: AssetExtension
  large: boolean
  generated?: { source: string, bytes: number }
  expected: {
    status: 'accept' | 'reject'
    reason?: string
    rule?: string
    width?: number
    height?: number
    frames?: number
    delay?: number[]
    loop?: number | null
    rgbaSha256?: string[]
    points?: { x: number, y: number, rgba: number[] }[][]
  }
}

const manifest = JSON.parse(readFileSync(new URL('./testdata/manifest.json', import.meta.url), 'utf8')) as { cases: Fixture[] }
export const imageFixtures: readonly Fixture[] = manifest.cases

export function fixtureInput(fixture: Fixture) {
  const data = fixture.generated
    ? Buffer.alloc(fixture.generated.bytes)
    : readFileSync(new URL(`./testdata/${fixture.file}`, import.meta.url))
  if (fixture.generated)
    readFileSync(new URL(`./testdata/${fixture.generated.source}`, import.meta.url)).copy(data)
  if (data.length !== fixture.bytes || createHash('sha256').update(data).digest('hex') !== fixture.sha256)
    throw new Error(`测试样本摘要不符：${fixture.id}`)
  return { data, mimeType: fixture.declaredType, extension: fixture.extension }
}

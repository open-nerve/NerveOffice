// P4-S6 手动容量测量的合成样本；复用 M0/M4 的三份生成器，不进入生产构建。
// node --conditions=@nerve-office/source tests/e2e/measure/history-samples.ts --output <新目录>
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import { SNAPSHOT_MAX_RAW_BYTES } from '@nerve-office/contracts'
import { bulkSampleFor, perfSampleFor } from '../support/capture-samples.ts'

interface Workbook {
  id: string
  sheetOrder: string[]
  resources: { name: string, data: string }[]
  [key: string]: unknown
}

const UNIT = 'e515f159-221e-4519-9bbb-0c2b816b5100'
const ASSETS = Array.from({ length: 10 }, (_, i) => `e515f159-221e-4519-9bbb-0c2b816b52${String(i).padStart(2, '0')}`)

function withImages(raw: string): string {
  const workbook = JSON.parse(raw) as Workbook
  const sheet = workbook.sheetOrder[0]
  if (sheet === undefined)
    throw new Error('容量样本没有工作表')
  const data = Object.fromEntries(ASSETS.map((asset, i) => {
    const drawingId = `capacity-image-${i}`
    const from = { row: i * 4, column: 0, rowOffset: 0, columnOffset: 0 }
    const to = { row: i * 4 + 3, column: 2, rowOffset: 0, columnOffset: 0 }
    return [drawingId, {
      unitId: UNIT,
      subUnitId: sheet,
      drawingId,
      drawingType: 0,
      imageSourceType: 'URL',
      source: `/api/assets/${asset}`,
      anchorType: '0',
      transform: { left: 46, top: i * 80 + 20, width: 120, height: 60 },
      sheetTransform: { from, to },
      axisAlignSheetTransform: { from, to },
    }]
  }))
  workbook.resources = [
    ...workbook.resources.filter(resource => resource.name !== 'SHEET_DRAWING_PLUGIN'),
    { name: 'SHEET_DRAWING_PLUGIN', data: JSON.stringify({ [sheet]: { data, order: Object.keys(data) } }) },
  ]
  return JSON.stringify(workbook)
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { output: { type: 'string' } } })
  if (values.output === undefined || !path.isAbsolute(values.output))
    throw new Error('--output 必须是新的绝对路径')
  await mkdir(values.output)
  const sources = [
    { name: 'big-1m', make: bulkSampleFor(1024 * 1024) },
    { name: 'perf-50k', make: perfSampleFor },
    { name: 'big-5m', make: bulkSampleFor(5 * 1024 * 1024) },
  ]
  const samples = []
  for (const source of sources) {
    const plain = source.make(UNIT)
    for (const images of [false, true]) {
      const raw = Buffer.from(images ? withImages(plain) : plain)
      if (raw.length > SNAPSHOT_MAX_RAW_BYTES)
        throw new Error('容量样本超过正式快照上限')
      const name = `${source.name}-${images ? 'images' : 'plain'}`
      await writeFile(path.join(values.output, `${name}.json`), raw, { flag: 'wx' })
      samples.push({ name, source: source.name, rawBytes: raw.length, gzipBytes: gzipSync(raw).length, sha256: createHash('sha256').update(raw).digest('hex'), assetPlaceholders: images ? ASSETS : [] })
    }
  }
  const manifest = { unitId: UNIT, samples }
  await writeFile(path.join(values.output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})

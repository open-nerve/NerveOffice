import type { PassedSnapshot, SnapshotInspection } from './snapshot-inspection.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { canonicalContentText, contentHashInput, HYPERLINK_RANGE_TYPE, profileResourceNames, sheetSnapshotFor, SNAPSHOT_MAX_DEPTH } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { SNAPSHOT_MAX_ENTRIES } from './snapshot-checks.ts'
import { inspectSnapshot } from './snapshot-inspection.ts'

const UNIT_ID = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
const ASSET = '/api/assets/0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'
/** 仓库的根：读 M0 的样本与 E2E 的只读样本（不误拒的核实） */
const REPOSITORY = new URL('../../../../../', import.meta.url)

type Workbook = Record<string, unknown> & { sheets: Record<string, Record<string, unknown>>, resources: { name: string, data: string }[] }

function template(): Workbook {
  return JSON.parse(sheetSnapshotFor(UNIT_ID)) as Workbook
}

function bytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value))
    return value
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

/** 结果的简写：通过时是 ok，不通过时是规则 */
function outcome(value: unknown): string {
  const result = inspectSnapshot(bytes(value), 'sheet@1')
  return result.ok ? 'ok' : result.rule
}

function passed(result: SnapshotInspection): PassedSnapshot {
  if (!result.ok)
    throw new Error(`期望通过，得到 ${result.rule}`)
  return result
}

function sha256(text: string): string {
  return createHash('sha256').update(contentHashInput(canonicalContentText(text))).digest('hex')
}

function withResource(workbook: Workbook, name: string, data: string): Workbook {
  const others = workbook.resources.filter(resource => resource.name !== name)
  return { ...workbook, resources: [...others, { name, data }] }
}

function withCell(workbook: Workbook, cell: unknown): Workbook {
  const sheet = workbook.sheets['sheet-1'] ?? {}
  return { ...workbook, sheets: { ...workbook.sheets, 'sheet-1': { ...sheet, cellData: { 0: { 0: cell } } } } }
}

function linkCell(url: unknown, rangeId: unknown = 'r1', ranges?: unknown): unknown {
  return { v: 'link', p: { body: { dataStream: 'link\r\n', customRanges: ranges ?? [{ startIndex: 0, endIndex: 3, rangeId, rangeType: HYPERLINK_RANGE_TYPE, properties: { url } }] } } }
}

function imageCell(source: unknown): unknown {
  return { p: { body: { dataStream: '\b\r\n' }, drawings: { d1: { drawingId: 'd1', source, imageSourceType: 'URL' } } } }
}

function nested(depth: number): string {
  return `${'['.repeat(depth)}${']'.repeat(depth)}`
}

describe('快照的检查（inspectSnapshot）', () => {
  it('模板通过：unitId、规范化内容的 SHA-256、在的与非空的资源名、原文的字节数', () => {
    const text = sheetSnapshotFor(UNIT_ID)
    const result = passed(inspectSnapshot(bytes(text), 'sheet@1'))
    expect(result.unitId).toBe(UNIT_ID)
    expect(Buffer.from(result.contentHash).toString('hex')).toBe(sha256(text))
    expect(result.contentHash).toHaveLength(32)
    expect(result.presentResources).toEqual(profileResourceNames('sheet@1'))
    expect(result.nonEmptyResources).toEqual([])
    expect(result.rawBytes).toBe(Buffer.byteLength(text))
  })

  it('非空的资源名随结果给出；只有视图状态不同的快照哈希相同，内容不同的哈希不同', () => {
    const base = template()
    const noted = withResource(base, 'SHEET_NOTE_PLUGIN', '{"sheet-1":{"0":{"0":{"note":"备注","id":"n1","row":0,"col":0}}}}')
    const result = passed(inspectSnapshot(bytes(noted), 'sheet@1'))
    expect(result.nonEmptyResources).toEqual(['SHEET_NOTE_PLUGIN'])
    expect(result.presentResources).toEqual(profileResourceNames('sheet@1'))
    const zoomed = { ...base, sheets: { 'sheet-1': { ...base.sheets['sheet-1'], zoomRatio: 2, scrollTop: 300, scrollLeft: 40 } } }
    const hash = (value: unknown): string => Buffer.from(passed(inspectSnapshot(bytes(value), 'sheet@1')).contentHash).toString('hex')
    expect(hash(zoomed)).toBe(hash(base))
    expect(hash(withCell(base, { v: 1 }))).not.toBe(hash(base))
  })

  describe('每一条规则：不通过时给出它的标识', () => {
    it.each([
      ['encoding：不是 UTF-8', Buffer.from([0x7B, 0xC3, 0x28, 0x7D])],
      ['json：不是 JSON', '{"id":'],
      ['json：空内容', ''],
      ['json：带 BOM（不自动去掉）', `\uFEFF${sheetSnapshotFor(UNIT_ID)}`],
    ])('%s', (name, value) => {
      expect(outcome(value)).toBe(name.split('：')[0])
    })

    it(`depth：外层嵌套超过 ${SNAPSHOT_MAX_DEPTH} 层；资源 data 里的与外层累加`, () => {
      const base = template()
      const deep = (depth: number): Workbook => ({ ...base, a: JSON.parse(nested(depth - 1)) as unknown })
      expect(outcome(deep(SNAPSHOT_MAX_DEPTH))).toBe('ok')
      expect(outcome(deep(SNAPSHOT_MAX_DEPTH + 1))).toBe('depth')
      // 资源 data 从第 4 层起：备注是 { 工作表: { 行: … } }，最外两层在第 4、5 层，再往里最多到第 64 层（不累加时还能多 3 层）
      const note = (depth: number): string => `{"s":{"0":${nested(depth)}}}`
      expect(outcome(withResource(base, 'SHEET_NOTE_PLUGIN', note(SNAPSHOT_MAX_DEPTH - 5)))).toBe('ok')
      expect(outcome(withResource(base, 'SHEET_NOTE_PLUGIN', note(SNAPSHOT_MAX_DEPTH - 4)))).toBe('depth')
    })

    it(`entries：外层与资源 data 里的元素合计超过 ${SNAPSHOT_MAX_ENTRIES} 个`, () => {
      const base = template()
      const zeros = (count: number): string => `[${Array.from({ length: count }).fill('0').join(',')}]`
      const outer = Buffer.byteLength(sheetSnapshotFor(UNIT_ID)) > 0 ? JSON.parse(sheetSnapshotFor(UNIT_ID)) as object : {}
      const used = countEntries(outer) + 1
      expect(outcome(`${JSON.stringify(base).slice(0, -1)},"a":${zeros(SNAPSHOT_MAX_ENTRIES - used)}}`)).toBe('ok')
      expect(outcome(`${JSON.stringify(base).slice(0, -1)},"a":${zeros(SNAPSHOT_MAX_ENTRIES - used + 1)}}`)).toBe('entries')
      const half = Math.floor(SNAPSHOT_MAX_ENTRIES / 2)
      expect(outcome({ ...withResource(base, 'SHEET_NOTE_PLUGIN', `{"s":${zeros(half)}}`), a: JSON.parse(zeros(half)) as unknown })).toBe('entries')
    })

    it.each([
      ['顶层是数组', [1]],
      ['id 为空', { ...template(), id: '' }],
      ['sheetOrder 里有 sheets 没有的表', { ...template(), sheetOrder: ['sheet-1', 'sheet-2'] }],
      ['sheets 的值不是对象', { ...template(), sheets: { 'sheet-1': [] } }],
    ])('structure：%s', (_case, value) => {
      expect(outcome(value)).toBe('structure')
    })

    it('资源的规则（contracts 的 checkResources）：结构、重复、白名单、最小结构、必须为空', () => {
      const base = template()
      expect(outcome({ ...base, resources: null })).toBe('resources')
      expect(outcome({ ...base, resources: {} })).toBe('resources')
      expect(outcome({ ...base, resources: [...base.resources, { name: 'SHEET_NOTE_PLUGIN' }] })).toBe('resources')
      expect(outcome({ ...base, resources: [...base.resources, { name: 'SHEET_NOTE_PLUGIN', data: '{}' }] })).toBe('resource-duplicate')
      expect(outcome({ ...base, resources: [...base.resources, { name: 'SHEET_AuthzIoMockService_PLUGIN', data: '{}' }] })).toBe('resource-unknown')
      expect(outcome(withResource(base, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', '{"sheet-1":{}}'))).toBe('resource-data')
      expect(outcome(withResource(base, 'SHEET_CONDITIONAL_FORMATTING_PLUGIN', '{not json'))).toBe('resource-data')
      expect(outcome(withResource(base, 'SHEET_RANGE_PROTECTION_PLUGIN', '{"sheet-1":[{"id":"r1"}]}'))).toBe('resource-not-empty')
      // 删光规则之后的区域保护是 { 工作表 id: [] }：深层为空，不误拒
      expect(outcome(withResource(base, 'SHEET_RANGE_PROTECTION_PLUGIN', '{"sheet-1":[]}'))).toBe('ok')
      // 没有 resources 等于没有资源
      const { resources: _resources, ...withoutResources } = base
      expect(outcome(withoutResources)).toBe('ok')
    })

    it('image-source：任何深度上名为 source 的字段都要是相对的平台图片地址，资源 data 里的也算', () => {
      const base = template()
      expect(outcome(withCell(base, imageCell(ASSET)))).toBe('ok')
      expect(outcome(withCell(base, imageCell('data:image/png;base64,iVBORw0KGgo=')))).toBe('image-source')
      expect(outcome(withCell(base, imageCell(`https://docs.example.com${ASSET}`)))).toBe('image-source')
      const drawing = (source: string): string => JSON.stringify({ 'sheet-1': { data: { d1: { drawingId: 'd1', source, imageSourceType: 'URL' } }, order: ['d1'] } })
      expect(outcome(withResource(base, 'SHEET_DRAWING_PLUGIN', drawing(ASSET)))).toBe('ok')
      expect(outcome(withResource(base, 'SHEET_DRAWING_PLUGIN', drawing('/fixtures-assets/a.png')))).toBe('image-source')
      expect(outcome({ ...base, sheets: { 'sheet-1': { ...base.sheets['sheet-1'], backgroundImage: { source: 'https://example.com/bg.png' } } } })).toBe('image-source')
    })

    it('链接：单元格富文本里的链接地址是规范写法、rangeId 合写法、区间看得懂', () => {
      const base = template()
      expect(outcome(withCell(base, linkCell('https://example.com/')))).toBe('ok')
      expect(outcome(withCell(base, linkCell('mailto:someone@example.com')))).toBe('ok')
      expect(outcome(withCell(base, linkCell('https://example.com')))).toBe('link-address')
      expect(outcome(withCell(base, linkCell('mailto://someone@example.com')))).toBe('link-address')
      expect(outcome(withCell(base, linkCell('example.org')))).toBe('link-address')
      expect(outcome(withCell(base, linkCell('https://example.com/', 'a b')))).toBe('link-range-id')
      expect(outcome(withCell(base, linkCell(undefined, 'r1', [null])))).toBe('link-structure')
    })
  })

  it('规则按先后报出第一条：depth 先于 json，structure 先于资源，资源先于图片，图片先于链接', () => {
    const base = template()
    expect(outcome(`{"a":${'['.repeat(SNAPSHOT_MAX_DEPTH + 1)}`)).toBe('depth')
    expect(outcome({ ...base, id: '', resources: null })).toBe('structure')
    const imageAndLink = { p: { ...(linkCell('https://example.com') as { p: object }).p, drawings: { d1: { drawingId: 'd1', source: 'data:x' } } } }
    const foreignImage = withCell(base, imageAndLink)
    expect(outcome({ ...foreignImage, resources: [{ name: 'SHEET_AuthzIoMockService_PLUGIN', data: '' }] })).toBe('resource-unknown')
    expect(outcome(foreignImage)).toBe('image-source')
  })

  describe('恶意的形状：不爆栈，按规则拒绝或照常通过', () => {
    it('极深的嵌套（几十万层）：外层与资源 data 里的都在解析之前拒绝', () => {
      const base = template()
      expect(outcome(`${JSON.stringify(base).slice(0, -1)},"a":${nested(300_000)}}`)).toBe('depth')
      expect(outcome(withResource(base, 'SHEET_NOTE_PLUGIN', nested(300_000)))).toBe('depth')
      expect(outcome(withResource(base, 'SHEET_NOTE_PLUGIN', `{"s":${nested(300_000)}}`))).toBe('depth')
    })

    it('超多的元素：全是 0、全是空对象的数组超过上限时拒绝；20 万个键的对象照常通过、照常规范化', () => {
      const base = template()
      const over = SNAPSHOT_MAX_ENTRIES + 1
      expect(outcome(`${JSON.stringify(base).slice(0, -1)},"a":[${Array.from({ length: over }).fill('0').join(',')}]}`)).toBe('entries')
      expect(outcome(`${JSON.stringify(base).slice(0, -1)},"a":[${Array.from({ length: over }).fill('{}').join(',')}]}`)).toBe('entries')
      const keys = Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [index.toString(36), index]))
      const result = passed(inspectSnapshot(bytes({ ...base, a: keys }), 'sheet@1'))
      expect(Buffer.from(result.contentHash).toString('hex')).toBe(sha256(JSON.stringify({ ...base, a: keys })))
    })

    it('__proto__ 是普通的键：不改原型，照常检查与规范化', () => {
      const text = `${sheetSnapshotFor(UNIT_ID).slice(0, -1)},"__proto__":{"source":"${ASSET}","x":1}}`
      const result = passed(inspectSnapshot(bytes(text), 'sheet@1'))
      expect(Buffer.from(result.contentHash).toString('hex')).toBe(sha256(text))
      expect(outcome(text.replace(ASSET, 'https://evil.example/a.png'))).toBe('image-source')
    })
  })
})

/** 解析之后的元素数（对象的键加数组的项） */
function countEntries(value: unknown): number {
  let entries = 0
  const pending: unknown[] = [value]
  for (let item = pending.pop(); pending.length > 0 || item !== undefined; item = pending.pop()) {
    if (typeof item !== 'object' || item === null)
      continue
    const children: unknown[] = Object.values(item)
    entries += children.length
    pending.push(...children)
  }
  return entries
}

describe('不误拒：M0 的样本、模板与只读样本（结构与规则用真实的 SDK 产出核实，P3 设计 §3.3、§7）', () => {
  const PLATFORM_IMAGE = ASSET

  /** M0 的样本按生产的条件调整：去掉 M1-P4 起不再产生的资源、图片换成平台地址（M5 之前没有合法的图片地址） */
  function adjusted(snapshot: Workbook): Workbook {
    // M0 最小的两份样本没有 resources
    const resources = (snapshot.resources as Workbook['resources'] | undefined)?.filter(resource => resource.name !== 'SHEET_AuthzIoMockService_PLUGIN')
    const text = JSON.stringify({ ...snapshot, resources })
    const withImages = text.replace(/"source":"[^"]*"/g, `"source":"${PLATFORM_IMAGE}"`).replace(/\\"source\\":\\"[^"\\]*\\"/g, `\\"source\\":\\"${PLATFORM_IMAGE}\\"`)
    return JSON.parse(withImages) as Workbook
  }

  function samplesIn(directory: string, pattern: RegExp): { readonly name: string, readonly snapshot: Workbook }[] {
    const url = new URL(directory, REPOSITORY)
    return readdirSync(url).filter(name => pattern.test(name)).map(name => ({ name: `${directory}${name}`, snapshot: JSON.parse(readFileSync(new URL(name, url), 'utf8')) as Workbook }))
  }

  const samples = [
    ...samplesIn('spikes/m0/fixtures/sheet/', /\.json$/),
    ...samplesIn('spikes/m0/e2e/results/v03/s1/', /-sheet-.*\.json$/),
  ]

  it('M0 的工作簿样本（11 份原文与它们在三个浏览器里打开再保存的结果，共 41 份）：除了保护类的样本（必须为空），调整之后都通过', () => {
    expect(samples).toHaveLength(41)
    for (const { name, snapshot } of samples) {
      const expected = /protection/.test(name) ? 'resource-not-empty' : 'ok'
      expect(outcome(adjusted(snapshot)), name).toBe(expected)
    }
  })

  it('M0 的样本原样：带着 M1-P4 去掉的资源（resource-unknown）', () => {
    const sheetAll = samples.find(sample => sample.name.endsWith('fixtures/sheet/sheet-all.json'))
    expect(sheetAll === undefined ? undefined : outcome(sheetAll.snapshot)).toBe('resource-unknown')
  })

  it('M0 的 sheet-all 原文与浏览器保存的结果得到同一个内容哈希（差别全是空值等价与键序）', () => {
    const hash = (name: string): string => {
      const sample = samples.find(item => item.name.endsWith(name))
      if (sample === undefined)
        throw new Error(`没有样本：${name}`)
      return Buffer.from(passed(inspectSnapshot(bytes(adjusted(sample.snapshot)), 'sheet@1')).contentHash).toString('hex')
    }
    const s0 = hash('fixtures/sheet/sheet-all.json')
    for (const browser of ['chromium', 'chrome', 'webkit'])
      expect(hash(`v03/s1/${browser}-sheet-sheet-all.json`), browser).toBe(s0)
  })

  it('只读样本（生产档案收敛的综合样本）：data: 图片按规则拒绝，换成平台地址之后通过', () => {
    const sample = JSON.parse(readFileSync(new URL('tests/e2e/support/read-only-sample.json', REPOSITORY), 'utf8')) as Workbook
    expect(outcome(sample)).toBe('image-source')
    expect(outcome(adjusted(sample))).toBe('ok')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { snapshotProblem } from './snapshot-problem.ts'

describe('保存与副本的图片错误说明', () => {
  it.each([null, 42, {}])('本地 SDK 名称与类型声明不符时仍能显示位置：%j', (name) => {
    expect(snapshotProblem({ rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 's', row: 2, column: 1 }] }, 'sheet', () => name as unknown as string)).toBe('表格里有不能保存的图片。请检查：某个工作表的 B3')
  })

  it('仅凭本页名称查询显示工作表和 B3；drawing 锚点、资源和工作簿有通用说法', () => {
    const sheetName = vi.fn((id: string) => id === 's' ? '预算' : undefined)
    const imageLocations = [{ kind: 'cell', sheetId: 's', row: 2, column: 1 }, { kind: 'drawing', sheetId: 's', drawingId: 'd', row: 26, column: 26 }, { kind: 'sheet', sheetId: 'missing' }, { kind: 'resource', resourceIndex: 1 }, { kind: 'workbook' }]
    expect(snapshotProblem({ rule: 'image-source', imageLocations }, 'sheet', sheetName)).toBe('表格里有不能保存的图片。请检查：工作表「预算」的 B3；工作表「预算」的 AA27 附近的浮动图片；某个工作表；表格附加内容；工作簿中的其他位置')
    expect(sheetName.mock.calls).toEqual([['s'], ['s'], ['missing']])
  })

  it('无实例或查不到名称时不回显服务端 id；无锚点的 drawing 不猜坐标', () => {
    expect(snapshotProblem({ rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 'private_id', row: 0, column: 0 }, { kind: 'drawing', sheetId: 'private_id', drawingId: 'secret_id' }] }, 'sheet')).toBe('表格里有不能保存的图片。请检查：某个工作表的 A1；某个工作表的浮动图片')
  })

  it.each([
    undefined,
    null,
    'bad',
    {},
    { rule: 'later' },
    { rule: 'link-address' },
    { rule: 'image-source' },
    { rule: 'image-source', imageLocations: [] },
    { rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 's', row: -1, column: 0 }] },
    { rule: 'image-source', imageLocations: Array.from({ length: 6 }, () => ({ kind: 'workbook' })) },
  ])('旧/未知/畸形响应保持原规则文案：%j', (details) => {
    const lookup = vi.fn()
    const message = snapshotProblem(details, 'sheet', lookup)
    const rule = typeof details === 'object' && details !== null && 'rule' in details ? details.rule : undefined
    expect(message).toBe(rule === 'image-source' ? '表格里有不能保存的图片' : rule === 'link-address' ? '表格里有不能保存的链接' : '表格内容的格式不正确')
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('保存与副本的链接错误说明', () => {
  it.each(['link-address', 'link-structure', 'link-range-id'])('%s 只用本页表名定位，重复位置只显示一次', (rule) => {
    const linkLocations = [
      { kind: 'cell', sheetId: 's', row: 2, column: 1 },
      { kind: 'cell', sheetId: 's', row: 2, column: 1 },
      { kind: 'sheet', sheetId: 'missing' },
      { kind: 'workbook' },
    ]
    expect(snapshotProblem({ rule, linkLocations }, 'sheet', id => id === 's' ? '预算' : undefined)).toBe('表格里有不能保存的链接。请检查：工作表「预算」的 B3；某个工作表；工作簿中的其他位置')
  })

  it('查询名称抛错时仍保留单元格位置；不显示原始 id 或额外地址', () => {
    expect(snapshotProblem({
      rule: 'link-address',
      linkLocations: [{ kind: 'cell', sheetId: 'private_id', row: 26, column: 26, url: 'private address' }],
    }, 'sheet', () => { throw new Error('disposed') })).toBe('表格里有不能保存的链接。请检查：某个工作表的 AA27')
  })

  it('名称只取当前实例的最多 120 字符', () => {
    expect(snapshotProblem({ rule: 'link-address', linkLocations: [{ kind: 'sheet', sheetId: 's' }] }, 'sheet', () => '名'.repeat(121))).toBe(`表格里有不能保存的链接。请检查：工作表「${'名'.repeat(120)}…」`)
  })

  it.each([
    {},
    { linkLocations: [] },
    { linkLocations: [{ kind: 'cell', sheetId: 's', row: -1, column: 0 }] },
    { linkLocations: Array.from({ length: 6 }, () => ({ kind: 'workbook' })) },
    { imageLocations: [{ kind: 'workbook' }] },
  ])('旧、畸形及错配位置退回通用说明：%j', (details) => {
    const lookup = vi.fn()
    expect(snapshotProblem({ rule: 'link-address', ...details }, 'sheet', lookup)).toBe('表格里有不能保存的链接')
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('文字文档的错误说明（M6-P1 S3 spec §4：说法按文档类型给出）', () => {
  it('通用规则说“文字文档”；文字文档专有的规则各有说法', () => {
    expect(snapshotProblem({ rule: 'structure' }, 'doc')).toBe('文字文档内容的格式不正确')
    expect(snapshotProblem({}, 'doc')).toBe('文字文档内容的格式不正确')
    expect(snapshotProblem({ rule: 'link-address' }, 'doc')).toBe('文字文档里有不能保存的链接')
    expect(snapshotProblem({ rule: 'resource-missing' }, 'doc')).toBe('文字文档里缺少上一版有的内容（例如图片、链接），为免丢失没有保存')
    for (const [rule, word] of [['doc-flavor', '版式'], ['doc-header-footer', '页眉'], ['doc-notes', '脚注'], ['doc-section-break', '分节'], ['doc-toc', '目录'], ['resource-mismatch', '不一致']] as const)
      expect(snapshotProblem({ rule }, 'doc'), rule).toContain(word)
  })

  it('位置说段落、图片与文档中的其他位置，不显示服务端的 id', () => {
    const linkLocations = [{ kind: 'paragraph', paragraph: 0 }, { kind: 'paragraph', paragraph: 11 }, { kind: 'document' }]
    expect(snapshotProblem({ rule: 'link-address', linkLocations }, 'doc')).toBe('文字文档里有不能保存的链接。请检查：第 1 段；第 12 段；文档中的其他位置')
    const imageLocations = [{ kind: 'doc-drawing', drawingId: 'secret_id' }, { kind: 'resource', resourceIndex: 3 }, { kind: 'document' }]
    expect(snapshotProblem({ rule: 'image-source', imageLocations }, 'doc')).toBe('文字文档里有不能保存的图片。请检查：一张图片；文字文档附加内容；文档中的其他位置')
  })
})

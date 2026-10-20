import { describe, expect, it, vi } from 'vitest'
import { snapshotProblem } from './snapshot-problem.ts'

describe('保存与副本的图片错误说明', () => {
  it.each([null, 42, {}])('本地 SDK 名称与类型声明不符时仍能显示位置：%j', (name) => {
    expect(snapshotProblem({ rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 's', row: 2, column: 1 }] }, () => name as unknown as string)).toBe('表格里有不能保存的图片。请检查：某个工作表的 B3')
  })

  it('仅凭本页名称查询显示工作表和 B3；drawing 锚点、资源和工作簿有通用说法', () => {
    const sheetName = vi.fn((id: string) => id === 's' ? '预算' : undefined)
    const imageLocations = [{ kind: 'cell', sheetId: 's', row: 2, column: 1 }, { kind: 'drawing', sheetId: 's', drawingId: 'd', row: 26, column: 26 }, { kind: 'sheet', sheetId: 'missing' }, { kind: 'resource', resourceIndex: 1 }, { kind: 'workbook' }]
    expect(snapshotProblem({ rule: 'image-source', imageLocations }, sheetName)).toBe('表格里有不能保存的图片。请检查：工作表「预算」的 B3；工作表「预算」的 AA27 附近的浮动图片；某个工作表；表格附加内容；工作簿中的其他位置')
    expect(sheetName.mock.calls).toEqual([['s'], ['s'], ['missing']])
  })

  it('无实例或查不到名称时不回显服务端 id；无锚点的 drawing 不猜坐标', () => {
    expect(snapshotProblem({ rule: 'image-source', imageLocations: [{ kind: 'cell', sheetId: 'private_id', row: 0, column: 0 }, { kind: 'drawing', sheetId: 'private_id', drawingId: 'secret_id' }] })).toBe('表格里有不能保存的图片。请检查：某个工作表的 A1；某个工作表的浮动图片')
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
    const message = snapshotProblem(details, lookup)
    const rule = typeof details === 'object' && details !== null && 'rule' in details ? details.rule : undefined
    expect(message).toBe(rule === 'image-source' ? '表格里有不能保存的图片' : rule === 'link-address' ? '表格里有不能保存的链接' : '表格内容的格式不正确')
    expect(lookup).not.toHaveBeenCalled()
  })
})

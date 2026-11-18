// doc@1 的资源白名单与规则（插件档案 v1 §3，M6-P1 S3 spec §2）：资源规则模型的三种 kind
import { describe, expect, it } from 'vitest'
import { checkResources, PROFILE_RESOURCES, profileResourceNames } from './profile-resources.ts'

/** M0 里经 SDK 保存的文字文档的资源（spikes/m0/fixtures/doc 与 e2e/results/v03/s1 的 21 份都是这个形状） */
const AS_SAVED = [
  { name: 'DOC_OBJECT_PERMISSION_PLUGIN', data: '[]' },
  { name: 'DOC_WORD_STYLES_PLUGIN', data: '' },
  { name: 'DOC_NOTE_PLUGIN', data: '' },
  { name: 'DOC_DRAWING_PLUGIN', data: '{"data":{},"order":[]}' },
  { name: 'DOC_HYPER_LINK_PLUGIN', data: '{"links":[]}' },
] as const

const NAMES = ['DOC_DRAWING_PLUGIN', 'DOC_HYPER_LINK_PLUGIN', 'DOC_NOTE_PLUGIN', 'DOC_OBJECT_PERMISSION_PLUGIN', 'DOC_WORD_STYLES_PLUGIN']

function withData(name: string, data: string): { name: string, data: string }[] {
  return AS_SAVED.map(resource => resource.name === name ? { name, data } : { ...resource })
}

describe('doc@1 的资源白名单与规则', () => {
  it('白名单是五项：图片与链接做结构校验，权限、Word 样式与脚注必须为空', () => {
    expect(profileResourceNames('doc@1')).toEqual(NAMES)
    const kinds = Object.fromEntries(Object.entries(PROFILE_RESOURCES['doc@1']).map(([name, rule]) => [name, rule.kind]))
    expect(kinds).toEqual({
      DOC_DRAWING_PLUGIN: 'shaped',
      DOC_HYPER_LINK_PLUGIN: 'shaped',
      DOC_NOTE_PLUGIN: 'empty',
      DOC_OBJECT_PERMISSION_PLUGIN: 'empty',
      DOC_WORD_STYLES_PLUGIN: 'empty',
    })
  })

  it('SDK 存下的形状通过：权限资源是 []，不要求顶层是对象；五项都在、都不算非空', () => {
    expect(checkResources(AS_SAVED, 'doc@1')).toEqual({ ok: true, present: NAMES, nonEmpty: [] })
  })

  it('有图片与链接时，这两项算非空（随内容存下，下一次保存按它核对不缩水）', () => {
    const resources = withData('DOC_DRAWING_PLUGIN', '{"data":{"img1":{"drawingId":"img1"}},"order":["img1"]}')
      .map(resource => resource.name === 'DOC_HYPER_LINK_PLUGIN' ? { ...resource, data: '{"links":[{"id":"r1","payload":"https://example.com/"}]}' } : resource)
    expect(checkResources(resources, 'doc@1')).toEqual({ ok: true, present: NAMES, nonEmpty: ['DOC_DRAWING_PLUGIN', 'DOC_HYPER_LINK_PLUGIN'] })
  })

  it.each(['DOC_OBJECT_PERMISSION_PLUGIN', 'DOC_WORD_STYLES_PLUGIN', 'DOC_NOTE_PLUGIN'])('%s 必须为空：任何形状只要深层为空都通过；有内容是 resource-not-empty；不是 JSON 是 resource-data', (name) => {
    for (const data of ['', '[]', '{}', 'null', '{"unit":[]}', '[{},[null]]'])
      expect(checkResources(withData(name, data), 'doc@1'), data).toMatchObject({ ok: true })
    for (const data of ['[{"permission":"edit"}]', '{"unit":["x"]}', '0', 'false', '"x"'])
      expect(checkResources(withData(name, data), 'doc@1'), data).toEqual({ ok: false, rule: 'resource-not-empty', resource: name })
    expect(checkResources(withData(name, '[1,'), 'doc@1')).toEqual({ ok: false, rule: 'resource-data', resource: name })
  })

  it('图片资源：data 是对象、每个值是对象，order 是字符串数组；空串也可以；别的形状是 resource-data', () => {
    for (const data of ['', '{"data":{},"order":[]}', '{"data":{"a":{"x":1}},"order":["a"],"extra":1}'])
      expect(checkResources(withData('DOC_DRAWING_PLUGIN', data), 'doc@1'), data).toMatchObject({ ok: true })
    for (const data of ['[]', '{}', '{"data":[],"order":[]}', '{"data":{"a":1},"order":["a"]}', '{"data":{},"order":[1]}', '{"data":{},"order":{}}', '{"data":{}}', 'x'])
      expect(checkResources(withData('DOC_DRAWING_PLUGIN', data), 'doc@1'), data).toEqual({ ok: false, rule: 'resource-data', resource: 'DOC_DRAWING_PLUGIN' })
  })

  it('链接资源：links 是数组，每一项的 id 与 payload 都是字符串；空串也可以；别的形状是 resource-data', () => {
    for (const data of ['', '{"links":[]}', '{"links":[{"id":"r1","payload":""}],"extra":1}'])
      expect(checkResources(withData('DOC_HYPER_LINK_PLUGIN', data), 'doc@1'), data).toMatchObject({ ok: true })
    for (const data of ['[]', '{}', '{"links":{}}', '{"links":[{"id":1,"payload":"x"}]}', '{"links":[{"id":"r1"}]}', '{"links":[null]}'])
      expect(checkResources(withData('DOC_HYPER_LINK_PLUGIN', data), 'doc@1'), data).toEqual({ ok: false, rule: 'resource-data', resource: 'DOC_HYPER_LINK_PLUGIN' })
  })

  it('两种档案的资源互不认识：表格的资源在文字文档里、文字文档的资源在表格里都是 resource-unknown', () => {
    expect(checkResources([{ name: 'SHEET_NOTE_PLUGIN', data: '' }], 'doc@1')).toEqual({ ok: false, rule: 'resource-unknown', resource: 'SHEET_NOTE_PLUGIN' })
    expect(checkResources([{ name: 'DOC_NOTE_PLUGIN', data: '' }], 'sheet@1')).toEqual({ ok: false, rule: 'resource-unknown', resource: 'DOC_NOTE_PLUGIN' })
  })
})

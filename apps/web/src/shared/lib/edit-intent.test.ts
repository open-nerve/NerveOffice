import { describe, expect, it } from 'vitest'
import { hasEditIntent, newDocumentPagePath, withoutEditIntent } from './edit-intent.ts'

const ID = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d'

describe('新建之后直接进入编辑的标记（M3-P2 设计 §3.4）', () => {
  it('新建之后打开的地址带 ?edit=new；编辑器页认得出它，别的写法不算', () => {
    expect(newDocumentPagePath(ID)).toBe(`/documents/${ID}?edit=new`)
    expect(hasEditIntent('?edit=new')).toBe(true)
    expect(hasEditIntent('?a=1&edit=new')).toBe(true)
    expect(hasEditIntent('')).toBe(false)
    expect(hasEditIntent('?edit=old')).toBe(false)
    expect(hasEditIntent('?edit')).toBe(false)
  })

  it('去掉标记：路径、其余的查询与片段不变', () => {
    expect(withoutEditIntent(`https://office.example/documents/${ID}?edit=new`)).toBe(`/documents/${ID}`)
    expect(withoutEditIntent(`https://office.example/documents/${ID}?a=1&edit=new#x`)).toBe(`/documents/${ID}?a=1#x`)
  })
})

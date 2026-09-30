import type { FolderAncestorRow } from './folders.repository.ts'
import { FOLDER_MAX_DEPTH } from '@nerve-office/contracts'
import { describe, expect, it } from 'vitest'
import { folderPathsOf } from './folder-path.ts'

/** 一条从空间根目录往下的链：名称就是层号 */
function chain(depth: number): FolderAncestorRow[] {
  return Array.from({ length: depth }, (_, index) => ({
    id: `f${index + 1}`,
    parentId: index === 0 ? null : `f${index}`,
    name: `第 ${index + 1} 层`,
  }))
}

describe('文件夹的路径', () => {
  it('空间根目录下的文件夹：只有它自己一段', () => {
    expect(folderPathsOf([{ id: 'a', parentId: null, name: '资料' }]).get('a')).toEqual(['资料'])
  })

  it('深层的文件夹：从空间根目录到它自己，按从浅到深的顺序', () => {
    const paths = folderPathsOf(chain(3))
    expect(paths.get('f3')).toEqual(['第 1 层', '第 2 层', '第 3 层'])
    expect(paths.get('f2')).toEqual(['第 1 层', '第 2 层'])
    expect(paths.get('f1')).toEqual(['第 1 层'])
  })

  it('行的顺序不影响结果：先给最深的一行也一样', () => {
    expect(folderPathsOf(chain(4).toReversed()).get('f4')).toEqual(['第 1 层', '第 2 层', '第 3 层', '第 4 层'])
  })

  it('同一条链上的两个文件夹共用祖先，结果各自完整', () => {
    const rows: FolderAncestorRow[] = [
      { id: 'root', parentId: null, name: '资料' },
      { id: 'a', parentId: 'root', name: '2026' },
      { id: 'b', parentId: 'root', name: '2025' },
      { id: 'c', parentId: 'a', name: 'Q3' },
    ]
    const paths = folderPathsOf(rows)
    expect(paths.get('c')).toEqual(['资料', '2026', 'Q3'])
    expect(paths.get('b')).toEqual(['资料', '2025'])
  })

  it('层数达到上限：路径正好这么多段（契约里的上限）', () => {
    expect(folderPathsOf(chain(FOLDER_MAX_DEPTH)).get(`f${FOLDER_MAX_DEPTH}`)).toHaveLength(FOLDER_MAX_DEPTH)
  })

  it('父辈不在给出的行里（被过滤掉了）：路径到此为止，不编造也不报错', () => {
    expect(folderPathsOf([{ id: 'a', parentId: 'missing', name: '资料' }]).get('a')).toEqual(['资料'])
  })

  it('父子关系成环（数据异常）：走的步数有上限，不会转不出来', () => {
    const cycle: FolderAncestorRow[] = [
      { id: 'a', parentId: 'b', name: '甲' },
      { id: 'b', parentId: 'a', name: '乙' },
    ]
    expect(folderPathsOf(cycle).get('a')).toHaveLength(FOLDER_MAX_DEPTH)
  })
})

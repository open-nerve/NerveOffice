import { describe, expect, it } from 'vitest'
import { codePointLength } from '../text/text.ts'
import {
  COPIED_TITLE_SUFFIX,
  copiedDocumentTitle,
  copyDocumentRequestSchema,
  createDocumentRequestSchema,
  DEFAULT_DOCUMENT_TITLES,
  DOCUMENT_ACCESS_VIA,
  DOCUMENT_PROFILE_OF,
  DOCUMENT_PROFILES,
  DOCUMENT_TITLE_MAX_LENGTH,
  DOCUMENT_TYPES,
  documentDetailSchema,
  documentListQuerySchema,
  documentListResponseSchema,
  documentTitleSchema,
  moveDocumentRequestSchema,
  PLATFORM_FORMAT_VERSION,
  PLATFORM_FORMAT_VERSIONS,
  updateDocumentRequestSchema,
} from './documents.ts'

describe('文档列表的查询参数', () => {
  it('limit 默认 50，查询串里的数字字符串转成数字，范围 1–100', () => {
    expect(documentListQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(documentListQuerySchema.parse({ limit: '20', cursor: 'abc' })).toEqual({ limit: 20, cursor: 'abc' })
    for (const limit of ['0', '101', '1.5', 'x', ''])
      expect(documentListQuerySchema.safeParse({ limit }).success, limit).toBe(false)
  })

  it('不接受多余的参数，游标不能为空', () => {
    expect(documentListQuerySchema.safeParse({ sort: 'title' }).success).toBe(false)
    expect(documentListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })

  it('按空间列出：spaceId 可选，必须是 UUID；没有时是个人空间（M1 兼容）', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    expect(documentListQuerySchema.parse({ spaceId })).toEqual({ spaceId, limit: 50 })
    expect(documentListQuerySchema.parse({})).not.toHaveProperty('spaceId')
    expect(documentListQuerySchema.safeParse({ spaceId: 'personal' }).success).toBe(false)
  })
})

describe('文档列表的响应', () => {
  it('时间必须是 UTC 的 ISO 8601', () => {
    const item = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', title: '周报', type: 'sheet', createdAt: '2026-09-26T08:00:00.000Z', updatedAt: '2026-09-26T09:00:00.000Z' }
    expect(documentListResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(true)
    expect(documentListResponseSchema.safeParse({ items: [{ ...item, updatedAt: '2026-09-26 09:00' }], nextCursor: null }).success).toBe(false)
  })

  it('多出的字段被丢弃：接口只做加法时，打开着的旧页面照常工作', () => {
    const item = { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d', title: '周报', type: 'sheet', createdAt: '2026-09-26T08:00:00.000Z', updatedAt: '2026-09-26T09:00:00.000Z' }
    expect(documentListResponseSchema.parse({ items: [{ ...item, starred: true }], nextCursor: null, total: 1 })).toEqual({ items: [item], nextCursor: null })
  })
})

describe('新建文档的请求', () => {
  const requestId = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'

  it('类型与 requestId 必填，标题可选；标题去掉首尾空白', () => {
    expect(createDocumentRequestSchema.parse({ type: 'sheet', requestId })).toEqual({ type: 'sheet', requestId })
    expect(createDocumentRequestSchema.parse({ type: 'sheet', title: ' 周报 ', requestId })).toEqual({ type: 'sheet', title: '周报', requestId })
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet' }).success).toBe(false)
    expect(createDocumentRequestSchema.safeParse({ type: 'doc', requestId }).success).toBe(false)
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId: 'abc' }).success).toBe(false)
  })

  it('不接受多余的字段', () => {
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId, parentId: requestId }).success).toBe(false)
  })

  it('建在哪个空间：spaceId 可选，必须是 UUID；没有时建在个人空间（M1 兼容）', () => {
    const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
    expect(createDocumentRequestSchema.parse({ type: 'sheet', requestId, spaceId })).toEqual({ type: 'sheet', requestId, spaceId })
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId, spaceId: 'team' }).success).toBe(false)
  })

  it('建在哪个文件夹：folderId 可选，必须是 UUID；省略表示空间的根目录，不接受 null（M2-P4）', () => {
    const folderId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0f'
    expect(createDocumentRequestSchema.parse({ type: 'sheet', requestId, folderId })).toEqual({ type: 'sheet', requestId, folderId })
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId, folderId: 'root' }).success).toBe(false)
    expect(createDocumentRequestSchema.safeParse({ type: 'sheet', requestId, folderId: null }).success).toBe(false)
  })

  it('标题 1–200 个字符（按码点计），不含控制字符', () => {
    expect(documentTitleSchema.safeParse('😀'.repeat(DOCUMENT_TITLE_MAX_LENGTH)).success).toBe(true)
    expect(documentTitleSchema.safeParse('😀'.repeat(DOCUMENT_TITLE_MAX_LENGTH + 1)).success).toBe(false)
    expect(documentTitleSchema.safeParse('   ').success).toBe(false)
    expect(documentTitleSchema.safeParse('周\n报').success).toBe(false)
  })

  it('按标题的共用规则（M2-P6 复核 B2）：原样保存（不做 NFC 归一）；拒绝改变文字方向的字符与换行符；不能只有看不见的字符', () => {
    expect(documentTitleSchema.parse('Jose\u0301')).toBe('Jose\u0301')
    expect(documentTitleSchema.safeParse('报告\u202Efdp.exe').success).toBe(false)
    expect(documentTitleSchema.safeParse('周\u2028报').success).toBe(false)
    expect(documentTitleSchema.safeParse('\u200B\uFEFF\u2060').success).toBe(false)
    // 名称拒绝夹着的看不见的字符（复验 N6），标题不变：原样保存
    expect(documentTitleSchema.parse('周\u200B报\u2060')).toBe('周\u200B报\u2060')
    expect(documentTitleSchema.parse('\u0645\u062D\u0645\u062F \u{1F44D}\u{1F3FD}')).toBe('\u0645\u062D\u0645\u062F \u{1F44D}\u{1F3FD}')
  })

  it('每种类型都有默认标题与档案', () => {
    for (const type of DOCUMENT_TYPES) {
      expect(documentTitleSchema.parse(DEFAULT_DOCUMENT_TITLES[type])).toBe(DEFAULT_DOCUMENT_TITLES[type])
      expect(DOCUMENT_PROFILES).toContain(DOCUMENT_PROFILE_OF[type])
    }
    expect(PLATFORM_FORMAT_VERSIONS).toContain(PLATFORM_FORMAT_VERSION)
  })
})

describe('文档的元数据', () => {
  const detail = {
    id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0d',
    title: '周报',
    type: 'sheet',
    createdAt: '2026-09-26T08:00:00.000Z',
    updatedAt: '2026-09-26T09:00:00.000Z',
    spaceId: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e',
    space: { id: '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e', type: 'team', name: '市场部' },
    folderId: null,
    accessVia: 'space',
    revision: 1,
    profile: 'sheet@1',
    formatVersion: 1,
    permissions: { canEdit: true, canRename: true, canMoveWithinSpace: true, canMoveAcrossSpaces: false, canCopy: true, canDelete: true, canShare: false },
  }

  it('档案与格式版本不按已知的取值校验：客户端自己核对，不认识的显示格式不受支持', () => {
    expect(documentDetailSchema.parse(detail)).toEqual(detail)
    expect(documentDetailSchema.parse({ ...detail, profile: 'sheet@9', formatVersion: 7 })).toMatchObject({ profile: 'sheet@9', formatVersion: 7 })
  })

  it('修订号从 1 开始', () => {
    expect(documentDetailSchema.safeParse({ ...detail, revision: 0 }).success).toBe(false)
  })

  it('带着所在的空间：编辑器页的返回链接回到那里', () => {
    expect(documentDetailSchema.safeParse({ ...detail, space: undefined }).success).toBe(false)
    expect(documentDetailSchema.safeParse({ ...detail, space: { ...detail.space, type: 'shared' } }).success).toBe(false)
    // 团队空间要有名称（返回链接上显示它）
    expect(documentDetailSchema.safeParse({ ...detail, space: { id: detail.spaceId, type: 'team' } }).success).toBe(false)
  })

  it('个人空间只有 id 与类型（M2-P5）：存的名称是所有者建号时的显示名、可以伪造（规范 §2.4），服务端多给了也被丢弃', () => {
    const personal = { id: detail.spaceId, type: 'personal' }
    expect(documentDetailSchema.parse({ ...detail, space: personal }).space).toEqual(personal)
    expect(documentDetailSchema.parse({ ...detail, space: { ...personal, name: '艾米（管理员）' } }).space).toEqual(personal)
    expect(documentDetailSchema.safeParse({ ...detail, space: { type: 'personal' } }).success).toBe(false)
  })

  it('带着所在的文件夹：在空间的根目录下时是 null，不能省略', () => {
    expect(documentDetailSchema.parse({ ...detail, folderId: detail.spaceId }).folderId).toBe(detail.spaceId)
    expect(documentDetailSchema.safeParse({ ...detail, folderId: undefined }).success).toBe(false)
  })

  it('权限的每一位都要给全：界面据此显示能做的操作（M2-P5 加上分享）', () => {
    expect(Object.keys(detail.permissions)).toContain('canShare')
    for (const permission of Object.keys(detail.permissions))
      expect(documentDetailSchema.safeParse({ ...detail, permissions: { ...detail.permissions, [permission]: undefined } }).success, permission).toBe(false)
  })

  it('看得到它的途径（M2-P5）：在空间里有角色是 space，只凭单独授权是 grant；必填，别的取值拒绝', () => {
    expect(DOCUMENT_ACCESS_VIA).toEqual(['space', 'grant'])
    expect(documentDetailSchema.parse({ ...detail, accessVia: 'grant' }).accessVia).toBe('grant')
    expect(documentDetailSchema.safeParse({ ...detail, accessVia: undefined }).success).toBe(false)
    expect(documentDetailSchema.safeParse({ ...detail, accessVia: 'link' }).success).toBe(false)
  })
})

describe('改名或空间内移动的请求', () => {
  const folderId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'

  it('两项都可选；folderId 为 null 表示空间的根目录，省略表示不移动', () => {
    expect(updateDocumentRequestSchema.parse({})).toEqual({})
    expect(updateDocumentRequestSchema.parse({ title: ' 周报 ' })).toEqual({ title: '周报' })
    expect(updateDocumentRequestSchema.parse({ folderId: null })).toEqual({ folderId: null })
    expect(updateDocumentRequestSchema.parse({ folderId: folderId.toUpperCase() })).toEqual({ folderId })
  })

  it('标题与文件夹要合法，不接受多余的字段', () => {
    expect(updateDocumentRequestSchema.safeParse({ title: '' }).success).toBe(false)
    expect(updateDocumentRequestSchema.safeParse({ folderId: 'root' }).success).toBe(false)
    expect(updateDocumentRequestSchema.safeParse({ spaceId: folderId }).success).toBe(false)
  })
})

describe('移动到某个空间的请求', () => {
  const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'

  it('spaceId 必填，folderId 可选（省略表示目标空间的根目录）', () => {
    expect(moveDocumentRequestSchema.parse({ spaceId })).toEqual({ spaceId })
    expect(moveDocumentRequestSchema.parse({ spaceId, folderId: spaceId })).toEqual({ spaceId, folderId: spaceId })
    expect(moveDocumentRequestSchema.safeParse({}).success).toBe(false)
    // 根目录用"省略"表示，没有第二种写法
    expect(moveDocumentRequestSchema.safeParse({ spaceId, folderId: null }).success).toBe(false)
  })
})

describe('复制的请求', () => {
  const spaceId = '0199a2c4-1f2e-7a3b-8c4d-5e6f7a8b9c0e'
  const requestId = '0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d'

  it('目标空间与 requestId 必填，位置与标题可选', () => {
    expect(copyDocumentRequestSchema.parse({ spaceId, requestId })).toEqual({ spaceId, requestId })
    expect(copyDocumentRequestSchema.parse({ spaceId, requestId, title: ' 周报 的副本 ' })).toMatchObject({ title: '周报 的副本' })
    expect(copyDocumentRequestSchema.safeParse({ spaceId }).success).toBe(false)
    expect(copyDocumentRequestSchema.safeParse({ requestId }).success).toBe(false)
    expect(copyDocumentRequestSchema.safeParse({ spaceId, requestId, sourceId: spaceId }).success).toBe(false)
  })

  it('默认标题是"源标题 的副本"，仍然合法', () => {
    expect(copiedDocumentTitle('周报')).toBe('周报 的副本')
    expect(documentTitleSchema.parse(copiedDocumentTitle('周报 的副本'))).toBe('周报 的副本 的副本')
  })

  it('加上"的副本"超过上限时按码点截断，不截成半个字符', () => {
    const long = '😀'.repeat(DOCUMENT_TITLE_MAX_LENGTH)
    const title = copiedDocumentTitle(long)
    expect(codePointLength(title)).toBe(DOCUMENT_TITLE_MAX_LENGTH)
    expect(title).toBe('😀'.repeat(DOCUMENT_TITLE_MAX_LENGTH - codePointLength(COPIED_TITLE_SUFFIX)) + COPIED_TITLE_SUFFIX)
    expect(documentTitleSchema.parse(title)).toBe(title)
    // 截断处留下的空白去掉，不出现两个空格
    expect(copiedDocumentTitle(`${'甲'.repeat(DOCUMENT_TITLE_MAX_LENGTH - 5)} 乙`)).toBe(`${'甲'.repeat(DOCUMENT_TITLE_MAX_LENGTH - 5)}${COPIED_TITLE_SUFFIX}`)
  })
})

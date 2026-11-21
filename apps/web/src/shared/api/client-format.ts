// 本页的构建与数据格式（M3-P3 设计 §3.5）：保存、另存为副本（查询参数）与申请编辑权、心跳（请求体）都带上，服务端核对——
// Univer 版本、插件档案与平台格式版本不等于服务端的，或者构建低于运维开关（NERVE_MIN_CLIENT_BUILD），回答 CLIENT_OUTDATED，
// 本页停下来、说明需要刷新；文档由比服务端新的版本写过时回答 DOCUMENT_TOO_NEW，本页只能阅读（incompatibilityOf）。
// 构建版本由 Vite 在构建时注入（vite.config.ts 的 define：根 package.json 的 version，镜像构建附上提交号）；
// Univer 版本与平台格式版本取打进本页的 contracts 常量（与本页实际用的 SDK 一致，后端的单元测试核对 Univer 版本等于 pnpm 目录里的）；
// 插件档案按文档的类型取 contracts 的档案（编辑器的 SHEET_PROFILE_ID 由它的单元测试核对与表格的相同）。
// M6-P1 S8b（S8 spec §2.6）：去掉写死表格档案的页面常量，改为按类型取（clientFormatOf）——编辑器页按选中的装配注入，留着一个隐含的表格默认值
// 漏改的地方就编译不过；草稿页与后台维护的可读判定用本构建能打开的类型的档案（READABLE_CLIENT_FORMATS）
import type { ClientFormat, DocumentDetail, DocumentType } from '@nerve-office/contracts'
import { compareVersions, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { ApiError } from './api-errors.ts'

/** 构建时注入的本页构建版本（vite.config.ts 的 define） */
declare const __NERVE_CLIENT_BUILD__: string

/** 本页上报的四项（都有值的 ClientFormat） */
export interface PageClientFormat extends ClientFormat {
  readonly clientBuild: string
  readonly univerVersion: string
  readonly profile: string
  readonly formatVersion: number
}

/**
 * 这一类文档的页面上报的四项（S8 spec §2.6）：键序固定为构建、Univer 版本、档案、格式版本——申请编辑权、续租与请求编辑的请求体是
 * JSON.stringify 出来的，键序就是字节。表格的就是原来的页面常量
 */
export function clientFormatOf(type: DocumentType): PageClientFormat {
  return {
    clientBuild: __NERVE_CLIENT_BUILD__,
    univerVersion: UNIVER_SDK_VERSION,
    profile: DOCUMENT_PROFILE_OF[type],
    formatVersion: PLATFORM_FORMAT_VERSION,
  }
}

/** 本构建能打开的文档类型（S8 spec §2.6）：编辑器页的装配表与它一致（start.tsx 的 satisfies）。P1 只有表格，P2 给文字文档装配时一并加上 */
export const OPENABLE_DOCUMENT_TYPES = ['sheet'] as const satisfies readonly [DocumentType, ...DocumentType[]]
export type OpenableDocumentType = (typeof OPENABLE_DOCUMENT_TYPES)[number]

/** 不空的一组档案：恢复的可读判定与其中任意一个可读即为可读 */
export type ReadableFormats = readonly [PageClientFormat, ...PageClientFormat[]]

/** 一组类型（不空）的档案，次序相同 */
function formatsOf(types: readonly [DocumentType, ...DocumentType[]]): ReadableFormats {
  const [first, ...rest] = types
  return [clientFormatOf(first), ...rest.map(type => clientFormatOf(type))]
}

/** 本构建能打开的类型的档案：草稿页与后台维护的可读判定（它们不知道草稿是哪一类文档的，草稿记录里有档案、没有类型） */
export const READABLE_CLIENT_FORMATS: ReadableFormats = formatsOf(OPENABLE_DOCUMENT_TYPES)

/** 同样的四项写成查询参数（保存、另存为副本）：用的是这一份草稿记下的档案 */
export function clientFormatParams(format: PageClientFormat): Record<string, string> {
  return {
    clientBuild: format.clientBuild,
    univerVersion: format.univerVersion,
    profile: format.profile,
    formatVersion: String(format.formatVersion),
  }
}

/**
 * 本页与服务端不兼容（M3-P3 设计 §3.5），写不进去了：
 * - client-outdated：本页的版本过旧（CLIENT_OUTDATED，服务端升级了数据格式、或者运维调高了最低构建）——重新加载就是新的页面；
 * - document-too-new：这份文档由比服务端新的版本写过（DOCUMENT_TOO_NEW，服务端回滚之后）——重新加载拿到的还是同一个版本，只能阅读
 */
export type Incompatibility = 'client-outdated' | 'document-too-new'

/** 请求的失败说明本页与服务端不兼容时给出是哪一种；别的失败为 undefined */
export function incompatibilityOf(error: unknown): Incompatibility | undefined {
  if (!(error instanceof ApiError))
    return undefined
  if (error.code === 'CLIENT_OUTDATED')
    return 'client-outdated'
  if (error.code === 'DOCUMENT_TOO_NEW')
    return 'document-too-new'
  return undefined
}

/**
 * 打开时就能看出的不兼容（详情的 sdkVersion）：这份文档记录的 SDK 版本比本页的新（认不出的写法也算）——由更新的版本写过，
 * 本页一开始就只能阅读，不提供"编辑"（申请也会被拒，DOCUMENT_TOO_NEW）
 */
export function documentIsNewer(document: Pick<DocumentDetail, 'sdkVersion'>): boolean {
  return (compareVersions(document.sdkVersion, UNIVER_SDK_VERSION) ?? 1) > 0
}

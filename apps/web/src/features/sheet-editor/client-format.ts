// 本页的构建与数据格式（M3-P3 设计 §3.5）：保存、另存为副本（查询参数）与申请编辑权、心跳（请求体）都带上，服务端核对——
// Univer 版本、插件档案与平台格式版本不等于服务端的，或者构建低于运维开关（NERVE_MIN_CLIENT_BUILD），回答 CLIENT_OUTDATED，
// 本页停下来、说明需要刷新；文档由比服务端新的版本写过时回答 DOCUMENT_TOO_NEW，本页只能阅读（incompatibilityOf）。
// 构建版本由 Vite 在构建时注入（vite.config.ts 的 define：根 package.json 的 version，镜像构建附上提交号）；
// Univer 版本与平台格式版本取打进本页的 contracts 常量（与本页实际用的 SDK 一致，后端的单元测试核对 Univer 版本等于 pnpm 目录里的）；
// 插件档案取 contracts 的 sheet 档案（编辑器的 SHEET_PROFILE_ID 由它的单元测试核对与之相同）
import type { ClientFormat, DocumentDetail } from '@nerve-office/contracts'
import { compareVersions, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { ApiError } from '../../shared/api/index.ts'

/** 构建时注入的本页构建版本（vite.config.ts 的 define） */
declare const __NERVE_CLIENT_BUILD__: string

/** 本页上报的四项（都有值的 ClientFormat） */
export interface PageClientFormat extends ClientFormat {
  readonly clientBuild: string
  readonly univerVersion: string
  readonly profile: string
  readonly formatVersion: number
}

export const PAGE_CLIENT_FORMAT: PageClientFormat = {
  clientBuild: __NERVE_CLIENT_BUILD__,
  univerVersion: UNIVER_SDK_VERSION,
  profile: DOCUMENT_PROFILE_OF.sheet,
  formatVersion: PLATFORM_FORMAT_VERSION,
}

/** 同样的四项写成查询参数（保存、另存为副本） */
export function clientFormatParams(): Record<string, string> {
  return {
    clientBuild: PAGE_CLIENT_FORMAT.clientBuild,
    univerVersion: PAGE_CLIENT_FORMAT.univerVersion,
    profile: PAGE_CLIENT_FORMAT.profile,
    formatVersion: String(PAGE_CLIENT_FORMAT.formatVersion),
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

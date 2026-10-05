// 拦截旧客户端（M3-P3 设计 §3.5，M3 总设计 §2.1 第 3 条，00 号计划书 §7.4 第 4、5 条、§8.7）：
// - 与文档无关的一半（checkClient、ClientFormatGate）：页面上报的 Univer 版本、插件档案与平台格式版本等于服务端的，
//   构建不低于运维开关（NERVE_MIN_CLIENT_BUILD）——否则 CLIENT_OUTDATED（details.reason：format 或 build），页面说明需要刷新。
//   保存、另存为副本、申请编辑权与心跳都核对；字段在契约里是可选的（旧页面重试一次结果未知的写入时要到得了重放），缺了按过旧。
//   在判断访问之前做：看不到与不存在的文档得到同样的回答；
// - 与文档有关的一半（documentTooNew、requireWritableDocument）：文档记录的 SDK 版本比服务端的新（回滚之后），或者档案、平台格式版本
//   不是服务端对这类文档写的——DOCUMENT_TOO_NEW。刷新拿到的还是同一个版本，提示"刷新"会死循环，所以与 CLIENT_OUTDATED 分开；
//   页面按详情的 sdkVersion 一开始就只能阅读。
import type { ClientFormat, ClientOutdatedReason, DocumentProfile, DocumentType } from '@nerve-office/contracts'
import type { AppConfig } from '../config/index.ts'
import { compareVersions, DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'
import { Inject, Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { APP_CONFIG } from '../config/index.ts'

/** 服务端现在写的插件档案（各类文档各一个）：页面上报的档案必须是其中之一 */
const CURRENT_PROFILES: ReadonlySet<string> = new Set<string>(Object.values(DOCUMENT_PROFILE_OF))

/** 核对过的页面：四项都上报了，数据格式等于服务端的，构建不低于运维开关。写入时记进信封（SDK 版本、客户端构建） */
export interface CurrentClient {
  readonly clientBuild: string
  readonly univerVersion: string
  readonly profile: DocumentProfile
  readonly formatVersion: number
}

/** 核对的结果：核对过的页面，或者过旧的原因 */
export type ClientCheck = { readonly ok: true, readonly client: CurrentClient } | { readonly ok: false, readonly reason: ClientOutdatedReason }

function isCurrentProfile(profile: string | undefined): profile is DocumentProfile {
  return profile !== undefined && CURRENT_PROFILES.has(profile)
}

/**
 * 核对页面上报的构建与数据格式：先看数据格式（三项都要上报、都等于服务端的，否则 format），再看构建（要上报；设了运维开关时不低于它，
 * 认不出的写法按低于它，否则 build）。+ 之后的诊断信息不参与比较（contracts 的 compareVersions）
 */
export function checkClient(format: ClientFormat, minimumBuild: string | undefined): ClientCheck {
  const { clientBuild, univerVersion, profile, formatVersion } = format
  if (univerVersion !== UNIVER_SDK_VERSION || !isCurrentProfile(profile) || formatVersion !== PLATFORM_FORMAT_VERSION)
    return { ok: false, reason: 'format' }
  if (clientBuild === undefined || (minimumBuild !== undefined && (compareVersions(clientBuild, minimumBuild) ?? -1) < 0))
    return { ok: false, reason: 'build' }
  return { ok: true, client: { clientBuild, univerVersion, profile, formatVersion } }
}

/** 文档的信封里与格式有关的几项（documents 的行） */
export interface DocumentFormat {
  readonly type: DocumentType
  readonly profile: DocumentProfile
  readonly formatVersion: number
  readonly sdkVersion: string
}

/**
 * 这份文档由比服务端更新的版本写过（回滚之后）：记录的 SDK 版本比服务端的新（认不出的写法也算），或者档案、平台格式版本不是服务端
 * 对这类文档写的。服务端改写它就是把新格式写回旧格式（US-M3-16）
 */
export function documentTooNew(document: DocumentFormat): boolean {
  return (compareVersions(document.sdkVersion, UNIVER_SDK_VERSION) ?? 1) > 0
    || document.profile !== DOCUMENT_PROFILE_OF[document.type]
    || document.formatVersion !== PLATFORM_FORMAT_VERSION
}

/** 要改写这份文档（保存、申请编辑权、心跳）之前：比服务端新时 DOCUMENT_TOO_NEW */
export function requireWritableDocument(document: DocumentFormat): void {
  if (documentTooNew(document))
    throw new AppError('DOCUMENT_TOO_NEW')
}

/** 与文档无关的一半：按配置的运维开关核对页面上报的构建与数据格式（见文件开头） */
@Injectable()
export class ClientFormatGate {
  readonly #minimumBuild: string | undefined

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.#minimumBuild = config.clients.minimumBuild
  }

  /** 核对过的页面；过旧时抛出 CLIENT_OUTDATED（details.reason 是原因，contracts 的 clientOutdatedDetailsSchema） */
  require(format: ClientFormat): CurrentClient {
    const checked = checkClient(format, this.#minimumBuild)
    if (!checked.ok)
      throw new AppError('CLIENT_OUTDATED', undefined, { details: { reason: checked.reason } })
    return checked.client
  }
}

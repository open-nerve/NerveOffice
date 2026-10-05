// 打开自检的失败（M3-P4 设计 §3.11，00 号计划书 §8.2，US-M3-15）：编辑器每次创建时核对插件档案是否完整、资源是否完整载入，
// 失败时这份文档只能阅读，页面把失败报给服务端（请求体的结构在 open-check.ts）。这里是失败的种类、资源名与异常的写法：
// 页面的判定（apps/web 的 editor/profile/open-check.ts）给出这里的 OpenCheckFailure，服务端按同样的写法严格解析。
// 不引用 zod：编辑器页引用这里。含 zod 结构的模块进了编辑器的分块，构建会把 zod 与 contracts 的几个结构模块拆进一个新的共享分块，
// 它在关掉 zod 的 JIT（apps/web 的 shared/lib/zod-jitless.ts）之前求值，编辑器页出现 CSP 违规（S2 的 E2E 实测）；与 asset-address.ts 同一个做法
import { compareCodeUnits } from './json-values.ts'

/**
 * 失败的种类（顺序也是失败清单排序的顺序）：
 * - profile-missing-hook：档案白名单里的资源 hook 没有注册（插件没有完整载入，任何文档都会这样）；
 * - profile-unexpected-hook：注册了白名单之外的表格资源 hook（SDK 或档案变了；它写出的资源服务端不收）；
 * - parse-threw：非空的资源数据解析时抛错，插件没能载入它（空串的解析失败不算：SDK 晚注册的路径照样解析空串）；
 * - parse-swallowed：非空的资源数据解析成了空值（插件吞掉了错误）；
 * - load-threw：资源载入插件的模型时抛错；
 * - serialize-threw：加载之后序列化（toJson）抛错——这样的文档之后每次保存都会失败；
 * - resource-missing、resource-emptied：载入的快照里非空的资源，加载之后立即捕获时不在了、变空了（profile-resources.ts 的 lostResources）
 */
export const OPEN_CHECK_FAILURE_KINDS = [
  'profile-missing-hook',
  'profile-unexpected-hook',
  'parse-threw',
  'parse-swallowed',
  'load-threw',
  'serialize-threw',
  'resource-missing',
  'resource-emptied',
] as const
export type OpenCheckFailureKind = (typeof OPEN_CHECK_FAILURE_KINDS)[number]

/** 档案不全（构建或 SDK 的问题，与文档的内容无关，重新加载可能就好）的两种；其余是这份文档的数据载入不完整 */
export const PROFILE_FAILURE_KINDS = ['profile-missing-hook', 'profile-unexpected-hook'] as const satisfies readonly OpenCheckFailureKind[]

/** 带异常构造器名的三种：失败是一次抛错 */
export const THROWN_FAILURE_KINDS = ['parse-threw', 'load-threw', 'serialize-threw'] as const satisfies readonly OpenCheckFailureKind[]

/** 档案不全的一种 */
export function isProfileFailure(kind: OpenCheckFailureKind): boolean {
  return (PROFILE_FAILURE_KINDS as readonly OpenCheckFailureKind[]).includes(kind)
}

/**
 * 资源名的写法：SDK 的 IResourceName（core 的 services/resource-manager/type.ts：业务名_…_PLUGIN）。档案不全时报的可能是白名单之外的名字，
 * 所以只限写法、不按白名单枚举；中间一段只收字母、数字与下划线（SDK 的资源名都是这样，例如 SHEET_AuthzIoMockService_PLUGIN）
 */
export const RESOURCE_NAME_PATTERN = /^(?:SHEET|DOC|SLIDE|BOARD|BASE|UNIVER)_\w{1,64}_PLUGIN$/

/**
 * 异常的构造器名的写法：一个标识符（TypeError、SyntaxError，生产构建压缩之后的类名也是标识符），最长 64 个字符。
 * 没有空格、冒号与引号，夹带不了 message 里的内容
 */
export const ERROR_NAME_PATTERN = /^[A-Z_$][\w$]{0,63}$/i

/**
 * 抛出的值的构造器名（只取原型上的 constructor.name，不读 message、不调用它的任何方法）；不是对象、取不到或不合写法时为 undefined。
 * 任何输入都不抛出：原型链上的 getter 抛错也接住
 */
export function errorNameOf(thrown: unknown): string | undefined {
  if ((typeof thrown !== 'object' && typeof thrown !== 'function') || thrown === null)
    return undefined
  try {
    const name: unknown = (Object.getPrototypeOf(thrown) as { constructor?: { name?: unknown } } | null)?.constructor?.name
    return typeof name === 'string' && ERROR_NAME_PATTERN.test(name) ? name : undefined
  }
  catch {
    return undefined
  }
}

/** 一项失败：种类、资源名，抛错的三种另有异常的构造器名（取不到时没有） */
export interface OpenCheckFailure {
  readonly kind: OpenCheckFailureKind
  readonly resource: string
  readonly error?: string | undefined
}

/** 失败清单的顺序：种类（OPEN_CHECK_FAILURE_KINDS 的顺序）、资源名、构造器名（没有的在前） */
export function compareOpenCheckFailures(a: OpenCheckFailure, b: OpenCheckFailure): number {
  return OPEN_CHECK_FAILURE_KINDS.indexOf(a.kind) - OPEN_CHECK_FAILURE_KINDS.indexOf(b.kind)
    || compareCodeUnits(a.resource, b.resource)
    || compareCodeUnits(a.error ?? '', b.error ?? '')
}

/** 一次上报至多这么多项失败（页面的失败清单更长时只报排在前面的） */
export const OPEN_CHECK_FAILURES_MAX = 32

/** 编辑器的打开方式（与 web 的 EditorAccess 相同） */
export const OPEN_CHECK_ACCESS = ['read', 'edit'] as const

/**
 * 这一次创建编辑器的起因：open 打开页面；enter 进入编辑（含新建之后直接进入）；refresh 阅读时"有更新"之后重建；
 * exit 退出编辑之后以只读重建；lost 失去编辑权之后以只读重建；reload 放弃修改、另存为副本之后重新载入
 */
export const OPEN_CHECK_TRIGGERS = ['open', 'enter', 'refresh', 'exit', 'lost', 'reload'] as const

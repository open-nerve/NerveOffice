// 打开自检的判定（M3-P4 设计 §3.11）：纯函数，不依赖 Univer（事实由资源守卫给出，internal-api 的 createResourceLoadGuard）。
// 任何一次创建编辑器都做（阅读、编辑、各种重建），两次核对：
// - 创建工作簿时（createWorkbook() 刚返回，还没有渲染、公式的写回与用户输入）：档案完整性（表格的资源 hook 与档案白名单，缺的、多的）、
//   守卫记下的加载问题、资源比较（载入的快照里原来非空的，加载之后立即捕获时不在了、变空了，contracts 的 lostResources）与序列化抛错；
// - 就绪之后：档案完整性再核对一次（防 SDK 把注册挪到更晚），加上之后才记下的加载问题。两次的失败合在一起。
// 误报会让一份文档谁也编辑不了（§3.17）：加载、序列化与资源比较只算档案白名单里的名字（白名单之外的 hook 由档案完整性报出，
// 白名单之外的资源本来就会被丢掉）；空串的解析失败不算（守卫已经排除）；"内容有变化"不算。
// 适配层只报告结果，能不能编辑由编辑器页决定（ADR-015：失败的可编辑编辑器整个丢弃、以只读重建）
import type { DocumentProfile, OpenCheckFailure, ResourceOutput } from '@nerve-office/contracts'
import { compareOpenCheckFailures, lostResources, profileResourceNames } from '@nerve-office/contracts'

/** 打开自检的结果：通过，或者失败清单（按种类、资源名排序，不重复） */
export type OpenCheck
  = | { readonly ok: true }
    | { readonly ok: false, readonly failures: readonly [OpenCheckFailure, ...OpenCheckFailure[]] }

/** 逐个 hook 的捕获（资源守卫的 captureSheetResources）：序列化出的资源与序列化出错的 */
export interface CapturedResources {
  readonly outputs: readonly ResourceOutput[]
  readonly failures: readonly OpenCheckFailure[]
}

/** 两次核对都要的事实：档案、business 内注册着的 hook 名、守卫到这时为止记下的加载问题 */
export interface HookFacts {
  readonly profile: DocumentProfile
  readonly hookNames: readonly string[]
  readonly loadFailures: readonly OpenCheckFailure[]
}

/** 创建工作簿时另有的：载入的快照里的 resources（创建之前取出的，原样）与加载之后立即的捕获 */
export interface CreatedFacts extends HookFacts {
  readonly resourcesBefore: unknown
  readonly captured: CapturedResources
}

/** 失败清单合成结果：去掉重复的（种类、资源名、构造器名都相同），排好序 */
export function openCheckOf(failures: readonly OpenCheckFailure[]): OpenCheck {
  const unique = new Map(failures.map(failure => [`${failure.kind}\u0000${failure.resource}\u0000${failure.error ?? ''}`, failure]))
  const [first, ...rest] = [...unique.values()].sort(compareOpenCheckFailures)
  return first === undefined ? { ok: true } : { ok: false, failures: [first, ...rest] }
}

/** 结果里的失败清单（通过时是空的） */
export function failuresOf(check: OpenCheck): readonly OpenCheckFailure[] {
  return check.ok ? [] : check.failures
}

/** 档案完整性：白名单里没注册的是 profile-missing-hook，注册了而不在白名单里的是 profile-unexpected-hook */
export function hookSetFailures(profile: DocumentProfile, hookNames: readonly string[]): OpenCheckFailure[] {
  const expected = new Set(profileResourceNames(profile))
  const registered = new Set(hookNames)
  return [
    ...[...expected].filter(name => !registered.has(name)).map(resource => ({ kind: 'profile-missing-hook', resource }) as const),
    ...[...registered].filter(name => !expected.has(name)).map(resource => ({ kind: 'profile-unexpected-hook', resource }) as const),
  ]
}

/** 只留档案白名单里的名字 */
function withinProfile(profile: DocumentProfile, failures: readonly OpenCheckFailure[]): OpenCheckFailure[] {
  const names = new Set(profileResourceNames(profile))
  return failures.filter(failure => names.has(failure.resource))
}

/**
 * 资源比较与序列化抛错：序列化抛错的照记；原来非空、加载之后不在的是 resource-missing（序列化抛错的那几项不算"不在"——
 * hook 在、只是写不出来，已经记了 serialize-threw），变空的是 resource-emptied
 */
function resourceFailures(profile: DocumentProfile, resourcesBefore: unknown, captured: CapturedResources): OpenCheckFailure[] {
  const unserializable = new Set(captured.failures.map(failure => failure.resource))
  const { missing, emptied } = lostResources(resourcesBefore, captured.outputs, profile)
  return [
    ...captured.failures,
    ...missing.filter(name => !unserializable.has(name)).map(resource => ({ kind: 'resource-missing', resource }) as const),
    ...emptied.map(resource => ({ kind: 'resource-emptied', resource }) as const),
  ]
}

/** 创建工作簿时的核对 */
export function checkCreated(facts: CreatedFacts): OpenCheck {
  return openCheckOf([
    ...hookSetFailures(facts.profile, facts.hookNames),
    ...withinProfile(facts.profile, facts.loadFailures),
    ...withinProfile(facts.profile, resourceFailures(facts.profile, facts.resourcesBefore, facts.captured)),
  ])
}

/** 就绪之后的再核对：在创建时的结果上加上这时的档案完整性与加载问题 */
export function recheckReady(created: OpenCheck, facts: HookFacts): OpenCheck {
  return openCheckOf([
    ...failuresOf(created),
    ...hookSetFailures(facts.profile, facts.hookNames),
    ...withinProfile(facts.profile, facts.loadFailures),
  ])
}

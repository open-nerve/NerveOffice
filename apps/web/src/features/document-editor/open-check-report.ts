// 打开自检失败的上报（M3-P4 设计 §3.13，US-M3-15）：按新建的编辑器的打开自检给出 POST /api/documents/{id}/open-check-failures 的请求体，
// 由编辑模式（edit-mode.ts）经 editor-api.ts 的 reportOpenCheckFailures 发出——每次创建的结果至多一次，会话不是本人时不发，不看结果、不重试。
// 请求体与服务端的严格解析同一份写法（contracts 的 open-check-failures.ts；页面发普通的 JSON，不引用带 zod 的 openCheckReportSchema）：
// 修订号、打开方式与起因，失败清单（种类、资源名，抛错的三种另有异常的构造器名），本页的构建与数据格式。不带快照、资源的 data 与异常的 message。
// 服务端对不合写法的请求整份回 400、什么也不记：这里先按同一份写法筛（资源名、构造器名，只有抛错的种类带构造器名），至多 32 项，
// 筛完没有了（或者修订号不对）就不报。
// M6-P1 S8a（S8 spec §1.1、§1.3）：随编辑模式的通用核心搬进共用编辑会话层；打开自检的结果 OpenCheck 由这里按 contracts 的 OpenCheckFailure
// 定义，不再引用编辑器适配层。S8b（S8 spec §2.6）：页面上报的档案按类型注入——编辑模式传入它的选项里的档案（编辑器页按选中的装配给出）
import type { OpenCheckFailure, OpenCheckFailureKind, OpenCheckReport } from '@nerve-office/contracts'
import type { PageClientFormat } from '../../shared/api/client-format.ts'
import { ERROR_NAME_PATTERN, OPEN_CHECK_FAILURES_MAX, RESOURCE_NAME_PATTERN, THROWN_FAILURE_KINDS } from '@nerve-office/contracts'

/**
 * 新建的编辑器的打开自检的结果（会话层自己的定义，S8 spec §1.1）：通过，或者失败清单（按种类、资源名排序，不重复）。编辑器适配层的同名类型
 * （editor/profile/open-check.ts）与它同形：表格编辑器交给编辑模式时由类型检查核对，适配层多出一种结果就编译不过
 */
export type OpenCheck
  = | { readonly ok: true }
    | { readonly ok: false, readonly failures: readonly [OpenCheckFailure, ...OpenCheckFailure[]] }

/** 这一次创建的打开方式（read、edit）、起因（open、enter、refresh、exit、lost、reload）与载入的内容的修订号 */
export type OpenCheckContext = Pick<OpenCheckReport, 'access' | 'trigger' | 'revision'>

/** 一项失败按服务端的写法：资源名不合写法的不报（整份会被拒）；构造器名合写法、而且是抛错的种类时才带上 */
function reportable(failure: OpenCheckFailure): OpenCheckFailure | undefined {
  if (!RESOURCE_NAME_PATTERN.test(failure.resource))
    return undefined
  const thrown = (THROWN_FAILURE_KINDS as readonly OpenCheckFailureKind[]).includes(failure.kind)
  const error = thrown && failure.error !== undefined && ERROR_NAME_PATTERN.test(failure.error) ? failure.error : undefined
  return error === undefined ? { kind: failure.kind, resource: failure.resource } : { kind: failure.kind, resource: failure.resource, error }
}

/** 打开自检的上报的请求体（format 是页面上报的档案）；通过了、筛完没有可报的、修订号不是正整数时为 undefined（不报） */
export function openCheckReportOf(check: OpenCheck, context: OpenCheckContext, format: PageClientFormat): OpenCheckReport | undefined {
  if (check.ok || !Number.isSafeInteger(context.revision) || context.revision < 1)
    return undefined
  const failures = check.failures.flatMap(failure => reportable(failure) ?? []).slice(0, OPEN_CHECK_FAILURES_MAX)
  if (failures.length === 0)
    return undefined
  return { revision: context.revision, access: context.access, trigger: context.trigger, failures, ...format }
}

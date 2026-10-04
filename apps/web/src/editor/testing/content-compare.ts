// "改动被拦住"怎么判断（M2-P3 设计 §3.7，M3-P2 设计 §3.5）：E2E 与测试构建的页面自检共用的比较口径。
// - 内存快照的内容（contentOf）：画布上的内容读不出来，比较探针给出的内存快照；
// - 命令日志里哪些是"改文档的 mutation"（documentChangesIn、documentChangeAttemptsIn）：与编辑器的变更检测同一个判定
//   （change-tracking/change-classifier.ts 的排除标记、档案的排除名单，单元测试核对两边一致）。
// 这个文件不引用任何模块：E2E 经模块边界的例外引用它（eslint.config.ts），Playwright 的进程里不能带进 Univer 与 web 的其他代码。
// 所以服务端"内容相同不递增"的规范化内容（contracts 的 documents/content-canonical.ts，M3-P3）它也引用不了：
// 口径相同（视图状态、空资源与"不在"等价、资源里去掉空键、不看键序），单元测试核对两边对"内容相同"的判断一致。

/**
 * 快照的内容（比较用，M0-P3 报告 §3.4 的口径，spikes/m0/src/harness/content-compare.ts）：
 * - 资源的 data 解析成对象，去掉取值为空的键（空数组、空对象、null、空串）：SDK 的读取会给模型补上空的规则表
 *   （观察者效应，M0-P3 报告 §2.3 第 4 条），复制单元格、删除工作表的命令即使被取消也会读一次数据验证的规则表，这类差别不是改动；
 * - 去掉工作表的视图状态 zoomRatio、scrollTop、scrollLeft：缩放与滚动不产生 mutation，只读时照常可用（M0-P3 报告 §2.3 第 6 条）；
 * - 资源按名称排序；对象键的顺序不影响比较（sameContent 按排好键的写法比较，E2E 的 toEqual 本来就不看键的顺序）。
 * 单元格、样式、工作表的结构与顺序原样比较
 */
export function contentOf(snapshotText: string): unknown {
  const snapshot = JSON.parse(snapshotText) as { sheets?: Record<string, Record<string, unknown>>, resources?: readonly { name: string, data: string }[] }
  for (const sheet of Object.values(snapshot.sheets ?? {})) {
    delete sheet.zoomRatio
    delete sheet.scrollTop
    delete sheet.scrollLeft
  }
  const resources = [...snapshot.resources ?? []]
    .map(resource => ({ name: resource.name, data: pruneEmpty(resource.data === '' ? null : JSON.parse(resource.data) as unknown) }))
    .filter(resource => !isEmptyValue(resource.data))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { ...snapshot, resources }
}

/** 结构上为空：null、空串、空数组、空对象，或者各层都为空 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '')
    return true
  if (Array.isArray(value))
    return value.every(isEmptyValue)
  if (typeof value === 'object')
    return Object.values(value).every(isEmptyValue)
  return false
}

/** 去掉取值为空的键（例如某张工作表对应的空规则表），它们与"没有这个键"在内容上等价 */
function pruneEmpty(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(pruneEmpty)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).filter(([, item]) => !isEmptyValue(item)).map(([key, item]) => [key, pruneEmpty(item)]))
  return value
}

/** JSON 的值排好对象的键之后的写法：两个值的写法相同，内容就相同（不看键的顺序） */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  })
}

/** 两份快照的内容相同（contentOf 的口径） */
export function sameContent(snapshotText: string, otherText: string): boolean {
  return canonicalJson(contentOf(snapshotText)) === canonicalJson(contentOf(otherText))
}

/** 命令日志里的一条（与 testing/e2e-probe.ts 的 ProbeCommand 同样的字段，这里只声明判断用到的） */
export interface LoggedCommand {
  /** before：执行前（canceled 是排在探针之前的订阅者给出的结果）；executed：执行完 */
  readonly phase: 'before' | 'executed'
  readonly id: string
  readonly kind: 'command' | 'operation' | 'mutation'
  readonly canceled: boolean
  /** 参数里的 unitId；没有时为 undefined */
  readonly unitId?: string | undefined
  /** 执行选项里为真的标记（onlyLocal、fromFormula 等） */
  readonly flags: readonly string[]
}

/** 执行选项里带这些标记的 mutation 不是用户的修改（与 change-tracking/change-classifier.ts 的 EXCLUDED_EXECUTION_OPTIONS 相同，单元测试核对） */
export const NOT_USER_CHANGE_FLAGS: readonly string[] = ['onlyLocal', 'fromCollab', 'fromChangeset', 'fromFormula']

/** 类型是 MUTATION、实际只清除界面上的图片变换框（与档案的 CHANGE_DETECTION_EXCLUDED_MUTATIONS 相同，单元测试核对） */
export const NOT_CHANGE_MUTATIONS: readonly string[] = ['sheet.operation.clear-drawing-transformer']

/** 变更检测会认作修改的 mutation（本文档的、不带排除标记的、不在排除名单里的）在 phase 这一阶段的记录 */
function changesIn<T extends LoggedCommand>(commands: readonly T[], phase: LoggedCommand['phase'], unitId: string): T[] {
  return commands.filter(command => command.phase === phase && command.kind === 'mutation'
    && (command.unitId === undefined || command.unitId === unitId)
    && !command.flags.some(flag => NOT_USER_CHANGE_FLAGS.includes(flag))
    && !NOT_CHANGE_MUTATIONS.includes(command.id))
}

/** 命令日志里执行了的、变更检测会认作修改的 mutation：只读时一条都不应该有（防火墙的不变量，M2-P3 设计 §3.3） */
export function documentChangesIn<T extends LoggedCommand>(commands: readonly T[], unitId: string): T[] {
  return changesIn(commands, 'executed', unitId)
}

/**
 * 尝试过的、变更检测会认作修改的 mutation（执行前的记录，被取消的也算）：就绪到 steady 之间一条都不应该有，
 * 否则就是进入只读时 SDK 试图改文档、被防火墙取消了（M2-P3 审查 B9）
 */
export function documentChangeAttemptsIn<T extends LoggedCommand>(commands: readonly T[], unitId: string): T[] {
  return changesIn(commands, 'before', unitId)
}

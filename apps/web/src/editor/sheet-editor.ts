// 表格编辑器（P4 设计 §3.6.1、§3.6.3）：这份快照在 Univer 里怎么编辑、怎么捕获。请求、保存状态与界面由编辑器页负责。
// 一页一份文档、整页加载与卸载（计划书 §10.2）：同一个实例里不能创建两份 unitId 相同的文档，反复创建销毁也会泄漏内存。
// 能不能编辑在创建时决定（access，M2-P3 设计 §3.1）：只读的文档一开始就以只读创建，没有"就绪之后再设"的第二条路。
// 顺序：
// 1. 创建公式 Worker（模块 Worker），先挂上它的回报与错误的监听（主线程模式没有 Worker，M3-P4 设计 §3.14）；
// 2. new Univer（身份替换：授权服务按 access 回答，ADR-009；语言服务换成销毁之后不抛错的实现，internal-api 的 disposalSafeLocaleOverride；
//    资源守卫：资源管理服务换成只观察的子类，M3-P4 的打开自检），
//    按档案注册插件（界面的配置按 access）；FUniver.newAPI；
// 3. 在创建工作簿之前挂上入口守卫、链接的改写（M3-P3）、只读守卫（只读时：防火墙与撤销拦截）、变更检测、单元格编辑与生命周期的监听，
//    加载过程中的命令也看得到、拦得住、改得到；更要紧的是执行前监听的先后，见 mount 里的不变量（M2-P6 复核 F3）；
// 4. 取出载入的快照里的资源（打开自检的"之前"）；createWorkbook，核对 unitId；刚返回时做打开自检的第一次核对（档案完整性、
//    加载问题、资源比较与序列化，profile/open-check.ts）；只读时把每张工作表的权限点设为只读（read-only/read-only-guard.ts）；
// 5. 等渲染完成（Rendered）、主线程到 Ready 后装上 IMAGE() 的限制、Worker 回报它那边也装上了；只读时装上渲染之后才有的界面处理
//    （冻结线、编辑栏的焦点）、清空撤销栈；打开自检再核对一次 hook 集合与之后的加载问题，才返回；
//    任何一步失败（包括创建 Univer、注册插件）都按相反的顺序销毁已经创建的一切并抛出，页面显示"编辑器加载失败"（审查 B8）。
//    打开自检的失败不是加载失败：编辑器照常返回，结果在 openCheck 上，能不能编辑由编辑器页决定（M3-P4 设计 §3.11 第 4 条）。
// 返回之前（就绪之前）不允许输入（M1 总设计 §6.6）由编辑器页的交互屏障保证（interaction-barrier.ts，Codex 评审 CX1）：
// 能编辑的文档从创建起就是可编辑的（授权服务一律允许），就绪之前的输入只能靠屏障拦住。
// 测试构建（vite build --mode e2e）另在就绪之后装上 E2E 的探针（testing/e2e-probe.ts），注册插件之前看档案故障开关
// （testing/profile-fault.ts，地址带 profileFault=<组> 时不注册这几组），地址参数还可以选主线程的公式模式（testing/formula-mode.ts）
// （M3-P4 设计 §3.14）；生产构建里没有这几步与开关，只有 Worker 模式。
// 模式切换一律重建（M3-P2 设计 §3.1）：编辑器页销毁旧的、以目标的 access 新建一个；重建之前取出视图状态（viewState），
// 新建时交回来，就绪之后恢复（view-state.ts）。容器上写着这一个编辑器的打开方式（data-editor-access，读 / 写），销毁时去掉。
// M3-P4（设计 §3.2、§3.4–§3.6、§3.10）：自动保存要的信号——公式的进度（变更检测的跟踪器）、组合输入（composition-watch.ts）、
// 面板的防抖（panel-debounce-watch.ts）；创建参数 recalculate：带"公式待更新"的文档进入编辑时强制全量重算（档案的表格公式插件以
// CalculationMode.FORCED 创建），收齐的跟踪器在看到它的触发命令之前不算收齐（formula-settle-tracker.ts）。
import type { CellEditingWatch } from './cell-editing-watch.ts'
import type { ChangeClassifierConfig } from './change-tracking/change-classifier.ts'
import type { ChangeTracker } from './change-tracking/change-tracker.ts'
import type { CleanupStack } from './cleanup-stack.ts'
import type { CompositionWatch } from './composition-watch.ts'
import type { EditorAccess } from './editor-access.ts'
import type { LifecycleWatch, SheetEditorLifecycle } from './lifecycle-watch.ts'
import type { PanelDebounceWatch } from './panel-debounce-watch.ts'
import type { OpenCheck } from './profile/open-check.ts'
import type { FormulaExecution, FormulaMode } from './profile/sheet-profile.ts'
import type { SheetViewState } from './view-state.ts'
import type { WorkbookSnapshot } from './workbook-snapshot.ts'
import { LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { defaultTheme } from '@univerjs/themes'
import { pollUntil, withDeadline } from './async-tools.ts'
import { watchCellEditing } from './cell-editing-watch.ts'
import { createChangeTracker } from './change-tracking/change-tracker.ts'
import { createCleanupStack } from './cleanup-stack.ts'
import { watchComposition } from './composition-watch.ts'
import { editorIdentityOverride } from './identity/editor-authz-io.service.ts'
import { installRestrictedImageFunction } from './image-function/install-image-policy.ts'
import { watchWorkerImagePolicy } from './image-function/worker-image-policy.ts'
import { createResourceLoadGuard, disposalSafeLocaleOverride } from './internal-api/index.ts'
import { watchLifecycle } from './lifecycle-watch.ts'
import { watchPanelDebounces } from './panel-debounce-watch.ts'
import { installEntryGuards } from './profile/entry-guards.ts'
import { installLinkPolicy } from './profile/link-policy.ts'
import { SHEET_ZH_CN } from './profile/locale.ts'
import { checkCreated, recheckReady } from './profile/open-check.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS, SHEET_PROFILE_ID, sheetPluginEntries } from './profile/sheet-profile.ts'
import { installReadOnlyGuard } from './read-only/read-only-guard.ts'
import { SheetEditorLoadError } from './sheet-editor-error.ts'
import { readViewState, restoreViewState } from './view-state.ts'
import { parseWorkbookSnapshot } from './workbook-snapshot.ts'
// Facade 只引用用到的部分（包体积）：createWorkbook、getWorkbook、save 在 sheets，编辑中的单元格在 sheets-ui
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import './profile/styles.ts'

export interface SheetEditor {
  readonly unitId: string
  /** 本地修改序号：检测到本文档的修改时加一（P4 设计 §3.6.5） */
  readonly changeSeq: () => number
  readonly onChange: (listener: () => void) => () => void
  readonly lifecycle: () => SheetEditorLifecycle
  readonly onLifecycle: (listener: (stage: SheetEditorLifecycle) => void) => () => void
  /** 单元格编辑器开着（单元格或编辑栏里正在编辑，还没提交或放弃）：离开提示据此判断 */
  readonly isCellEditing: () => boolean
  /** 单元格编辑器里有还没提交的输入（只是打开、还没改动时没有）：页头据此显示有未保存的修改（Codex 评审 CX6） */
  readonly hasPendingCellInput: () => boolean
  /** 有没有还没提交的输入变了 */
  readonly onCellEditingChange: (listener: () => void) => () => void
  /**
   * 提交正在编辑的单元格（等同回车，选区随之下移），返回时这次的提交已经写进工作簿（跨工作表的提交也等到写入）；
   * 提交之后仍在编辑时返回 false。
   * 数据验证拒绝输入时，SDK 先关掉编辑器、写入后回滚并弹出它自己的提示：返回 true，快照里是回滚后的内容，与界面一致
   */
  readonly commitCellEditing: () => Promise<boolean>
  /** 等公式收齐（P4 设计 §3.6.6），最多等 timeoutMs */
  readonly settleFormulas: (timeoutMs: number) => Promise<'settled' | 'timeout'>
  /**
   * 公式收齐了没有（formula-settle-tracker.ts 的三个条件；以强制全量重算创建时，看到它的触发命令之前不算，M3-P4）：
   * 自动保存按它决定捕获带不带"公式待更新"、什么时候补存
   */
  readonly formulasSettled: () => boolean
  /** 公式的进度变了（收齐与否可能变了）：在 SDK 执行命令的过程中同步调用，监听者只记下、之后再做 */
  readonly onFormulaProgress: (listener: () => void) => () => void
  /** 正在组合输入（输入法组字，composition-watch.ts）：组字中自动保存不捕获（计划书 §7.3） */
  readonly composing: () => boolean
  /** 组字开始或结束（组字的元素失焦、页面隐藏时的复位也算结束） */
  readonly onCompositionChange: (listener: () => void) => () => void
  /**
   * 等面板里防抖中的改动写进模型（批注浮层 300 ms、数据验证面板 1 秒，panel-debounce-watch.ts）：这些面板开着时有过输入，就等到
   * SDK 的防抖到点；没有时立即兑现。退出编辑、交出、按保存与失去编辑权的捕获之前等它（M3-P4 设计 §3.4）。从不失败
   */
  readonly settlePanels: () => Promise<void>
  /** 捕获：JSON.stringify(save())；捕获前不调用 Facade 的读取方法（它们可能改动模型） */
  readonly capture: () => string
  /**
   * 现在的视图状态（当前工作表、左上角可见的行列、主选区）：重建之前取出，交给新的编辑器恢复（M3-P2 设计 §3.3）。
   * 取不出来（Facade 出错，已报告）或已经销毁时为 undefined
   */
  readonly viewState: () => SheetViewState | undefined
  /**
   * 打开自检的结果（M3-P4 设计 §3.11）：创建工作簿时的核对（档案完整性、资源的加载、资源比较与序列化）与就绪之后的再核对合在一起，
   * createSheetEditor 返回时就定了、之后不变。失败时这份文档的数据没有完整载入（或者编辑器没有完整载入）：适配层只报告，
   * 能不能编辑由编辑器页决定——失败的可编辑编辑器整个丢弃、以只读重建，绝不保存（ADR-015 的"能不能编辑在创建时决定"）
   */
  readonly openCheck: OpenCheck
  /** 销毁实例、终止 Worker；可以重复调用 */
  readonly dispose: () => void
}

export interface CreateSheetEditorOptions {
  /** 编辑器挂载的容器 */
  readonly container: HTMLElement
  /** 快照的 JSON 文本（服务端下发的原文） */
  readonly snapshot: string
  /**
   * 这次以什么方式打开（编辑器页按服务端的 permissions.canEdit 决定）。只读时：授权服务只允许查看与复制，
   * 装上只读守卫，界面没有工具栏、右键菜单、底栏菜单与新增工作表按钮（M2-P3 设计 §3.2–§3.4）
   */
  readonly access: EditorAccess
  /** 重建之前的编辑器给出的视图状态：就绪之后恢复；恢复不了（工作表已经不在等）就是默认视图，不影响编辑器可用 */
  readonly viewState?: SheetViewState | undefined
  /**
   * 打开时强制全量重算（M3-P4 设计 §3.5 第 3 条：带"公式待更新"的文档进入编辑）：档案的表格公式插件以 CalculationMode.FORCED 创建；
   * 收齐的跟踪器看到它的触发命令之前不算收齐，自动保存等它算完再补存。重算的写回带 onlyLocal，不算修改
   */
  readonly recalculate?: boolean
  /**
   * 页面自己的界面（编辑器页的页头）：组合输入与面板防抖的输入目标在它里面的不算（那里的输入不进表格）；不给时都算
   */
  readonly pageUi?: Node | undefined
}

/**
 * 容器上写着这一个编辑器的打开方式（读、写）：创建时写上，销毁时去掉。E2E 据此认出换上的是哪一个编辑器（模式切换一律重建，
 * 新旧两个先后用同一个容器）
 */
export const EDITOR_ACCESS_ATTRIBUTE = 'data-editor-access'

/** 就绪的时限：Worker 20 秒没有回报 IMAGE() 的安装结果就失败（P4 设计 §3.6.7）；渲染与主线程的安装在同一个时限内 */
const READY_TIMEOUT_MS = 20_000

/** 公式收齐每 20 ms 判断一次（P4 设计 §3.6.6） */
const SETTLE_POLL_INTERVAL_MS = 20

/**
 * override：编辑器身份（授权服务按 access 回答）、销毁之后不抛错的语言服务（internal-api 的 disposalSafeLocaleOverride）与资源守卫
 * （资源管理服务只能在这里换掉：注入器构造时就被资源加载服务取走，internal-api 的 createResourceLoadGuard）。三者互不相干，
 * 都早于插件注册与 Facade 的订阅
 */
function createUniver(access: EditorAccess, resourceGuard: ReturnType<typeof createResourceLoadGuard>): Univer {
  return new Univer({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN },
    theme: defaultTheme,
    logLevel: LogLevel.WARN,
    // 核心注入器里换掉的三项：授权服务按打开方式回答（ADR-009）；语言服务销毁之后不抛错——SDK 有销毁之后才到点、还会调用它的计时器
    // （公式计算的进度），切换一律重建，旧的编辑器销毁之后到点就是一条没接住的页面异常（internal-api 的 disposalSafeLocaleOverride）；
    // 资源管理服务换成只观察的资源守卫（M3-P4 的打开自检，internal-api 的 createResourceLoadGuard）
    override: [...editorIdentityOverride(access), ...disposalSafeLocaleOverride(), ...resourceGuard.override],
  })
}

function createWorkbook(univerAPI: FUniver, snapshot: WorkbookSnapshot): ReturnType<FUniver['createWorkbook']> {
  let workbook: ReturnType<FUniver['createWorkbook']>
  try {
    workbook = univerAPI.createWorkbook(snapshot.data)
  }
  catch (error) {
    throw new SheetEditorLoadError('create-failed', '用快照创建工作簿时出错', { cause: error })
  }
  if (workbook.getId() !== snapshot.unitId)
    throw new SheetEditorLoadError('unit-mismatch', `创建出的工作簿 ${workbook.getId()} 与快照的 id ${snapshot.unitId} 不同`)
  return workbook
}

type Workbook = ReturnType<FUniver['createWorkbook']>

interface MountedEditor {
  readonly univer: Univer
  readonly univerAPI: FUniver
  readonly workbook: Workbook
  readonly changes: ChangeTracker
  readonly cellEditing: CellEditingWatch
  readonly lifecycle: LifecycleWatch
  readonly composition: CompositionWatch
  readonly panels: PanelDebounceWatch
  readonly openCheck: OpenCheck
  /** 公式在哪里计算（测试构建的探针报告它，页面自检据此核对选中的模式确实生效） */
  readonly formulaMode: FormulaMode
}

/** 公式由谁执行，以及就绪要等的那一方：Worker 模式等 Worker 回报装好了 IMAGE() 的限制，主线程模式没有 Worker、不用等 */
interface FormulaHost {
  readonly execution: FormulaExecution
  /** Worker 那边装好了 IMAGE() 的限制（主线程模式立即完成；主线程的那一份由生命周期的监听装，两种模式相同） */
  readonly ready: Promise<void>
  /** 就绪之后不再需要 Worker 回报的监听 */
  readonly settle: () => void
}

/** 按公式的模式准备执行公式的一方；创建的东西在 cleanup 里登记销毁 */
function createFormulaHost(mode: FormulaMode, cleanup: CleanupStack): FormulaHost {
  if (mode === 'main-thread')
    return { execution: { kind: 'main-thread' }, ready: Promise.resolve(), settle: () => {} }
  // 静态的 new Worker(new URL(...)) 才会被打包成同源的 Worker 脚本；传地址给插件会建出经典 Worker（rpc/src/plugin.ts:86）
  const worker = new Worker(new URL('./workers/formula.worker.ts', import.meta.url), { type: 'module', name: 'nerve-formula' })
  // 传入的 Worker 由我们终止（插件只终止它自己创建的，rpc/src/plugin.ts:71-78）
  cleanup.defer(() => worker.terminate())
  const imagePolicy = watchWorkerImagePolicy(worker)
  cleanup.defer(imagePolicy.dispose)
  return { execution: { kind: 'worker', worker }, ready: imagePolicy.installed, settle: imagePolicy.dispose }
}

/** 按顺序创建、等到就绪；每创建一样就在 cleanup 里登记它的销毁，失败时由调用方统一销毁 */
async function mount(options: CreateSheetEditorOptions, snapshot: WorkbookSnapshot, formulaMode: FormulaMode, cleanup: CleanupStack): Promise<MountedEditor> {
  // 测试构建：档案故障开关（M3-P4 设计 §3.14，testing/profile-fault.ts）。注册哪些插件必须在注册之前决定，所以在创建任何东西之前引入；
  // 生产构建里 MODE 是 production，这个分支与开关的分块都被去掉（门禁 artifacts 按来源核对）。只能动态引入（lint，与探针同一个理由）
  const pluginEntries = import.meta.env.MODE === 'e2e'
    ? (await import('./testing/profile-fault.ts')).sheetPluginEntriesUnderFault(location.search)
    : sheetPluginEntries
  const { container, access } = options
  const recalculate = options.recalculate === true
  container.setAttribute(EDITOR_ACCESS_ATTRIBUTE, access)
  cleanup.defer(() => container.removeAttribute(EDITOR_ACCESS_ATTRIBUTE))
  const formula = createFormulaHost(formulaMode, cleanup)

  // 资源守卫（打开自检，M3-P4 设计 §3.11 第 1 条）：一个编辑器一个，随 Univer 一起销毁（它就是 Univer 里的资源管理服务）
  const resourceGuard = createResourceLoadGuard()
  const univer = createUniver(access, resourceGuard)
  cleanup.defer(() => univer.dispose())
  for (const entry of pluginEntries({ container, formula: formula.execution, access, recalculate }))
    entry.register(univer)
  const univerAPI = FUniver.newAPI(univer)
  // 不变量（M2-P6 复核 F3）：Facade 的执行前事件（BeforeCommandExecute）在创建工作簿之前就要有订阅者，而且直到销毁都不能减到零。
  // - Facade 在第一个订阅者出现时才向命令服务注册它自己的执行前监听，最后一个订阅者退订时撤掉，再有订阅者时重新注册、排到最后
  //   （core 的 facade/f-event-registry.ts:66-104，1.0.1 的 lib/es/facade.js:965-1002；f-univer.ts:217-272）；
  //   命令服务按注册的先后调用执行前监听。
  // - 表格插件在 createWorkbook 里同步进入 Ready（core 的 univer.ts:208-229，第一次创建表格单元时启动表格的插件并进入 Ready），
  //   sheets-formula 的 UpdateFormulaController 这时注册自己的执行前监听：每条 SetRangeValuesMutation 执行之前，它先同步执行一条
  //   带 onlyLocal、fromFormula 的嵌套 mutation，把公式写进单元格（read-only/read-only-guard.ts 的第 1 条）。
  // - 只读的防火墙是 Facade 事件的订阅者：Facade 的监听排在 UpdateFormulaController 的前面，防火墙才能在嵌套的写入发生之前取消触发它的
  //   那条 mutation；排在后面时，写公式的 mutation 照样改掉单元格，而且它带 onlyLocal，变更检测也看不见。
  // 入口守卫最先订阅、销毁时才退订，Facade 的监听由它占住 SDK 之前的位置：只读守卫自己先装还是后装都不影响这一点。
  // 只读守卫只在创建编辑器时装上、随编辑器销毁：阅读与编辑之间的切换一律重建编辑器（M3-P2 设计 §3.1），运行中不装也不撤；
  // 将来要在运行中装上、撤下它，有入口守卫占着，订阅者也不会减到零。改动这里的顺序（例如把这些订阅挪到创建工作簿之后，
  // 或者入口守卫中途退订）都会破坏它：E2E read-only.spec.ts 的用例"经 Facade 直接执行写公式的 mutation"核对（被取消、单元格不变）
  const guards = installEntryGuards(univerAPI)
  cleanup.defer(() => guards.dispose())
  // 链接的改写（profile/link-policy.ts，M3-P3 设计 §3.6，DEF-021）：阅读与编辑都装，订阅在入口守卫之后，不改变上面的不变量
  // （入口守卫仍是第一个订阅者、直到销毁才退订；改写器随编辑器销毁，先于入口守卫退订）。在创建工作簿之前装上：
  // 打开过程中的写入（公式的初次计算写回的 HYPERLINK() 结果）同样经过它。它与只读的防火墙互不影响：Facade 先调完全部订阅者再看取消
  const links = installLinkPolicy(univerAPI)
  cleanup.defer(() => links.dispose())
  // 变更检测与只读的防火墙用同一份判定的配置：只读时，变更检测会认作修改的一律取消（M2-P3 设计 §3.3）
  const classifier: ChangeClassifierConfig = { unitId: snapshot.unitId, excludedMutationIds: CHANGE_DETECTION_EXCLUDED_MUTATIONS }
  const readOnly = access === 'read' ? installReadOnlyGuard(univer, univerAPI, classifier) : undefined
  if (readOnly !== undefined)
    cleanup.defer(readOnly.dispose)
  const changes = createChangeTracker(univer, univerAPI, classifier, { forcedRound: recalculate })
  cleanup.defer(changes.dispose)
  const cellEditing = watchCellEditing(univerAPI, snapshot.unitId, changes.onChange)
  cleanup.defer(cellEditing.dispose)
  const lifecycle = watchLifecycle({ univerAPI, installImagePolicy: async () => installRestrictedImageFunction(univer, location.origin) })
  cleanup.defer(lifecycle.dispose)
  // 组合输入与面板的防抖（M3-P4）：只看页面上的 DOM 事件，与 SDK 无关；随编辑器销毁
  const composition = watchComposition(container.ownerDocument, { ignoreWithin: options.pageUi })
  cleanup.defer(composition.dispose)
  const panels = watchPanelDebounces(container.ownerDocument, { ignoreWithin: options.pageUi })
  cleanup.defer(panels.dispose)

  // 打开自检的"之前"一侧（M3-P4 设计 §3.11 第 3 条）：SDK 会改动交给 createWorkbook 的对象，先把载入的快照里的资源取出一份
  const resourcesBefore = structuredClone(snapshot.data.resources)
  const workbook = createWorkbook(univerAPI, snapshot)
  // createWorkbook() 刚返回：表格的十个资源 hook 都已注册并加载完（6 个在 Starting 经 loadResources，4 个在 Ready 经晚注册），
  // 这时还没有渲染、没有公式的写回、也不可能有用户输入，资源比较最纯；只捕获资源（逐个 hook 的 toJson），与文档大小无关
  const created = checkCreated({
    profile: SHEET_PROFILE_ID,
    hookNames: resourceGuard.sheetHookNames(),
    loadFailures: resourceGuard.loadFailures(),
    resourcesBefore,
    captured: resourceGuard.captureSheetResources(snapshot.unitId),
  })
  // 工作表的权限点在创建工作簿时由 SDK 加入（初值允许），所以在这之后设
  readOnly?.applyWorksheetPoints()
  await withDeadline(
    Promise.all([lifecycle.rendered, lifecycle.imagePolicyInstalled, formula.ready]),
    READY_TIMEOUT_MS,
    () => new SheetEditorLoadError('ready-timeout', `${READY_TIMEOUT_MS / 1000} 秒内没有全部就绪（渲染、主线程与 Worker 的 IMAGE() 限制）`),
  )
  // 就绪之后不再需要 Worker 回报的监听：Worker 之后出错按 M4 的设计处理（M1 里公式收齐会超时，页面提示公式结果尚未保存）
  formula.settle()
  readOnly?.applyRenderedGuards()
  readOnly?.clearUndoStack()
  // 就绪之后再核对一次 hook 集合与这之前记下的加载问题：防 SDK 把注册挪到更晚（1.0.1 里两次的 hook 集合相同）
  const openCheck = recheckReady(created, { profile: SHEET_PROFILE_ID, hookNames: resourceGuard.sheetHookNames(), loadFailures: resourceGuard.loadFailures() })
  return { univer, univerAPI, workbook, changes, cellEditing, lifecycle, composition, panels, openCheck, formulaMode }
}

/**
 * 公式在哪里计算：生产构建只有 Worker 模式。测试构建里地址参数可以选主线程模式（testing/formula-mode.ts，M3-P4 设计 §3.14，
 * US-M3-03 的两种模式）：生产构建里 MODE 是 production，这个分支与开关的分块都被去掉（门禁 artifacts 按模块来源核对）
 */
async function formulaModeOf(): Promise<FormulaMode> {
  if (import.meta.env.MODE === 'e2e') {
    const { formulaModeFromSearch } = await import('./testing/formula-mode.ts')
    return formulaModeFromSearch(window.location.search)
  }
  return 'worker'
}

export async function createSheetEditor(options: CreateSheetEditorOptions): Promise<SheetEditor> {
  const snapshot = parseWorkbookSnapshot(options.snapshot)
  // 在开始挂载之前定下（测试构建里要等开关的分块载入）：挂载的同步部分不被拆开，测试构建的切换计时照旧（switch-timing.ts 的 sync-end）。
  // 生产构建里不等：这个表达式只剩 'worker'
  const formulaMode = import.meta.env.MODE === 'e2e' ? await formulaModeOf() : 'worker'
  const cleanup = createCleanupStack()
  let mounted: MountedEditor
  try {
    mounted = await mount(options, snapshot, formulaMode, cleanup)
    // 重建之前的视图状态：就绪之后恢复（出错时 restoreViewState 报告、停在默认视图，不让创建失败）
    if (options.viewState !== undefined)
      restoreViewState(mounted.workbook, options.viewState)
    // 测试构建：就绪之后装上 E2E 的探针（M2-P3 设计 §3.7）。生产构建里 MODE 是 production，这个分支与探针的分块都被去掉，
    // 门禁 artifacts 核对生产产物里没有它。只能这样动态引入：静态引入时探针本身被摇树去掉，它补上的 Facade（probe-facades.ts）
    // 却留在生产构建里，门禁认不出（lint 拦下，M2-P6 复核 F5）
    if (import.meta.env.MODE === 'e2e') {
      const { installEditorProbe } = await import('./testing/e2e-probe.ts')
      cleanup.defer(installEditorProbe(mounted))
    }
  }
  catch (error) {
    cleanup.run()
    throw error
  }
  const { workbook, changes, cellEditing, lifecycle, composition, panels, openCheck } = mounted

  let disposed = false
  const dispose = (): void => {
    if (disposed)
      return
    disposed = true
    cleanup.run()
  }

  const usable = (): void => {
    if (disposed)
      throw new Error('表格编辑器已经销毁')
  }

  return {
    unitId: snapshot.unitId,
    changeSeq: changes.changeSeq,
    onChange: changes.onChange,
    // 就绪时一定已经渲染完成
    lifecycle: () => lifecycle.current() ?? 'rendered',
    onLifecycle: lifecycle.onChange,
    isCellEditing: () => !disposed && workbook.isCellEditing(),
    hasPendingCellInput: () => !disposed && cellEditing.hasPendingInput(),
    onCellEditingChange: cellEditing.onChange,
    async commitCellEditing() {
      usable()
      if (!workbook.isCellEditing())
        return true
      // 与按回车相同：SetCellEditVisibleOperation（keycode 为 ENTER）之后再等一个宏任务（sheets-ui 的 f-workbook.ts:265-281）
      await workbook.endEditingAsync(true)
      if (workbook.isCellEditing())
        return false
      // 跨工作表的提交在 SDK 里先切表（4 毫秒的定时器）再写入，一个宏任务不够：等单元格编辑的跟踪认出这次的写入，
      // 保存的捕获里才有这次的提交（第二轮复验）
      await cellEditing.settled()
      return true
    },
    async settleFormulas(timeoutMs) {
      usable()
      const settled = await pollUntil(changes.formulasSettled, { timeoutMs, intervalMs: SETTLE_POLL_INTERVAL_MS })
      return settled ? 'settled' : 'timeout'
    },
    formulasSettled: () => !disposed && changes.formulasSettled(),
    onFormulaProgress: changes.onFormulaProgress,
    composing: () => !disposed && composition.composing(),
    onCompositionChange: composition.onChange,
    settlePanels: async () => panels.settled(),
    capture() {
      usable()
      return JSON.stringify(workbook.save())
    },
    viewState: () => disposed ? undefined : readViewState(workbook),
    openCheck,
    dispose,
  }
}

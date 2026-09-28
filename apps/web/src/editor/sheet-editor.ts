// 表格编辑器（P4 设计 §3.6.1、§3.6.3）：这份快照在 Univer 里怎么编辑、怎么捕获。请求、保存状态与界面由编辑器页负责。
// 一页一份文档、整页加载与卸载（计划书 §10.2）：同一个实例里不能创建两份 unitId 相同的文档，反复创建销毁也会泄漏内存。
// 顺序：
// 1. 创建公式 Worker（模块 Worker），先挂上它的回报与错误的监听；
// 2. new Univer（身份替换），按档案注册插件；FUniver.newAPI；
// 3. 在创建工作簿之前挂上入口守卫、变更检测、单元格编辑与生命周期的监听，加载过程中的命令也看得到；
// 4. createWorkbook，核对 unitId，立即设为不能编辑：就绪之前不允许编辑（M1 总设计 §6.6，Codex 评审 CX1）；
// 5. 等渲染完成（Rendered）、主线程到 Ready 后装上 IMAGE() 的限制、Worker 回报它那边也装上了，才返回；
//    任何一步失败（包括创建 Univer、注册插件）都按相反的顺序销毁已经创建的一切并抛出，页面显示"编辑器加载失败"（审查 B8）。
// 返回时仍不能编辑：页面接好保存与离开提示之后，按权限调用 setEditable(true)。在那之前页面上的输入无处保存，
// 加载超时销毁编辑器时也会随之丢失（Codex 评审 CX1）。
import type { CellEditingWatch } from './cell-editing-watch.ts'
import type { ChangeTracker } from './change-tracking/change-tracker.ts'
import type { CleanupStack } from './cleanup-stack.ts'
import type { LifecycleWatch, SheetEditorLifecycle } from './lifecycle-watch.ts'
import type { WorkbookSnapshot } from './workbook-snapshot.ts'
import { LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { defaultTheme } from '@univerjs/themes'
import { pollUntil, withDeadline } from './async-tools.ts'
import { watchCellEditing } from './cell-editing-watch.ts'
import { createChangeTracker } from './change-tracking/change-tracker.ts'
import { createCleanupStack } from './cleanup-stack.ts'
import { editorIdentityOverride } from './identity/allow-all-authz-io.service.ts'
import { installRestrictedImageFunction } from './image-function/install-image-policy.ts'
import { watchWorkerImagePolicy } from './image-function/worker-image-policy.ts'
import { watchLifecycle } from './lifecycle-watch.ts'
import { installEntryGuards } from './profile/entry-guards.ts'
import { SHEET_ZH_CN } from './profile/locale.ts'
import { CHANGE_DETECTION_EXCLUDED_MUTATIONS, sheetPluginEntries } from './profile/sheet-profile.ts'
import { SheetEditorLoadError } from './sheet-editor-error.ts'
import { parseWorkbookSnapshot } from './workbook-snapshot.ts'
// Facade 只引用用到的部分（包体积）：createWorkbook、save、setEditable 在 sheets，编辑中的单元格在 sheets-ui
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
   * 提交正在编辑的单元格（等同回车，选区随之下移）；提交之后仍在编辑时返回 false。
   * 数据验证拒绝输入时，SDK 先关掉编辑器、写入后回滚并弹出它自己的提示：返回 true，快照里是回滚后的内容，与界面一致
   */
  readonly commitCellEditing: () => Promise<boolean>
  /** 等公式收齐（P4 设计 §3.6.6），最多等 timeoutMs */
  readonly settleFormulas: (timeoutMs: number) => Promise<'settled' | 'timeout'>
  /** 捕获：JSON.stringify(save())；捕获前不调用 Facade 的读取方法（它们可能改动模型） */
  readonly capture: () => string
  /** 创建出来时不能编辑（见文件开头），页面按权限放开 */
  readonly setEditable: (editable: boolean) => void
  /** 销毁实例、终止 Worker；可以重复调用 */
  readonly dispose: () => void
}

export interface CreateSheetEditorOptions {
  /** 编辑器挂载的容器 */
  readonly container: HTMLElement
  /** 快照的 JSON 文本（服务端下发的原文） */
  readonly snapshot: string
}

/** 就绪的时限：Worker 20 秒没有回报 IMAGE() 的安装结果就失败（P4 设计 §3.6.7）；渲染与主线程的安装在同一个时限内 */
const READY_TIMEOUT_MS = 20_000

/** 公式收齐每 20 ms 判断一次（P4 设计 §3.6.6） */
const SETTLE_POLL_INTERVAL_MS = 20

function createUniver(): Univer {
  return new Univer({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN },
    theme: defaultTheme,
    logLevel: LogLevel.WARN,
    override: editorIdentityOverride(),
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
  readonly workbook: Workbook
  readonly changes: ChangeTracker
  readonly cellEditing: CellEditingWatch
  readonly lifecycle: LifecycleWatch
}

/** 按顺序创建、等到就绪；每创建一样就在 cleanup 里登记它的销毁，失败时由调用方统一销毁 */
async function mount(container: HTMLElement, snapshot: WorkbookSnapshot, cleanup: CleanupStack): Promise<MountedEditor> {
  // 静态的 new Worker(new URL(...)) 才会被打包成同源的 Worker 脚本；传地址给插件会建出经典 Worker（rpc/src/plugin.ts:86）
  const worker = new Worker(new URL('./workers/formula.worker.ts', import.meta.url), { type: 'module', name: 'nerve-formula' })
  // 传入的 Worker 由我们终止（插件只终止它自己创建的，rpc/src/plugin.ts:71-78）
  cleanup.defer(() => worker.terminate())
  const workerImagePolicy = watchWorkerImagePolicy(worker)
  cleanup.defer(workerImagePolicy.dispose)

  const univer = createUniver()
  cleanup.defer(() => univer.dispose())
  for (const entry of sheetPluginEntries({ container, formulaWorker: worker }))
    entry.register(univer)
  const univerAPI = FUniver.newAPI(univer)
  const guards = installEntryGuards(univerAPI)
  cleanup.defer(() => guards.dispose())
  const changes = createChangeTracker(univer, univerAPI, { unitId: snapshot.unitId, excludedMutationIds: CHANGE_DETECTION_EXCLUDED_MUTATIONS })
  cleanup.defer(changes.dispose)
  const cellEditing = watchCellEditing(univerAPI, snapshot.unitId)
  cleanup.defer(cellEditing.dispose)
  const lifecycle = watchLifecycle({ univerAPI, installImagePolicy: async () => installRestrictedImageFunction(univer, location.origin) })
  cleanup.defer(lifecycle.dispose)

  const workbook = createWorkbook(univerAPI, snapshot)
  // 渲染之前就设好：用户还碰不到它（Codex 评审 CX1）
  workbook.setEditable(false)
  await withDeadline(
    Promise.all([lifecycle.rendered, lifecycle.imagePolicyInstalled, workerImagePolicy.installed]),
    READY_TIMEOUT_MS,
    () => new SheetEditorLoadError('ready-timeout', `${READY_TIMEOUT_MS / 1000} 秒内没有全部就绪（渲染、主线程与 Worker 的 IMAGE() 限制）`),
  )
  // 就绪之后不再需要 Worker 回报的监听：Worker 之后出错按 M4 的设计处理（M1 里公式收齐会超时，页面提示公式结果尚未保存）
  workerImagePolicy.dispose()
  return { workbook, changes, cellEditing, lifecycle }
}

export async function createSheetEditor(options: CreateSheetEditorOptions): Promise<SheetEditor> {
  const snapshot = parseWorkbookSnapshot(options.snapshot)
  const cleanup = createCleanupStack()
  let mounted: MountedEditor
  try {
    mounted = await mount(options.container, snapshot, cleanup)
  }
  catch (error) {
    cleanup.run()
    throw error
  }
  const { workbook, changes, cellEditing, lifecycle } = mounted

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
      return !workbook.isCellEditing()
    },
    async settleFormulas(timeoutMs) {
      usable()
      const settled = await pollUntil(changes.formulasSettled, { timeoutMs, intervalMs: SETTLE_POLL_INTERVAL_MS })
      return settled ? 'settled' : 'timeout'
    },
    capture() {
      usable()
      return JSON.stringify(workbook.save())
    },
    setEditable(editable) {
      usable()
      workbook.setEditable(editable)
    },
    dispose,
  }
}

// 内部 API 登记表（P4 设计 §3.6.9，ADR-010，规范 §2.5"内部 API 集中封装并登记，每一项都有回归用例"）。
// internal-api/index.ts 导出的每一项在这里登记一次：来自哪里、做什么用、M0 的证据、升级 SDK 时先跑的回归用例。
// 单元测试核对导出与登记一一对应（registry.test.ts）；新增一项时，先写回归用例，再登记
export interface InternalApiEntry {
  /** internal-api/index.ts 导出的名字 */
  readonly name: string
  /** 来自哪个包、是什么（SDK 的符号，或平台对 SDK 内部约定的封装） */
  readonly origin: string
  readonly purpose: string
  /** M0 与 P4 探针的证据（报告的章节、源码的位置） */
  readonly evidence: string
  /** 回归用例：单元测试与 E2E（S4），升级 SDK 时先跑 */
  readonly regression: string
}

const FORMULA_SETTLE_REGRESSION = '单元测试 change-tracking/formula-settle-tracker.test.ts（P4 探针录制的命令序列）、calculation-trigger.test.ts；E2E tests/e2e/specs/editor/save.spec.ts"改了公式的依赖立即保存""跨表引用""计算进行中又改了一处"：服务器上的缓存值与按定义算出的一致'
const IMAGE_POLICY_REGRESSION = '单元测试 image-function/restricted-image-function.test.ts、install-image-policy.test.ts；E2E（S4）"外链的 IMAGE() 显示 #VALUE!、没有 CSP 违规"，以及编辑器能就绪（主线程与 Worker 都装上才就绪）'
/** 查看者的只读加固（M2-P3）：只读守卫与授权服务共用的回归 */
const READ_ONLY_E2E = 'E2E tests/e2e/specs/editor/read-only.spec.ts（M2-P3 S3，US-M2-11）：查看者打开样本，M0 的 28 个表格编辑入口逐项无效（本机三个浏览器，公式在 Worker 里），同一批入口在能编辑时确实改动；还能切换工作表、选中、复制、查找；进入只读不产生 mutation、不写保护类资源'
const READ_ONLY_GUARD_REGRESSION = `单元测试 read-only/read-only-guard.test.ts；${READ_ONLY_E2E}`
/** M0 的只读（阅读模式）验证：本地权限点加 mutation 防火墙 */
const M0_READ_MODE_EVIDENCE = 'M0-P3 报告 §5（V09：本地权限点加 mutation 防火墙，表格 28 个入口在三个浏览器、含公式 Worker 模式全部拦住；只靠权限点漏掉 9 个）、§7（内部 API 登记）；M0 的 harness/read-mode.ts'

export const INTERNAL_API_REGISTRY: readonly InternalApiEntry[] = [
  {
    name: 'injectorOf',
    origin: '@univerjs/core 的 Univer.__getInjector()（平台的封装）',
    purpose: '取 Facade 没有暴露的服务：IFunctionService、IActiveDirtyManagerService，Worker 里的 LifecycleService，以及只读守卫的 IPermissionService、IUndoRedoService、IDrawingManagerService',
    evidence: 'M0-P3 报告 §7"取服务"；M0 的 create-editor.ts 经它取各项内部服务；P4 探针 (a)–(f) 全程使用',
    regression: 'E2E（S4）编辑器能打开并就绪：任何一处取服务失败都会按加载失败处理；单元测试 install-image-policy.test.ts、calculation-trigger.test.ts 核对取的是哪项服务',
  },
  {
    name: 'FORMULA_PROTOCOL',
    origin: '@univerjs/engine-formula 的 SetFormulaCalculationStart/Stop/Result/NotificationMutation、SetTriggerFormulaCalculationStartMutation、FormulaExecutedStateType，@univerjs/sheets 的 SetRangeValuesMutation；执行选项 applyFormulaCalculationResult 与通知参数 functionsExecutedState（SDK 里的字面量）',
    purpose: '公式收齐（P4 设计 §3.6.6）：认出一轮计算的开始、停止、结果、逐表写回与完成',
    evidence: 'M0-P3 报告 §3.3、§3.4、§7；engine-formula 的 calculate.controller.ts:232-257、formula-calculation-trigger.service.ts:166-176，sheets 的 calculate-result-apply.controller.ts:90-97；M0 的 e2e/v07-formula、v07-worker-timeline；P4 探针 (f) 在三个浏览器上录制的序列',
    regression: FORMULA_SETTLE_REGRESSION,
  },
  {
    name: 'IAuthzIoService',
    origin: '@univerjs/core 的授权服务标识与接口（Facade 之外）',
    purpose: '编辑器身份（ADR-009，M2-P3 设计 §3.2）：new Univer({ override }) 换成按打开方式回答的实现（能编辑时全部允许，只读时只允许查看与复制）；依赖的约定是 allowed 的结果设置工作簿的权限点（每个动作要有明确的布尔值）、batchAllowed 的返回形状、create 只由（已隐藏的）保护入口调用',
    evidence: 'P4 研究摘要 §4.8 的源码核实（core 的 univer.ts:295、authz-io-local.service.ts:65-118，sheets 的 sheet-permission-init.controller.ts:171-191、333-385：Ready 与用户变化时按 allowed 的结果设置工作簿的 22 个权限点）；P4 探针 (a)：替换前后打开、编辑、增删工作表、筛选、排序、条件格式、数据验证、备注、查找替换的结果相同，40 个权限点都允许，快照没有 SHEET_AuthzIoMockService_PLUGIN',
    regression: `单元测试 identity/editor-authz-io.service.test.ts；E2E tests/e2e/specs/editor/features.spec.ts（增删工作表、排序与筛选、条件格式与数据验证、批注与查找替换，经界面操作、按服务器上的快照核对），template.spec.ts（新建文档的快照与模板逐字节相同，资源里没有 SHEET_AuthzIoMockService_PLUGIN）；只读时：${READ_ONLY_E2E}`,
  },
  {
    name: 'IPermissionService',
    origin: '@univerjs/core 的本地权限点服务（Facade 之外）',
    purpose: '只读守卫（M2-P3 设计 §3.3）：把每张工作表"查看""复制"之外的权限点设为不允许（不存在的先 addPermissionPoint，再 updatePermissionPoint），不创建保护规则；依赖的约定是没有保护规则的工作表不会被 SDK 改回去，用户变化时 SDK 沿用原来的值',
    evidence: `${M0_READ_MODE_EVIDENCE}（read-mode.ts:105-113）；core 的 services/permission/type.ts:53-70、permission.service.ts:48-75（重复加入打出警告；更新改的是同一个对象）、univer.ts:286；sheets 的 worksheet-permission.service.ts:50-60（创建工作簿时为每张表加入权限点，初值允许）、sheet-permission-init.controller.ts:263-331、333-385（只在有保护规则时经授权服务设置；用户变化时重新加入原来的权限点）`,
    regression: READ_ONLY_GUARD_REGRESSION,
  },
  {
    name: 'IUndoRedoService',
    origin: '@univerjs/core 的撤销栈服务（Facade 之外）',
    purpose: '只读守卫：就绪时 clearUndoRedo(unitId) 清空这份文档的撤销栈（以只读创建时本来就空，是给 M3 的原地切换用的同一个入口）；撤销与重做本身经 Facade 的 BeforeUndo、BeforeRedo 取消',
    evidence: `${M0_READ_MODE_EVIDENCE}（read-mode.ts:76-84、141-144：四种方案都拦住撤销重做、清空撤销栈，不清空时按快捷键撤销、重做内容也不变）；core 的 services/undoredo/undoredo.service.ts:44-104（clearUndoRedo 按单元清空）、univer.ts:290`,
    regression: `${READ_ONLY_GUARD_REGRESSION}（撤销与重做无效）`,
  },
  {
    name: 'getAllWorksheetPermissionPoint',
    origin: '@univerjs/sheets 导出的工作表权限点清单之一（编辑、查看、管理协作者、删除保护，Facade 之外）',
    purpose: '只读守卫：与 getAllWorksheetPermissionPointByPointPanel 合起来去重，去掉查看与复制，得到只读时关掉的工作表权限点（1.0.x 共 16 个）',
    evidence: `${M0_READ_MODE_EVIDENCE}（read-mode.ts:42-49）；sheets 的 services/permission/worksheet-permission/utils.ts:20-43（两份清单共 18 个，SDK 加入与重设权限点时用的也是它们）`,
    regression: READ_ONLY_GUARD_REGRESSION,
  },
  {
    name: 'getAllWorksheetPermissionPointByPointPanel',
    origin: '@univerjs/sheets 导出的工作表权限点清单之二（保护面板里的 14 项：复制、增删行列、筛选、排序、设置样式与值……，Facade 之外）',
    purpose: '同 getAllWorksheetPermissionPoint',
    evidence: '同 getAllWorksheetPermissionPoint',
    regression: READ_ONLY_GUARD_REGRESSION,
  },
  {
    name: 'WorksheetViewPermission',
    origin: '@univerjs/sheets 的工作表"查看"权限点类（Facade 之外）',
    purpose: '只读守卫保留的工作表权限点：查看是打开的前提',
    evidence: `${M0_READ_MODE_EVIDENCE}（保留"查看"与"复制"）；插件档案 v1 §5.2；sheets 的 services/permission/permission-point/worksheet/view.ts`,
    regression: READ_ONLY_GUARD_REGRESSION,
  },
  {
    name: 'WorksheetCopyPermission',
    origin: '@univerjs/sheets 的工作表"复制"权限点类（Facade 之外）',
    purpose: '只读守卫保留的工作表权限点：只读时可以选中与复制内容（US-M2-11）',
    evidence: `${M0_READ_MODE_EVIDENCE}；M0-P3 审查 R6：复制要求工作簿与工作表的复制权限点都为真（sheets-ui 的 commands/commands/clipboard.command.ts:155-161）；FWorksheetPermission.setReadOnly() 连它也关掉（报告 §5.3）`,
    regression: `${READ_ONLY_GUARD_REGRESSION}（复制可用）`,
  },
  {
    name: 'WorkbookViewPermission',
    origin: '@univerjs/sheets 的工作簿"查看"权限点类（Facade 之外）',
    purpose: '编辑器身份：只读时授权服务允许的动作取它的 subType（UnitAction.View），不为 UnitAction 新增 @univerjs/protocol 依赖；与只读守卫保留的工作表权限点是同一组定义',
    evidence: 'sheets 的 services/permission/permission-point/workbook/view.ts（subType 为 UnitAction.View）、workbook-permission/util.ts:21-69（Ready 时按 allowed 设置的 22 个工作簿权限点与动作）；M0-P3 报告 §5、插件档案 v1 §5.2（只读时保留查看与复制）',
    regression: `单元测试 identity/editor-authz-io.service.test.ts（只读时只允许查看与复制，取值与 UnitAction 一致）；${READ_ONLY_E2E}`,
  },
  {
    name: 'WorkbookCopyPermission',
    origin: '@univerjs/sheets 的工作簿"复制"权限点类（Facade 之外）',
    purpose: '编辑器身份：只读时授权服务允许的动作取它的 subType（UnitAction.Copy）：复制要求工作簿与工作表的复制权限点都为真',
    evidence: 'sheets 的 services/permission/permission-point/workbook/copy.ts（subType 为 UnitAction.Copy）；M0-P3 审查 R6（sheets-ui 的 commands/commands/clipboard.command.ts:155-161）',
    regression: `单元测试 identity/editor-authz-io.service.test.ts；${READ_ONLY_E2E}（复制可用）`,
  },
  {
    name: 'IDrawingManagerService',
    origin: '@univerjs/drawing 的图片管理服务（Facade 之外；与 @univerjs/sheets-drawing 的 ISheetDrawingService 是两个实例）',
    purpose: '只读守卫（M2-P3 S3 的 E2E 发现之后）：applyWorksheetPoints 同一步里 setDrawingEditable(false)，之后画出来的浮动图片不挂变换框，点不中、拖不动',
    evidence: [
      'M2-P3 S3 的 E2E：只读时浮动图片照样能选中，拖动被权限检查拦下之后图片停在拖到的位置（模型没变，换表后复原）。',
      '根因：drawing-ui 画图片时按这个服务的 getDrawingEditable() 决定是否挂变换框（services/drawing-render.service.ts:193-196，1.0.1 的 lib/es/index.js:857、915），它的初值是 true、没有别处改它；',
      'sheets-drawing-ui 的 sheet-drawing-permission.controller.ts 按工作簿与工作表的"编辑"权限点只设 ISheetDrawingService 的同名标志（:150-193、312-433，渲染不读它），另外只对当时已经画出的对象摘掉变换框，',
      '切到有图片的表时图片是之后才画的，照样挂上变换框。修复时实测：只设 ISheetDrawingService 的标志，三个浏览器上图片照样能选中、拖动；设这个服务的标志之后点不中、拖不动，能编辑时不受影响',
    ].join(''),
    regression: `单元测试 read-only/read-only-guard.test.ts（applyWorksheetPoints 之后图片不可编辑）；${READ_ONLY_E2E}（拖动与删除浮动图片：图片没有被选中，位置不变，快照不变；能编辑时的对照照常改动）`,
  },
  {
    name: 'NOTE_TEXTAREA_SELECTOR',
    origin: 'sheets-note-ui 的批注浮层给文本框的 DOM 标记 data-u-comp="note-textarea"（views/Note.tsx:156-158；design 的 Textarea 把它放在 <textarea> 上，1.0.1 的 lib/es/index.js:691）；平台对这个约定的封装',
    purpose: '只读守卫（read-only/note-popup.ts）：在页面上观察批注浮层出现，把文本框设为只读',
    evidence: 'M2-P3 S3 的 E2E：批注浮层总是可以输入的文本框（Note.tsx 没有只读的开关，打开时还会被程序聚焦，:98-106），只读时键入之后写回批注的 mutation 被防火墙取消、界面复原；修复时实测：设为只读之后键入不改内容，文字照常显示',
    regression: `单元测试 read-only/note-popup.test.ts；${READ_ONLY_E2E}（悬停看到批注，文本框只读，键入之后内容不变）`,
  },
  {
    name: 'FORMULA_BAR_INPUT_SELECTOR',
    origin: 'sheets-ui 编辑栏的 DOM 标记：根元素 data-u-comp="formula-bar"、编辑框 formula-editor、左边的按钮 formula-bar-actions（views/formula-bar/FormulaBar.tsx:298-402）；平台对这个约定的封装',
    purpose: '只读守卫（read-only/formula-bar.ts）：在页面上拦下落在编辑框与按钮上的指针事件，编辑栏点不进去',
    evidence: [
      'M2-P3 S3 的 E2E：只读时点过编辑栏，查找的快捷键失效、格式的快捷键转给文字编辑器。',
      '根因：工作簿不可编辑、又没有保护规则时，FormulaBar.tsx:252-262 只聚焦编辑栏的内部编辑器，FOCUSING_FX_BAR_EDITOR 与 EDITOR_ACTIVATED（docs-ui 的 editor-manager.service.ts:197-225）置为真，',
      '复位它们的 _exitInput（editing.render-controller.ts:870-874）只在单元格编辑器关闭时执行，只读时走不到。',
      '修复时实测：sheets-ui 的 disableEdit 不行（单元格编辑器不渲染，复制与方向键失效；编辑框外层写着 pointer-events: auto，FormulaBar.tsx:374，照样点得进去）；拦下指针事件之后点编辑栏不再聚焦，查找、复制照常',
    ].join(''),
    regression: `单元测试 read-only/formula-bar.test.ts；${READ_ONLY_E2E}（编辑栏点不进去；点过编辑栏、在单元格上键入之后查找与复制照常）`,
  },
  {
    name: 'LifecycleService',
    origin: '@univerjs/core 的生命周期服务',
    purpose: 'Worker 里没有 Facade：等生命周期到 Ready（主线程在 Worker 里创建工作簿副本之后）再装 IMAGE() 的限制并回报',
    evidence: 'core 的 univer.ts:202-238（第一次创建单元时进入 Ready）；M0 的 image-function-policy.ts:63-70；P4 探针 (d)：三个浏览器上 Worker 都回报安装成功，编辑器约 0.5 秒就绪',
    regression: 'E2E（S4）编辑器能就绪（收不到 Worker 的回报就按加载失败处理）、外链的 IMAGE() 显示 #VALUE!',
  },
  {
    name: 'BaseFunction',
    origin: '@univerjs/engine-formula 的公式函数基类',
    purpose: 'IMAGE() 的 restricted 包装继承它（插件档案 v1 §6.2）',
    evidence: 'M0-P4 报告 §3.2、§4；engine-formula 的 functions/lookup/image/index.ts（原执行器不读实例状态）；P4 探针 (d)',
    regression: IMAGE_POLICY_REGRESSION,
  },
  {
    name: 'BaseValueObject',
    origin: '@univerjs/engine-formula 的值对象基类（只用类型）',
    purpose: 'IMAGE() 包装的参数与返回值的类型',
    evidence: '同 BaseFunction；引用在计算时变成数组（engine-formula 的 function-node.ts:166-168），包装据此拒绝引用、区域与数组常量',
    regression: IMAGE_POLICY_REGRESSION,
  },
  {
    name: 'ErrorType',
    origin: '@univerjs/engine-formula 的错误类型枚举',
    purpose: 'IMAGE() 的包装对非平台地址返回 #VALUE!',
    evidence: 'M0-P4 报告 §3.2（restricted：外链与 data URL 显示 #VALUE!）；P4 探针 (d)',
    regression: IMAGE_POLICY_REGRESSION,
  },
  {
    name: 'ErrorValueObject',
    origin: '@univerjs/engine-formula 的错误值对象',
    purpose: 'IMAGE() 的包装构造 #VALUE! 的结果',
    evidence: '同 ErrorType',
    regression: IMAGE_POLICY_REGRESSION,
  },
  {
    name: 'IFunctionService',
    origin: '@univerjs/engine-formula 的函数服务',
    purpose: '取出原来的 IMAGE 执行器、注册同名的包装、清掉 IMAGE 的公式缓存，再核对生效的是包装',
    evidence: 'M0-P4 报告 §3.2、§4；engine-formula 的 function.service.ts:74-79（后注册的覆盖先注册的）、formula.controller.ts:135-147（内置函数在引擎插件 onReady 时注册）',
    regression: IMAGE_POLICY_REGRESSION,
  },
  {
    name: 'IActiveDirtyManagerService',
    origin: '@univerjs/engine-formula 的脏区转换服务',
    purpose: '公式收齐的"排队"判断：命令登记了脏区转换、shouldTrigger 没有排除它、脏区非空，SDK 就会开始（或排队）新的一轮',
    evidence: 'M0-P3 报告 §3.4 第 2 条、§7；engine-formula 的 formula-calculation-trigger.service.ts:85-130、265-274；P4 探针 (f)："计算进行中再改一次"时第一轮完成后仍判为排队，第二轮写回后才收齐，值与重算一致',
    regression: FORMULA_SETTLE_REGRESSION,
  },
]

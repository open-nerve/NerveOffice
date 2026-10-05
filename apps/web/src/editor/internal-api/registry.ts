// 内部 API 登记表（P4 设计 §3.6.9，ADR-010，规范 §2.5"内部 API 集中封装并登记，每一项都有回归用例"）。
// internal-api 的两个出口（index.ts 与界面的 ui.ts）导出的每一项在这里登记一次：来自哪里、做什么用、M0 的证据、升级 SDK 时先跑的回归用例。
// internal-api 之外只能经这两个出口引用（lint 的 nerve/editor-internal-api-exits，M2-P6 复验 N4）。
// 单元测试（registry.test.ts）核对导出与登记一一对应，并扫描 internal-api 下的全部文件（测试与测试辅助除外；扫描的清单与目录里的文件
// 一一对应，由 tools/src/lint/internal-api-sources.test.ts 递归列出目录核对）对 @univerjs/* 的引用：出口直接再导出的就是登记的那一项，
// 封装的一项（例如 FORMULA_PROTOCOL）用到的 SDK 符号列在它的 sdk 里，没列出的报出来。文件之间只认 ./<文件名> 的静态导入导出：
// 子目录与 ../ 绕路报为认不出的写法，动态 import() 由 lint 禁止（nerve/editor-internal-api）。新增一项时，先写回归用例，再登记
export interface InternalApiEntry {
  /** internal-api/index.ts 或 ui.ts 导出的名字 */
  readonly name: string
  /** 来自哪个包、是什么（SDK 的符号，或平台对 SDK 内部约定的封装） */
  readonly origin: string
  /**
   * 封装的一项引用的 SDK 符号：包名 → 导入名（值与类型都算）。实现这一项的文件（出口从它再导出这一项，以及它引用的同目录文件）
   * 对 Univer 的包的每一处引用都要列在这里，列出的每一个也都要还在用（registry.test.ts 扫描核对）。出口直接再导出 SDK 符号的一项不写
   */
  readonly sdk?: Readonly<Record<string, readonly string[]>>
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
/** 编辑栏的编辑器被聚焦就放开（P3 审查 A1）：单元测试与 E2E */
const FORMULA_BAR_RELEASE_REGRESSION = '单元测试 read-only/formula-bar.test.ts（焦点落到编辑栏的编辑器时放开、别的编辑器不管）、read-only-guard.test.ts；E2E tests/e2e/specs/editor/read-only.spec.ts"编辑栏点不进去"（点编辑框、从名称框按下在编辑框上松开之后，查找与方向键照常，编辑栏没有收到输入；本机三个浏览器）'
/** 只读的快捷键回归（M2-P6 复核 F1、F2 之后）：E2E 的探针经它们列出快捷键、读编辑栏 */
const READ_ONLY_SHORTCUTS_E2E = [
  'E2E tests/e2e/specs/editor/read-only-shortcuts.spec.ts：只读时在三种选区（空单元格、整行、整列）下逐个按遍 SDK 注册的全部快捷键（按页面的平台取修饰键），',
  '每按一个都核对确实按到了 SDK（浏览器收到的按键换算成这个组合、目标在编辑器的容器里，没有前提条件的一定派发，守卫取消的都被取消；',
  '扫完之后再按一次一定派发的组合作哨兵）、内容不变、没有保存请求与页面错误、',
  '编辑栏显示的与当前单元格一致、没有弹出编辑类的面板（本机三个浏览器）；取不到快捷键的清单或读不出编辑栏时失败（开头另有读编辑栏的自检）',
].join('')
/** 冻结线拖不动（P3 审查 B2）：单元测试与 E2E */
const FREEZE_LOCK_REGRESSION = '单元测试 read-only/freeze-handles.test.ts、read-only-guard.test.ts；E2E tests/e2e/specs/editor/read-only.spec.ts"拖动冻结线"（只读时光标不是可拖动的 grab、没有 set-frozen、冻结不变；能编辑时的对照冻结确实改变）'
/** 第 1 行、A 列的分隔线拖不动（DEF-027，M3-P2 S3）：单元测试与 E2E */
const HEADER_RESIZE_LOCK_REGRESSION = '单元测试 read-only/header-resize.test.ts（复现 SDK 的写法：索引 0 放行；装上之后一律不放行）、read-only-guard.test.ts；E2E tests/e2e/specs/editor/read-only.spec.ts"拖动第 1 行与 A 列的分隔线"（没有冻结的表：只读时光标不是 row-resize、col-resize，没有 delta-row-height、delta-column-width 的尝试；能编辑时的对照确实改变行高、列宽）与"拖动冻结区域的行高"'
/** 查找面板里没有"替换 / 高级查找"（DEF-028，M3-P2 S3）：单元测试与 E2E */
const ADVANCED_FIND_REGRESSION = '单元测试 read-only/advanced-find.test.ts、read-only-guard.test.ts；E2E tests/e2e/specs/editor/read-only.spec.ts"查找面板没有高级查找"（只读时查找面板里看不到这个链接、查找照常；能编辑时的对照看得到）'
/** M0 的只读（阅读模式）验证：本地权限点加 mutation 防火墙 */
const M0_READ_MODE_EVIDENCE = 'M0-P3 报告 §5（V09：本地权限点加 mutation 防火墙，表格 28 个入口在三个浏览器、含公式 Worker 模式全部拦住；只靠权限点漏掉 9 个）、§7（内部 API 登记）；M0 的 harness/read-mode.ts'
/** 链接的改写（M3-P3 设计 §3.6，DEF-021）：单元测试与三个浏览器的 E2E。SDK 升级后改成复制参数时改写静默失效，这组 E2E 先失败 */
const CELL_LINK_REGRESSION = [
  '单元测试 profile/link-policy.test.ts（各条路径写出的 p 的形状、公式结果的确定的标识、只处理这一条 mutation、绝不抛出；SDK 的 CustomRangeType.HYPERLINK 等于 contracts 的 HYPERLINK_RANGE_TYPE）、',
  'sheet-editor.test.ts（阅读与编辑都在入口守卫之后、创建工作簿之前装上）；',
  'E2E tests/e2e/specs/editor/links.spec.ts（US-M3-14，本机三个浏览器）：键入、编辑栏里键入与粘贴、选中单元格粘贴纯文本、单元格编辑器里粘贴、粘贴带链接的 HTML、HYPERLINK() 之后',
  '页面里是规范写法或链接已去掉，撤销两步、重做两步之后不变，保存之后服务器上的每个链接都通过 checkCellLinks；含 HYPERLINK() 的表格强制重算、重开之后内容不变；',
  '"endIndex 含在内"（约定 3）的回归是其中单元格编辑器里粘贴两行的 G3（链接改用第二行的文字；含义变了时这一格的链接被去掉，这条先失败），',
  '另有 contracts 的 link-address.test.ts（覆盖的文字按 endIndex 含在内取，下标不合理时去掉链接）；',
  'template.spec.ts（键入、粘贴网址之后保存的是规范写法）',
].join('')

/** 打开自检的资源守卫（M3-P4 设计 §3.11）：单元测试与三个浏览器的 E2E。SDK 升级改了资源 hook 的注册时机、名字或加载路径时这组先失败 */
const RESOURCE_LOAD_GUARD_REGRESSION = [
  '单元测试 internal-api/resource-load-guard.test.ts（真实的 Univer core 带上守卫，假 hook 分别走单元加入时的 loadResources 与晚注册的 loadHookResource：',
  '解析抛错、吞成空值、加载抛错、序列化抛错各一类，空串与深层为空的输入不误报；包装只观察——异常原样抛出、返回值原样返回、this 与 toJson 的第二个参数原样交给插件）、',
  'profile/open-check.test.ts（判定）、sheet-editor.test.ts（jsdom 里真实的 Univer core 与带资源 hook 的十个数据插件：模板与各项资源都非空的快照 openCheck 通过，',
  '截断的条件格式、截断的筛选、{表:5} 的筛选给出预期的失败；守卫在 new Univer 里、捕获在 createWorkbook 刚返回时）；',
  'E2E tests/e2e/specs/editor/open-check.spec.ts（模板、只读样本与大表在本机三个浏览器里 openCheck 通过，经测试构建的探针读出）与 US-M3-15 的用例（S5）',
].join('')

export const INTERNAL_API_REGISTRY: readonly InternalApiEntry[] = [
  {
    name: 'injectorOf',
    origin: '@univerjs/core 的 Univer.__getInjector()（平台的封装）',
    // injector.ts：参数与返回值的类型
    sdk: { '@univerjs/core': ['Injector', 'Univer'] },
    purpose: '取 Facade 没有暴露的服务：IFunctionService、IActiveDirtyManagerService，Worker 里的 LifecycleService，只读守卫的 IPermissionService、IUndoRedoService、IDrawingManagerService、IRenderManagerService（冻结线与行列调整的控制器）、IEditorService、IContextService，以及 E2E 的探针（只在测试构建里）的 IShortcutService、IEditorService',
    evidence: 'M0-P3 报告 §7"取服务"；M0 的 create-editor.ts 经它取各项内部服务；P4 探针 (a)–(f) 全程使用',
    regression: 'E2E（S4）编辑器能打开并就绪：任何一处取服务失败都会按加载失败处理；单元测试 install-image-policy.test.ts、calculation-trigger.test.ts 核对取的是哪项服务',
  },
  {
    name: 'FORMULA_PROTOCOL',
    origin: '@univerjs/engine-formula 的 SetFormulaCalculationStart/Stop/Result/NotificationMutation、SetTriggerFormulaCalculationStartMutation、FormulaExecutedStateType，@univerjs/sheets 的 SetRangeValuesMutation；执行选项 applyFormulaCalculationResult 与通知参数 functionsExecutedState（SDK 里的字面量）',
    // formula-protocol.ts：mutation 的 id 与完成状态取自 SDK 导出的定义
    sdk: {
      '@univerjs/engine-formula': [
        'FormulaExecutedStateType',
        'SetFormulaCalculationNotificationMutation',
        'SetFormulaCalculationResultMutation',
        'SetFormulaCalculationStartMutation',
        'SetFormulaCalculationStopMutation',
        'SetTriggerFormulaCalculationStartMutation',
      ],
      '@univerjs/sheets': ['SetRangeValuesMutation'],
    },
    purpose: [
      '公式收齐（P4 设计 §3.6.6）：认出一轮计算的开始、停止、结果、逐表写回与完成；M3-P4：认出强制全量重算的触发命令（参数里 forceCalculation 为真，进入编辑时以 FORCED 创建的那一轮，收齐之前不补存）。',
      'M3-P4（S5，设计 §3.14）：主线程公式模式下销毁编辑器之前，有一轮在算（开始了、还没有结束的通知）就同步执行停止的 mutation（带 onlyLocal），等这一轮结束的通知（completedStates，被停下的是 STOP_EXECUTION）',
      '再销毁（formula-round-stop.ts，sheet-editor.ts 的 tearDown；编辑器槽位等它销毁完才新建）。依赖的约定：(1) 停止标记只在让出点检查（每 intervalCount 个公式一次，主线程模式是 20），',
      '被停下的一轮在下一个让出点返回，随即发出结束的通知；(2) 销毁时停止标记被复位（运行时的 dispose 调 reset）——所以必须先停下、等到通知再销毁，否则旧的一轮在让出点之后接着跑，',
      '用已经清空的函数表把只会得出 #NAME? 的语法树写进模块级的 FORMULA_AST_CACHE（同一页里所有实例共用，键里有 unitId），之后重建的编辑器命中它们；(3) Worker 模式下计算与这份缓存都在 Worker 里、随它终止，不需要等',
    ].join(''),
    evidence: [
      'M0-P3 报告 §3.3、§3.4、§7；engine-formula 的 calculate.controller.ts:232-257、formula-calculation-trigger.service.ts:166-176，sheets 的 calculate-result-apply.controller.ts:90-97；M0 的 e2e/v07-formula、v07-worker-timeline；P4 探针 (f) 在三个浏览器上录制的序列；',
      'M3-P4：sheets-formula 的 _getDirtyDataByCalculationMode（update-formula.controller.ts:290-305、trigger-calculation.controller.ts:299-315；1.0.1 的 lib/es/index.js:538、:2092 同样写 forceCalculation: calculationMode === 0）。',
      'M3-P4 S1 真实 Safari 复核的 F2（reviews/P4-S1-真实Safari复核.md：四个浏览器复现，主线程模式下在计算中重建，110–350 个公式得出 #NAME?，Worker 模式不受影响）；engine-formula 1.0.1 的 lib/es/index.js：',
      ':6084 模块级的 FORMULA_AST_CACHE、:6087-6102 generateAstNode 解析之后写进它；CalculateFormulaService._apply 在让出点（requestImmediateMacroTask，:14884-14891）之后才检查 isStopExecution（:14900），',
      '停下时 markedAsStopFunctionsExecuted 并返回（:14902），execute 随即在锁里发出结束（:14796），CalculateController 把它写成 SetFormulaCalculationNotificationMutation（:15133-15145）；',
      'FormulaRuntimeService.dispose 调 reset、把 _stopState 复位为 false（:10004-10006、:10086）；停止的 mutation 由 CalculateController 的命令监听调 stopFormulaExecution（:15060），',
      '触发服务停下一轮也是这条 mutation、带 onlyLocal（formula-calculation-trigger.service.ts，:43746）；core 的 syncExecuteCommand 执行完同步送出 CommandExecuted（lib/es/index.js:2214-2245）',
    ].join(''),
    regression: [
      `${FORMULA_SETTLE_REGRESSION}；M3-P4：formula-settle-tracker.test.ts"强制全量重算"（看到触发命令之前不算收齐）与 E2E tests/e2e/specs/editor/autosave.spec.ts"带公式待更新的文档进入编辑：强制重算之后补存"；`,
      'M3-P4（S5）：单元测试 formula-round-stop.test.ts、formula-settle-tracker.test.ts"有一轮在算"、sheet-editor.test.ts"主线程模式下销毁之前停下正在算的一轮"、editor-slot.test.ts"销毁要等时"；',
      'E2E tests/e2e/specs/editor/formula-rebuild.spec.ts（主线程模式下计算中进入编辑、退出编辑，之后公式的值都对；本机三个浏览器）与页面自检的校准（selftest.spec.ts 的 formula-timing-main：',
      'formula.rebuild-during-calc 要求全部与按定义算出的一致；SDK 改了停止的做法时这几条先失败）',
    ].join(''),
  },
  {
    name: 'CELL_LINK_PROTOCOL',
    origin: '@univerjs/sheets 的 SetRangeValuesMutation（id 与参数 cellValue[行][列] 的形状），@univerjs/core 的 CustomRangeType.HYPERLINK 与单元格富文本 p.body.customRanges 的形状（区间的 rangeId、rangeType、properties.url）；执行选项 fromFormula（SDK 里的字面量）；平台对这几项内部约定的封装',
    // cell-links.ts：mutation 的 id 与链接区间的种类取自 SDK 导出的定义
    sdk: { '@univerjs/core': ['CustomRangeType'], '@univerjs/sheets': ['SetRangeValuesMutation'] },
    purpose: [
      '链接的改写（profile/link-policy.ts，M3-P3 设计 §3.6，DEF-021）：订阅 Facade 的 BeforeCommandExecute，只处理这条 mutation，参数里带 p.body.customRanges 的单元格交给 contracts 的',
      ' normalizeCellLinks 就地改成规范写法、不合法的去掉链接；带 fromFormula 的（公式的结果）再把 SDK 每次重算都随机生成的链接 rangeId 与段落 paragraphId 换成由位置与序号确定的值。',
      '依赖的约定：(1) 执行前事件交出的 params 就是命令服务交给处理器、命令放进撤销栈的同一个对象，就地改写对执行、撤销与重做都生效，不多产生 mutation；',
      '(2) SDK 自动识别出的链接都经这条 mutation 写进单元格（改写器的输入假设，各种写法见证据）；',
      '(3) 链接区间的 startIndex、endIndex 都含在内（endIndex 是区间最后一个字符的下标）：单元格编辑器里粘贴多行时 SDK 把整段文字当作地址，',
      'normalizeCellLinks 改用区间覆盖的文字（contracts 的 coveredText 按 dataStream.slice(startIndex, endIndex + 1) 取）修复地址，依赖这一条；',
      'SDK 改了含义时修复静默失效——链接被去掉、文字还在，不出错（M3-P3 审查 B9）',
    ].join(''),
    evidence: [
      '同一个对象：core 的 command.service.ts:430-448、491-509（commandInfo 带着同一个 params，先调执行前的监听再交给处理器）、facade/f-univer.ts:255-268（事件的 params 是同一个引用；',
      'f-event-registry.ts:120-125 先调完全部订阅者再看 cancel，没有 try/catch，订阅者抛出会让这条命令失败）；sheets 的 set-range-values.command.ts:101-155（执行过的参数原样放进撤销栈）、',
      'sheets-ui 的 clipboard.service.ts:1090-1180（粘贴执行过的 redoMutationsInfo 原样放进撤销栈）；set-range-values.mutation.ts:253-265（处理器把 p 深拷贝进模型）；',
      'M0-P5 报告 §7 的 C7c（文字文档的命令级：改写链接地址依赖事件参数与命令处理器是同一个对象）；P3 设计前的探索 B 的探针（三个浏览器：就地改写有效，每次编辑只有一条 set-range-values，',
      '撤销两步、重做两步之后仍是改写后的写法、改写的次数不变）。',
      'SDK 自动识别的写法（1.0.1）：键入与编辑栏里键入是 sheets-hyper-link 的 set-range.controller.ts:141-207（isLegalUrl 时 Tools.normalizeUrl：有协议原样、邮箱补 mailto://、其余补 https://，ftp:// 也识别）；',
      '选中单元格粘贴纯文本是 sheets-ui 的 clipboard.controller.ts:567-640（原文，不补协议）；单元格编辑器里粘贴是 core 的 text-x/build-utils/parse.ts:55 的 fromPlainText（整段文字，两行时带换行；',
      '区间的 endIndex 是 cursor + urlText.length - 1，含在内，:70）；',
      '粘贴带 <a> 的 HTML 是 html-to-usm/converter.ts:823-842（HTMLAnchorElement.href，about:blank 的文档里相对地址原样，rangeId 取 data-rangeid 原样）；编辑栏里粘贴 HTML 是 docs-ui 的 html-to-udm',
      '（按页面地址解析成本站的绝对地址）；HYPERLINK() 是 engine-formula 的 hyperlink-engine-formula.service.ts:36-71（isLegalUrl 时 normalizeUrl，否则原文；RichTextBuilder 每次随机生成 rangeId 与 paragraphId），',
      '经 sheets 的 calculate-result-apply.controller.ts:90-97 写回（onlyLocal、fromFormula、applyFormulaCalculationResult）。不经这条 mutation 改写链接的只有引用的区域变化时 sheets-hyper-link 的',
      ' update-rich-hyper-link（只写 #gid=…&range=… 的内部锚点，本来就是规范写法）。S2 实现时的探针：公式结果的 p 有一个段落，强制重算与重开都换新的 rangeId 与 paragraphId',
      '（初次计算是 WHEN_EMPTY，HYPERLINK() 的格子没有 v，每次打开都重算：sheets-formula 的 trigger-calculation.controller.ts:291-322、engine-formula 的 formula-data.model.ts:758-796）',
    ].join(''),
    regression: CELL_LINK_REGRESSION,
  },
  {
    name: 'createResourceLoadGuard',
    origin: '@univerjs/core 的资源管理服务（IResourceManagerService 与它的实现 ResourceManagerService）、资源 hook 的形状（IResourceHook）、ILogService、UniverInstanceType.UNIVER_SHEET；平台对资源加载与序列化的观察的封装（Facade 之外，Facade 没有资源相关的 API）',
    // resource-load-guard.ts：子类、工厂的覆盖与 hook 的类型
    sdk: { '@univerjs/core': ['DependencyOverride', 'IDisposable', 'ILogService', 'IResourceHook', 'IResourceManagerService', 'ResourceManagerService', 'UniverInstanceType'] },
    purpose: [
      '打开自检（M3-P4 设计 §3.11，US-M3-15）：new Univer({ override }) 以 useFactory（deps: ILogService）换上 ResourceManagerService 的子类，只覆盖 registerPluginResource，',
      '把每个 hook 的 parseJson、onLoad 包一层只观察的委托，记下 parse-threw（非空的输入解析时抛错）、parse-swallowed（非空的输入解析成深层为空的值）、load-threw（onLoad 抛错），',
      '只记资源名、种类与异常的构造器名；另给出表格 hook 的名字（档案完整性）与逐个 hook 的 toJson（资源比较与 serialize-threw）。依赖的约定：',
      '(1) 资源管理服务在注入器创建时就被资源加载服务取走，只能在构造 Univer 时覆盖；(2) 两条加载路径——单元加入时的 loadResources 与之后注册的 hook 经 register$ 的 loadHookResource——',
      '调的都是登记进来的 hook（getAllResourceHooks 与 register$ 交出的都是交给 registerPluginResource 的那一个）；(3) loadResources 跳过空串，晚注册的路径照样把空串交给 parseJson；',
      '(4) SDK 自己吞掉 parseJson、onLoad 的异常，只记日志；(5) 保存输出的正是 business 含 UNIVER_SHEET 的各 hook 的 toJson(unitId)；',
      '(6) 表格的十个 hook 都在 createWorkbook() 同步返回之前注册并加载完（6 个在 Starting 走 loadResources，4 个在 Ready 走晚注册），之后不再注册；',
      '(7) 各 hook 的 parseJson 返回 JSON 值（JSON.parse 的结果或 {}，无环的普通对象与数组），"吞成空值"用深层为空判断才成立',
    ].join(''),
    evidence: [
      '1.0.1 的 core lib/es/index.js：ResourceManagerService :26688-26760（getResourcesByType :26709 按 business 过滤、registerPluginResource :26723 先放进表再经 register$ 发出、',
      'loadResources :26733 按名称找第一条、data 为空串时跳过、catch 只记日志）；ResourceLoaderService :28452-28548（loadHookResource :28460 找到同名的就解析、不看是否为空，',
      'catch 只打 console.error；handleHookAdd :28469；register$ 的订阅 :28501；单元加入时 loadResources :28502；saveUnit :28539 取 getResources(unitId, unit.type)）；',
      'createUniverInjector :28681-28721（默认 [IResourceManagerService, { useClass: ResourceManagerService, lazy: true }] :28705，mergeOverrideWithDependencies 按标识替换，',
      ':28719 touchDependencies 资源加载服务）；sheets 的 facade.js:7240 FWorkbook.save() 走 saveUnit。各 hook 的 parseJson（1.0.1 的 lib/es/index.js）：sheets 的区域主题 :1498、',
      '工作表保护 :16277、保护点 :16325、定义名称 :17905、区域保护 :20714，sheets-drawing :804（toJson 另有第二个参数 model），sheets-conditional-formatting :2701，',
      'sheets-note :487，data-validation :328——都是"空串给 {}、解析不了给 {}"；sheets-filter :726 是裸 JSON.parse（空串与截断的 JSON 都抛错）。',
      'P4 设计前的探索 B 的探针（三个浏览器一致，scratchpad 的 p4b-probe-summary.txt）：两条路径都经过包装，十个表格 hook 在 createWorkbook 返回之前注册并加载完、之后没有再注册；',
      '截断的筛选是解析抛错，截断的条件格式、数据验证、图片、备注、定义名称是吞成空值，{表:5} 与 {表:{a:1}} 的条件格式、数据验证是加载抛错，{表:5} 的备注静默装不进（只有资源比较认得出），',
      '{表:5} 的筛选加载不报错、之后 toJson 抛错；筛选的 data 为空串时晚注册的路径照样解析而抛错（所以空串不算）；模板、只读样本、大表无误报；只捕获资源 ≤1 ms',
    ].join(''),
    regression: RESOURCE_LOAD_GUARD_REGRESSION,
  },
  {
    name: 'IAuthzIoService',
    origin: '@univerjs/core 的授权服务标识与接口（Facade 之外）',
    purpose: '编辑器身份（ADR-009，M2-P3 设计 §3.2）：new Univer({ override }) 换成按打开方式回答的实现（能编辑时全部允许，只读时只允许查看与复制）；依赖的约定是 allowed 的结果设置工作簿的权限点（每个动作要有明确的布尔值）、batchAllowed 的返回形状、create 只由（已隐藏的）保护入口调用',
    evidence: 'P4 研究摘要 §4.8 的源码核实（core 的 univer.ts:295、authz-io-local.service.ts:65-118，sheets 的 sheet-permission-init.controller.ts:171-191、333-385：Ready 与用户变化时按 allowed 的结果设置工作簿的 22 个权限点）；P4 探针 (a)：替换前后打开、编辑、增删工作表、筛选、排序、条件格式、数据验证、备注、查找替换的结果相同，40 个权限点都允许，快照没有 SHEET_AuthzIoMockService_PLUGIN',
    regression: `单元测试 identity/editor-authz-io.service.test.ts；E2E tests/e2e/specs/editor/features.spec.ts（增删工作表、排序与筛选、条件格式与数据验证、批注与查找替换，经界面操作、按服务器上的快照核对），template.spec.ts（新建文档的快照与模板逐字节相同，资源里没有 SHEET_AuthzIoMockService_PLUGIN）；只读时：${READ_ONLY_E2E}`,
  },
  {
    name: 'disposalSafeLocaleOverride',
    origin: '@univerjs/core 的语言服务 LocaleService（Facade 之外）与 new Univer({ override }) 的依赖替换（DependencyOverride）；平台的封装（locale-service.ts 的 DisposalSafeLocaleService）',
    sdk: { '@univerjs/core': ['DependencyOverride', 'LocaleService'] },
    purpose: [
      '销毁之后不抛错的语言服务（main 16f8a1d 的 CI 上 save.spec.ts"计算进行中又改了一处"偶发的页面异常）：核心注入器里的 LocaleService 换成子类，',
      '只改销毁之后（含销毁的过程中）的 t()——交回键本身、不抛错；销毁之前的行为完全不变（load 之前照样抛错）。',
      'SDK 里有销毁之后才到点、还会调 t() 的计时器：sheets-formula 的 TriggerCalculationController 收到一轮计算的开始通知时设 1 秒的进度计时器，',
      '算完才清、销毁不清；阅读与编辑之间的切换一律重建编辑器（M3-P2 设计 §3.1），旧的那一个在这 1 秒里销毁、这一轮又还没算完时，',
      '到点调用已销毁的语言服务，抛出"Locale not initialized"，页面里一条没接住的异常（打开含公式的表格马上点"编辑"就会遇到）。',
      '同一处替换也覆盖 SDK 里别的销毁之后才调 t() 的异步回调（都要用户操作在先：ui 的剪贴板失败提示、sheets-ui 粘贴 Excel 内容、',
      '数据验证的拒绝输入提示、超链接的复制提示、插入图片出错的提示）。依赖的约定：(1) t 是构造时定义在实例上的箭头函数，子类在 super() 之后取下它、换上自己的；(2) 核心注入器按 [LocaleService] 登记，',
      'override 按标识符替换，插件按 LocaleService 注入的都是这一个实例；(3) univer.dispose() 销毁注入器时调用实例的 dispose()',
    ].join(''),
    evidence: [
      'core 的 services/locale/locale.service.ts:41-46（销毁时 _locales = null）、:83-97（t：_locales 为空时抛错）；1.0.1 的 lib/es/index.js:25402-25442',
      '（t 由 _defineProperty 定义在实例上，:25431 抛错）、:25443-25448（销毁时清空）。sheets-formula 的 controllers/trigger-calculation.controller.ts:79-85',
      '（_startProgress 调 t）、:196-215（开始的通知：setTimeout 1000）、:266-281（算完时清）、:141-146（dispose 不清）；1.0.1 的 lib/es/index.js:392-397、',
      '466-476、514-523、438-442。core 的 univer.ts:142-163（构造时 load 语言包）、:185-188（dispose 销毁注入器）、:274-297（[LocaleService]）、',
      'services/plugin/plugin-override.ts:28-43（按标识符替换）；1.0.1 的 lib/es/index.js:28595-28612、28631-28634、28681-28684、26444-26455；',
      'redi 1.1.3 的 dist/esm/index.js:713-718（ResolvedDependencyCollection.dispose 调用实例的 dispose）。',
      '复现（修之前，本机三个浏览器各 5 次全部失败）：E2E 的回归用例；打开 1500 个没有缓存值的 SUMPRODUCT 公式的表格、就绪后立即点"编辑"同样复现（Chromium）',
    ].join(''),
    regression: [
      '单元测试 internal-api/locale-service.test.ts（销毁之前与 SDK 的 LocaleService 相同；销毁之后与销毁的过程中 t() 交回键本身；',
      'SDK 的 LocaleService 销毁之后仍抛错——不再抛时这一项可以撤掉；经 new Univer({ override }) 取到的是子类，univer.dispose() 之后 t() 不抛错）、',
      'sheet-editor.test.ts（创建的编辑器用的是它）；E2E tests/e2e/specs/editor/edit-mode.spec.ts"阅读时一轮计算刚开始就点\'编辑\'"',
      '（本机三个浏览器；去掉这项替换时失败：页面异常 Locale not initialized）',
    ].join(''),
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
    purpose: '只读守卫：就绪时 clearUndoRedo(unitId) 清空这份文档的撤销栈（保底：阅读与编辑之间的切换一律重建编辑器，M3-P2 设计 §3.1，以只读创建时撤销栈本来就空；这一步不依赖创建的过程里没有进撤销栈的操作）；撤销与重做本身经 Facade 的 BeforeUndo、BeforeRedo 取消',
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
    purpose: '只读守卫（read-only/note-popup.ts）：在页面上观察批注浮层出现，把文本框设为只读；M3-P4：面板的防抖（PANEL_DEBOUNCES 的批注一项）认出批注浮层开着',
    evidence: 'M2-P3 S3 的 E2E：批注浮层总是可以输入的文本框（Note.tsx 没有只读的开关，打开时还会被程序聚焦，:98-106），只读时键入之后写回批注的 mutation 被防火墙取消、界面复原；修复时实测：设为只读之后键入不改内容，文字照常显示',
    regression: `单元测试 read-only/note-popup.test.ts；${READ_ONLY_E2E}（悬停看到批注，文本框只读，键入之后内容不变）；M3-P4 的回归见 PANEL_DEBOUNCES`,
  },
  {
    name: 'PANEL_DEBOUNCES',
    origin: '按防抖写模型的两个面板的 DOM 标记与防抖时长（SDK 里的字面量）：sheets-note-ui 的批注浮层（文本框 data-u-comp="note-textarea"，ui 的 useDebounceFn 默认 300 ms）、sheets-data-validation-ui 的详情面板（根元素 data-u-comp="data-validation-detail"，lodash debounce 1000 ms）；平台对这两项约定的封装',
    purpose: '面板的防抖（M3-P4 设计 §3.4，panel-debounce-watch.ts）：这两个面板开着时有用户输入，就记下"SDK 的防抖到点"的时刻；退出编辑、交出与按保存的捕获之前（立即上传在按下时的准备：snapshot-capture.ts 的 settleInputs）、失去编辑权的捕获之前等到这一刻，最后的改动先写进模型再捕获、再销毁编辑器',
    evidence: [
      'ui 的 views/hooks/use-debounce.ts:19-30（组件卸载时不清计时器）与 sheets-note-ui 的 views/Note.tsx:110-143（1.0.1 的 ui lib/es/index.js:6584-6592、sheets-note-ui lib/es/index.js:648、:691）；',
      'sheets-data-validation-ui 的 views/components/DataValidationDetail.tsx:65-72、:114（三种更新共用一个防抖，卸载时不 flush；1.0.1 的 lib/es/index.js:2931-2934、面板根元素 :3140）。',
      '关闭面板不提交也不取消、没有对外的"立即提交"，只能等它到点；refer 的其余界面包的防抖只管界面（M3-P4 S4 逐包核对），图片的变换面板在 M5 之前进不来',
    ].join(''),
    regression: '单元测试 panel-debounce-watch.test.ts（面板开着时的输入才等、等到防抖到点、页头里的不算、销毁时放行）、snapshot-capture.test.ts（捕获之前先等面板）；E2E tests/e2e/specs/editor/autosave.spec.ts"批注里键入之后立即退出编辑""数据验证面板里改了之后立即退出编辑"：服务器上有这次的改动（本机三个浏览器）',
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
    name: 'FIND_ADVANCED_LINK_SELECTOR',
    origin: 'find-replace 查找面板的 DOM 标记：根元素 data-u-comp="find-replace-dialog"（views/dialog/FindReplaceDialog.tsx:354）与它下面放着"替换 / 高级查找"链接的那一块（:110-122 的 div > a；1.0.1 的 lib/es/index.js:1632-1639）；平台对这个约定的封装',
    purpose: '只读守卫（read-only/advanced-find.ts，DEF-028）：只读时在 head 里加一条样式藏起这个链接（它执行的打开替换被只读守卫取消，点了没有反应），销毁时去掉',
    evidence: 'M2-P3 S3 的 E2E 发现只读时链接仍显示、点了没有反应（DEF-028）；面板的组件没有藏起它的开关，面板经弹出层渲染在 body 下（ui 的 Workbench.tsx 的 portalContainer），不在编辑器的容器里；M3-P2 S3 修复时实测：只读时三个浏览器上都看不到链接，查找照常',
    regression: ADVANCED_FIND_REGRESSION,
  },
  {
    name: 'IEditorService',
    origin: '@univerjs/docs-ui 的编辑器管理服务（Facade 之外）',
    purpose: '只读守卫（read-only/formula-bar.ts 的 releaseFormulaBarEditor）：订阅 focus$，焦点落到编辑栏的编辑器（getFocusId）时 blur(true) 放开；依赖的约定是 focus 先记下焦点再送出 focus$，blur 复位 EDITOR_ACTIVATED 等上下文、移走 DOM 焦点、把当前文档换回聚焦之前的。另外 E2E 的探针（只在测试构建里，testing/e2e-probe.ts 的 formulaBarText）经 getEditor(编辑栏).getDocumentData() 读编辑栏显示的文字（M2-P6 复核 F2）',
    evidence: [
      'P3 审查 A1：在别处按下、在编辑框上松开，sheets-formula-ui 的编辑框自己的 onMouseUp（views/formula-editor/index.tsx:535-549、hooks/use-focus.ts:60）经这个服务聚焦编辑栏，',
      'EDITOR_ACTIVATED 置为真，查找与方向键失效（三个浏览器复现）；docs-ui 的 services/editor/editor-manager.service.ts（1.0.1 的 lib/es/index.js:4501-4534：',
      'focus 先 _setFocusId 再 _focus$.next，blur 复位 EDITOR_ACTIVATED、FOCUSING_EDITOR_STANDALONE、FOCUSING_COMMENT_EDITOR，编辑器的 blur 让输入元素失去焦点，',
      'preserveHostFocus 的编辑栏换回原来的当前文档）；编辑框的 useRefactorEffect 在 React 提交之后再置一次 EDITOR_ACTIVATED（sheets-formula-ui 的 lib/es/index.js:2872-2889），所以在微任务里放开',
    ].join(''),
    regression: `${FORMULA_BAR_RELEASE_REGRESSION}；探针读编辑栏：${READ_ONLY_SHORTCUTS_E2E}`,
  },
  {
    name: 'IContextService',
    origin: '@univerjs/core 的上下文服务（Facade 之外）',
    purpose: '只读守卫放开编辑栏时把 FOCUSING_FX_BAR_EDITOR 复位为假',
    evidence: 'core 的 services/context/context.service.ts；sheets-ui 结束编辑时复位的正是 FOCUSING_EDITOR_INPUT_FORMULA、EDITOR_ACTIVATED、FOCUSING_FX_BAR_EDITOR（editing.render-controller.ts:870-874，1.0.1 的 lib/es/index.js:11846-11848）',
    regression: FORMULA_BAR_RELEASE_REGRESSION,
  },
  {
    name: 'FOCUSING_FX_BAR_EDITOR',
    origin: '@univerjs/core 的上下文键：编辑栏正被聚焦（SDK 的常量）',
    purpose: '只读守卫放开编辑栏时复位它：FormulaBar 在编辑框上按下时置为真；它为真时表格的方向键、查找等快捷键不生效，编辑栏的编辑框会反复重新聚焦',
    evidence: 'sheets-ui 的 views/formula-bar/FormulaBar.tsx:252-262（1.0.1 的 lib/es/index.js:22123-22145），whenSheetEditorFocused 要求它为假（:55），结束编辑时复位（:11848）；sheets-formula-ui 的编辑框按它（isFocus）重新聚焦（lib/es/index.js:6774-6809）',
    regression: FORMULA_BAR_RELEASE_REGRESSION,
  },
  {
    name: 'DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY',
    origin: '@univerjs/core 的常量：编辑栏内部编辑器的单元 id（"__INTERNAL_EDITOR__DOCS_FORMULA_BAR"）',
    purpose: '只读守卫认出焦点落在编辑栏的编辑器上（IEditorService.getFocusId）；E2E 的探针按它取编辑栏的编辑器、读显示的文字（M2-P6 复核 F2）',
    evidence: 'sheets-ui 的 FormulaBar.tsx 把它作为编辑框的 editorId（1.0.1 的 lib/es/index.js:22203），sheets-formula-ui 的编辑框按它注册编辑器（lib/es/index.js:6697-6700）；P3 审查 A1 的探查：聚焦之后的活动元素是 #__editor___INTERNAL_EDITOR__DOCS_FORMULA_BAR；sheets-ui 选区变化时把当前单元格的内容同步进这个编辑器的文档（lib/es/index.js:28907-28927 的 _syncFormulaEditorContent）',
    regression: `${FORMULA_BAR_RELEASE_REGRESSION}；${READ_ONLY_SHORTCUTS_E2E}`,
  },
  {
    name: 'IRenderManagerService',
    origin: '@univerjs/engine-render 的渲染管理服务（Facade 之外）',
    purpose: '只读守卫（read-only/freeze-handles.ts、header-resize.ts）：按 unitId 取这份文档的渲染单元（getRenderUnitById），再取它的冻结线控制器与行列调整控制器',
    evidence: 'engine-render 的 render-manager/render-manager.service.ts、render-unit.ts（1.0.1 的 lib/es/index.js:38583-38585 with 取渲染单元里的实例，38736-38743 渲染模块注册时加进已有的渲染单元）；P3 审查 B2',
    regression: `${FREEZE_LOCK_REGRESSION}；${HEADER_RESIZE_LOCK_REGRESSION}`,
  },
  {
    name: 'HeaderFreezeRenderController',
    origin: '@univerjs/sheets-ui 的冻结线渲染控制器（渲染模块，Facade 之外）',
    purpose: '只读守卫：在它的拦截点 FREEZE_PERMISSION_CHECK 上注册总是不允许的拦截器，冻结线移上不显示可拖动的光标、按下不开始拖动',
    evidence: [
      'P3 审查 B2：只读时冻结线照样拖得动，set-frozen 被防火墙取消，界面上的冻结线停在拖到的位置。',
      '根因：sheets-ui 的 controllers/render-controllers/freeze.render-controller.ts 在移上、按下与拖动时问 FREEZE_PERMISSION_CHECK（1.0.1 的 lib/es/index.js:14182、14306、14325、14399、14415），',
      '按权限拦它的 SheetPermissionInterceptorCanvasRenderController._initFreezePermissionInterceptor（:32070-32077）没有被调用（构造函数只调用了另外四个，:31973-31976）；',
      '冻结线控制器在插件的 onRendered 才注册为渲染模块（:36024-36088），所以就绪时装上',
    ].join(''),
    regression: FREEZE_LOCK_REGRESSION,
  },
  {
    name: 'HeaderResizeRenderController',
    origin: '@univerjs/sheets-ui 的行列调整渲染控制器（渲染模块，Facade 之外）',
    purpose: '只读守卫（read-only/header-resize.ts，DEF-027）：在它的拦截点 HEADER_RESIZE_PERMISSION_CHECK 上注册优先级高于 SDK 的、总是不允许的拦截器，只读时任何行列的分隔线都不显示调整的控制点、拖不动',
    evidence: [
      'M3-P2 S3 的 E2E 核实（没有冻结的表，只读）：第 1、2 行之间与 A、B 列之间的分隔线移上去是 row-resize、col-resize，拖得动，松开时 delta-row-height、delta-column-width 被权限检查拦下并弹出只读的提示；',
      '第 5、6 行之间与 D、E 列之间没有光标、没有命令（Chromium、WebKit）。根因：SheetPermissionInterceptorCanvasRenderController._initHeaderResizePermissionInterceptor',
      '（1.0.1 的 lib/es/index.js:31993-32008）写的是 if (rangeParams.row) … else if (rangeParams.col)，索引 0 两个条件都不成立、一律放行；',
      '行列调整控制器在移上时问这个拦截点（:15640、15660），拦截器按优先级从高到低执行（core 的 common/interceptor.ts 的 composeInterceptors），SDK 的没有优先级；',
      '控制器在插件的 onRendered 才注册为渲染模块（sheets-ui 的 plugin.ts 的 _registerRenderModules），所以就绪时装上',
    ].join(''),
    regression: HEADER_RESIZE_LOCK_REGRESSION,
  },
  {
    name: 'IShortcutService',
    origin: '@univerjs/ui 的快捷键服务（Facade 之外；Facade 的 FShortcut 只能派发按键与停用快捷键，列不出已注册的快捷键）',
    purpose: 'E2E 的探针（只在测试构建里，testing/e2e-probe.ts 的 shortcuts）：getAllShortcuts 列出 SDK 当前注册的全部快捷键，只读的快捷键回归逐个按遍，SDK 升级带来的新入口由它发现（M2-P6 复核 F1、F2 之后）；生产代码不用它',
    evidence: [
      'M2-P6 复核 S4：审查者对全部已注册的快捷键（1.0.1 在苹果的平台上 143 项，按页面的平台归并成 78 种组合）在只读页上逐个按，发现"搜索功能"面板（F1）与快速求和（F2）。',
      'ui 的 services/shortcut/shortcut.service.ts（1.0.1 的 lib/es/index.js:1027-1030 getAllShortcuts 给出每一项；:1109 起 _getBindingFromItem 按平台取 mac、win、linux 或 binding；',
      'PlatformService 按 navigator.appVersion 判断平台，:953-959）',
    ].join(''),
    regression: READ_ONLY_SHORTCUTS_E2E,
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

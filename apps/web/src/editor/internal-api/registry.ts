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

const FORMULA_SETTLE_REGRESSION = '单元测试 change-tracking/formula-settle-tracker.test.ts（P4 探针录制的命令序列）、calculation-trigger.test.ts；E2E（S4）"改公式的依赖后立即保存，服务器上的缓存值与按定义算出的一致（含跨表、计算进行中再改一次）"'
const IMAGE_POLICY_REGRESSION = '单元测试 image-function/restricted-image-function.test.ts、install-image-policy.test.ts；E2E（S4）"外链的 IMAGE() 显示 #VALUE!、没有 CSP 违规"，以及编辑器能就绪（主线程与 Worker 都装上才就绪）'

export const INTERNAL_API_REGISTRY: readonly InternalApiEntry[] = [
  {
    name: 'injectorOf',
    origin: '@univerjs/core 的 Univer.__getInjector()（平台的封装）',
    purpose: '取 Facade 没有暴露的服务：IFunctionService、IActiveDirtyManagerService，以及 Worker 里的 LifecycleService',
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
    purpose: '编辑器身份（ADR-009）：new Univer({ override }) 换成全部允许的实现；依赖的约定是 allowed 的结果设置工作簿的权限点、batchAllowed 的返回形状、create 只由（已隐藏的）保护入口调用',
    evidence: 'P4 研究摘要 §4.8 的源码核实（core 的 univer.ts:295、authz-io-local.service.ts:65-118，sheets 的 sheet-permission-init.controller.ts:171-191）；P4 探针 (a)：替换前后打开、编辑、增删工作表、筛选、排序、条件格式、数据验证、备注、查找替换的结果相同，40 个权限点都允许，快照没有 SHEET_AuthzIoMockService_PLUGIN',
    regression: '单元测试 identity/allow-all-authz-io.service.test.ts；E2E（S4）上述各项操作照常、新建文档的快照与模板逐字节相同（资源里没有 SHEET_AuthzIoMockService_PLUGIN）',
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

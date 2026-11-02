# P5-S3 CSV 正式宿主入口

> 2026-11-01｜基线 `bd7ac04d8a8c860daf505005c0f4f071b89d6e04`｜同一 `codex/m5-p5-csv` worktree｜自主 inline 执行。

**目标：** 在正式编辑器开放“导入 CSV / 导出 CSV”，让文件预览、取消、身份校验和当前输入准备走清楚的生命周期；导入只沿 S2 单次插表和原保存通道，下载只包含当前选中表的显示值。

**依据：** 已批准 M5 总设计、P5 设计 §3–§5、S1/S2 已提交实现及 S2 独审。此 Step 不实施新文档创建（S4），不声称真实数组公式计算或所有浏览器故事已验收（S5）。不更改后端 API、编辑权协议、持久化格式、SDK 依赖或质量门槛。

**结构：** `csv-controller.ts` 管理一轮文件/导出操作、AbortController 与预览内存；宿主端口只使用公开 `SheetEditor` 的轻量方法。`edit-mode.ts` 给出绑定当前编辑器、模式代次及原租约的短期目标，`editor-page.ts` 再加入本页会话身份、已知鉴权失败、联网与写许可。`csv-entry.tsx` 使用既有 UI 对话框、文本与焦点规则。CSV bytes 不进 URL、localStorage、日志或独立上传接口。

## 接口与行为约定

- `CsvEditor` 是 `SheetEditor` 中的 `csv/commitCellEditing/settlePanels/settleFormulas/formulasSettled/composing/uncommittedInput` 子集，不暴露 SDK。
- `CsvTarget { editor: CsvEditor, current: () => boolean, writable: () => boolean, formulasPending: () => boolean }`：`current` 绑定原编辑器/文档/模式代次、会话身份；编辑目标还绑定原租约及 writeEpoch。`writable` 动态核对在线、原编辑模式、本机锁、租约、会话确认及保存非终态。普通确认中的临时不可写可保留预览，但确认后只有原目标仍有效且可写才执行；失去身份/编辑权则清掉本轮数据，不能重新拿新实例继续旧操作。
- `CsvController` 提供 `view/subscribe/openImport/openExport/chooseFile/selectSheet/confirmImport/exportSelected/cancel/environmentChanged/dispose`。`view()` 返回稳定的轻量状态：idle、import（selecting/reading/preview/applying）、export（choosing/preparing）、完成/错误说明及可用性；完整矩阵只在控制器私有内存。后续实现可将联合拆为等价小类型，但不得绕开令牌与目标检查。
- `CsvFile` 只消费 `name/size/arrayBuffer`，先核对 5 MiB 再读取；读取晚到与解析让出点都检查本轮 AbortSignal/序号。预览最多 8 行×8 列、每格 80 字符，显示总行列和文件名；不把完整大矩阵交 React。
- 选择、解析失败、解析取消和预览取消不调用编辑器写入/输入提交。确认导入之后才确认会话、提交原用户输入、等待面板与公式；每个 await 之后重新核对原目标，执行前再次检查组字/未提交输入/公式与可写状态。一次确认只调用一次 `csv.insert`。失败不留下 CSV 表或部分内容；已在确认过程中正常提交的用户原输入保留，不回滚、不覆盖。
- 导出先列举可见表并默认选当前表；确认下载时准备当前输入、等待面板和公式，不能把 `formulasPending` 的旧缓存作为完成结果。仍由 S2 读取显示值、S1 编码，随后同步创建下载；文件名由文档/表名称组成并移除路径和控制字符。临时 URL 与 anchor 在成功或异常路径均释放。只读可导出；离线禁止导入，已知会话仍有效时可导出当前本地显示内容。
- 并发点击不启动第二轮；取消/重建/失权/销毁令旧续体失效。业务说明使用固定错误分类，不展示异常堆栈、正文或 SDK 实现信息。CSV 公式保护的 TAB 说明在下载前可见。
- 控制器由页面拥有并销毁；页面更新单向通知 `environmentChanged`，控制器自身订阅不反向触发页面更新。只在用户打开弹窗时列举工作表，避免页头每次刷新扫描 SDK。

### Task 1: 有界 CSV 操作控制器及下载资源

**Files:** 新建 `apps/web/src/features/sheet-editor/csv-controller.ts`、`csv-controller.test.ts`、`csv-download.ts`、`csv-download.test.ts`、必要的 `csv-controller.test-support.ts`；复用 `shared/csv` 与 `editor/index.ts` 的公开类型/错误。

**Interfaces:**
- Consumes: `CsvTarget`、`current: () => CsvTarget | undefined`、`prepareImport: () => Promise<void>`、`title: () => string`、注入的同步下载函数。
- Produces: 上述 `CsvController`；下载函数接收 UTF-8 bytes 与安全文件名，生产实现只调用本页 DOM/Blob URL。

- [x] RED：5 MiB 读取前拒绝；真实 parser 的预览、语法/UTF-8/容量错误、取消及迟到读取；完整矩阵不进入 view。
- [x] RED：无权限/只读/离线不可导入；旧目标失效、身份变更、重复点击、prepare 失败均无 CSV 写入；原输入只在确认后提交，各等待点失效不再写。
- [x] RED：可见表选择、只读/离线导出、公式 pending/超时/组字拒绝，真实 encode 的 BOM/引号/字符串公式保护/负数；下载失败仍清理对象 URL/anchor，取消不下载。
- [x] Run: `python3 tools/test-resources/run.py unit -- pnpm exec vitest run --project unit-web src/features/sheet-editor/csv-controller.test.ts src/features/sheet-editor/csv-download.test.ts --maxWorkers=2`。
- [x] 以单轮 token + AbortController 实现，保持 read/preview 内存只属于本轮；同命令 GREEN。下载工具用小 bytes 与假的 URL 生命周期验证，不生成大型环境。

### Task 2: 正式模式/页面端口与身份失效

**Files:** 修改 `edit-mode.ts`、`editor-page.ts` 及原相应测试；必要时新建 `csv-target.ts` 封装局部目标判定，不把 CSV 状态塞入保存协调器。

**Interfaces:**
- Consumes: Task 1 控制器；`slot.editor()`、原模式 generation、`editing.lease/holdsLock/coordinator` 与页面现有确认机制。
- Produces: `EditMode.csvTarget()` 与 `EditorPage.csv`；类型仅在当前 feature 内使用，平台包不引入 editor。

- [x] RED：reading/正常 editing 可获得相应目标；切换、损坏自检、公式恢复、失权、保存终态不可写；旧目标不能在同模式新实例/新 lease/writeEpoch 上复活。
- [x] RED：页面确认后才导入，签出/换人/禁用/CSRF/离线/卸载与迟到确认不写；同一会话普通确认不错误丢掉预览；导出不发正文保存或新权限请求。
- [x] 接线已有 `confirmForSave` 和 `confirmedForWrite`，不另起认证或编辑权协议。若沿用本页已保存会话身份，局部命名反映整页用途，避免依赖图片渲染状态。
- [x] Run: 受管定向 `csv-controller`、`edit-mode.test.ts`、`editor-page.test.ts`、`editor-slot.test.ts`；保留全部旧断言和时限，必要测试工厂显式提供新能力。

### Task 3: 正式 CSV 弹窗与可访问性

**Files:** 新建 `csv-entry.tsx`、`csv-entry.test.tsx`；修改 `editor-chrome.tsx`、原 UI 测试、`shared/i18n/zh-cn/editor.ts` 及其现有文字出口。

**Interfaces:**
- Consumes: `EditorPage.csv`，现有 Dialog、Button、状态区域和焦点恢复。
- Produces: 页头导入/导出入口、文件选择和有界预览、工作表选择与保护说明、取消/处理中/完成/错误状态。

- [x] RED：可用性、文件选择、预览总行列、确认、取消、换文件重试、错误与完成说明；选择表后只导出所选表。
- [x] RED：键盘/Esc、焦点交还、实例变化关闭或提示失效、处理期间重复点击无效；预览内容仅按文本渲染、不执行 HTML。
- [x] 页面 UI 不抢 SDK 输入焦点，弹窗内输入不被当成表格正文。下载与资源释放经 Task 1 工具，不持久存放 File/矩阵。
- [x] Run: 受管 `csv-entry.test.tsx`、`editor-chrome.test.tsx` 与上述控制器/页面回归 GREEN。

### Task 4: Step 整体验证与接续

**Files:** 必要的 CSV 宿主基本 E2E 故事、Phase 文档和 `reviews/P5-S3-CSV宿主入口复核.md`；详细浏览器矩阵仍在 S5。

- [x] 串行完成定向 lint、全仓 typecheck、受管全仓单元；控制 worker 数、不改范围/断言/超时。核对每轮资源回执及磁盘/系统负载。
- [x] 经项目 `pnpm test:e2e` 入口验证基本故事：取消不写；带旧输入的确认导入、一次撤销/重做、正常保存重开；选表下载、公式保护与只读正文不变。实际命令按既有 fixture/依赖和项目浏览器配置选择，不手工跳过前置。
- [x] 独立代码审查、修复复验，记录真实输入/报告/残留处理；普通 Step 报告按原保留规则，不 pin 全部尝试。中文提交后在同一 P5 分支进入 S4，不合并未完成的 Phase。

## 自审与依赖核对

T1 提供纯操作生命周期 → T2 绑定真实身份/模式 → T3 提供正式 UI → T4 串行验证，输入输出一致。原 CSV 编码/SDK 插入不重复实现；原页面负责身份、原 EditMode 负责租约、原保存通道负责本地与云端状态，没有新上传路径或存储服务。取消仅撤销本次 CSV 意图，不撤销用户先前输入；这与“不覆盖原正文”的要求一致。

本 Step 属于已批准的正式宿主 CSV 接入，不新增跨模块业务协议。若实际集成发现原架构/权限或数据保护结论不成立，按 CLAUDE.md 的高风险规则保存并说明；环境缺口单独记账，产品失败不得以环境为由豁免。S5 必须补真实数组计算后的显示导出，S6 保持完整验收与同 SHA CI。

# P5-S5 CSV 完整故事验证实施计划

> 使用 `superpowers:executing-plans` 在既有唯一 P5 worktree 内逐任务实施。用户已授权自主推进；每 Step 正常中文提交，不另开分支，不重复请求计划审批。

**目标：** 补齐 US-M5-12/13 的生产页面流程、实际公式计算及失败原子性，在三浏览器与生产容器复验。

**架构：** 保留 S1–S4 产品边界及已有探针故事，新增使用文件选择器、真实下载、公开键盘动作、正式 API 与隔离测试库的故事。输入样本和独立字节期望都属于测试，不增加产品入口、测试开关或另一路保存。

**技术：** Playwright、现有受管 E2E/容器入口、既有 sheet/session/database 辅助；沿原浏览器项目、断言与超时。

**依据：** [P5 设计](../05-P5-CSV.md) §3–5、M5 总设计 §6.6；基线 S4 `f9d7579abe9e0ff362426e7cbff5f3888f920382`。

## 全局约束

- 输入/输出各 5 MiB、最终快照 5 MiB、50,000 行、1,024 列、100,000 格、单字段 32,767 UTF-16 单位不变；原精确单元边界保留。
- 新增生产故事不使用 `window.__nerveEditorProbe`、SDK 内部命令或 `@test-build`；原四个带探针故事的标签和断言保持。
- 期望 CSV 为独立的固定 UTF-8/BOM/CRLF 字节，不调用产品编码器生成期望；公式必须实际计算，不能由测试注入结果。
- 每次只跑一轮重型检查，浏览器 workers=1；资源在运行器登记目录中，结束后核对实际清理。最大样本约 3.3 MB，不创建 VM 或完整环境副本。
- 新增覆盖若首次即通过，如实记录“新增覆盖首过”；若发现产品缺陷，先保留失败，再最小修复并回归。不能为了制造 RED 破坏已正确的产品。
- S5 不代替 S6 原完整门禁与同最终 SHA CI；原生环境和 M4 欠账、S4 的 e2e selftest Minor M-01 保持原登记。

## 审查重点

1. 生产自动保存未暂停时，不能把固定 revision 数误当作产品语义；以实际内容、单份文档和重开结果证明（Task 1）。
2. 数组公式的存储锚点与显示溢出不同，旧缓存不能成为导出期望；需真实 Worker/主线程计算且下载完整矩形（Task 2）。
3. 字符少于输入上限，JSON 转义后仍可能超过快照上限；拒绝须保持原正文或零新建（Task 3）。
4. 文件已预览后会话或空间权限可能变化，不能继续使用旧授权；同时保留 S4 未知创建后的原请求核对（Task 3）。
5. 生产构建没有探针；容器通过须来自真正纳入运行的公开故事，不能移除标签后暗用测试钩子（Task 1/3）。

## Task 1: 公开导入、新建与保存往返

**Files:** 新增 `tests/e2e/specs/editor/csv-public.spec.ts`，新增同目录故事使用的 `tests/e2e/support/csv.ts`；保留 `csv.spec.ts` 和 `csv-create.spec.ts`。

**Interfaces:** 复用 `createSheetThroughApi`、`typeInCell`、`saveAndWait`、`savedContent`、`cellOf`、`sheetTab`、`expectFoundOnce`、`pressUniverShortcut`。辅助 `chooseCsv(page, data: string | Uint8Array)` 通过真实 filechooser；`downloadCsv(page, sheetName): Promise<{ name: string, bytes: Buffer }>` 从真实 download 读取临时文件。

- [x] 新增已有文档故事：保留未回车的 D4 文字，导入 `001,=1+2,-12.5,"含,逗号"`；保存核对文本/数字及无 f。公开快捷键一次撤销只去掉新表、正文保留，重做恢复同一表；重开查找和实际下载核对 BOM、TAB 保护与转义。
- [x] 新增空间/文件夹两例：从正常列表入口创建，页面标记证明同页交接；服务端只出现一份、位置正确，保存重开后可查找并下载原数据。不要求生产恰好只有一次自动保存。
- [x] 经受管入口运行 Chromium 本文件，预期 3 项通过；首次通过记新增覆盖，失败先调查，不改原范围。

## Task 2: 真实公式和显示格式导出

**Files:** 新增 `tests/e2e/specs/editor/csv-formulas.spec.ts`，样本置于 `tests/e2e/support/csv.ts`；使用现有 `formula-worker-fault.ts`。

**Interfaces:** 样本从 `sheetSnapshotFor(unitId)` 派生，A1=`SEQUENCE(2,3)` 且旧缓存 999；其他格为格式数字、日期、危险文本、引号换行和正常负数。隔离库将该文档标为 formulas_pending，正式进入编辑触发原强制重算；不在页面注入命令或缓存。

- [x] 普通 Worker 与实际模块加载失败后自动主线程两例；分别核对真实 Worker 或故障请求次数/原退化提示。
- [x] 正式保存后按表导出，独立固定期望包含 1–6 的完整 2×3 溢出、`1,234.50`、`2024-01-01`、TAB 保护和引号/换行；不得含 999 或公式源码。导出前后服务端正文与 revision 不变。
- [x] 受管 Chromium 本文件预期 2 项通过；首次通过记新增覆盖。若实际 SDK 计算行为不同，依据真实证据调整夹具，不能用测试结果生成期望。

## Task 3: 失败原子性、三浏览器与容器

**Files:** 新增 `tests/e2e/specs/editor/csv-rejections.spec.ts`；更新 Phase/复核记录。

**Interfaces:** Task 1 文件/下载辅助；`createTeamSpace`、`createFolderIn`、`actAs`、`anotherDevice` 和真实 session/API。容量样本 100 行，每行 32,767 个反斜杠，文件小于 5 MiB、JSON 候选大于 5 MiB；另有 101×1,000 格小样本及无效 UTF-8 两字节。

- [x] 已有文档：无效 UTF-8、101,000 格及最终快照超限均拒绝；原表、已存正文和 revision 不变，取消后仍可正常保存。
- [x] 新建：JSON 膨胀超限在 POST 前拒绝，创建请求零次、空间文档零份。
- [x] 新建：预览后由真实管理员将编辑者降为查看者，原 CSRF 不变；确认拒绝、零创建。保留 S4 未知创建后的只读重放故事。
- [x] 导入：预览后通过同会话真实退出接口失效登录，确认不能插入新表；另一已登录设备确认原正文和 revision 不变。
- [x] 受管 Chromium 本文件预期 4 项通过。定向 lint、全仓 typecheck；冻结当前输入后，依次运行 CSV 五份 spec 的 Chromium、Chrome、WebKit，workers=1，预期每浏览器 19 首过、零失败/跳过/flaky。
- [x] 串行 `pnpm test:e2e:container -- --grep=US-M5-12|US-M5-13 --workers=1`（实际以 argv 传递），预期 15 个公开故事首过；原 4 个探针故事仍按生产配置排除。
- [x] 核对每轮 cleanupStage/生产者/临时目录，独立 Step 审查，一次重要项修复及回归后正常中文提交；同 P5 worktree 接续 S6。

## Task 4: 已批准的 I-01 报告凭据修复

2026-11-01 用户已批准[调查中的局部方案](../reviews/P5-S5-测试报告环境凭据调查.md)，在同一 P5 分支继续；不再重复请求此范围的许可。Task 3 的功能故事完成，证据收尾在本任务关闭 I-01 后完成。

**Files:** 修正 `tests/e2e/playwright.config.ts`；新增 `tools/src/verify/report-environment.test.ts` 及必要的小型夹具；新增 `tools/test-resources/report_safety.py` 与小型回归，接入原 `run.py` 发布和 `check_ci_resources.py` 上传核验；更新测试资源规范与本 Step 记录。历史处置脚本/索引保留在主目录当前 handoff，原件不入库。

**Interfaces:** 报告检查只读受管 JSON/HTML 报告，拒绝可序列化的非空 `webServer.env`，失败只输出固定原因，不回显环境或正文；不改写报告。现有发布锁、run 锁、身份和句柄检查保持。真实配置回归从隔离的虚构环境启动 CLI，证明服务仍能继承变量、报告不包含 canary；不启动产品数据库或浏览器。历史处置先核对归属/无使用者并落盘清单，再把敏感原件移动到 0700/0600 本机隔离目录；无覆盖、可恢复、独立摘要，脱敏副本不能冒充原件。

- [x] 用真实配置和无秘密 canary 写回归并观察 RED；移除冗余 `webServer.env`，验证 GREEN 与 webServer 的环境继承。检查测量/模板等同源入口，不更改原浏览器、断言、重试或时限。
- [x] 发布保护先写 KiB 级 RED：含环境对象的 JSON/HTML、数组 webServer、异常输入拒绝且无部分发布；无环境对象的正常/失败报告可发布，重复检查无副作用，原件不变。接入本地发布和 CI 最终核验，重跑完整小型清理套件。
- [x] 核对历史 JSON、HTML/压缩件的实际内容关系；登记并受限隔离受影响原件，生成明确标注的脱敏副本和映射。检查本轮 Git/报告发布事实及可取得的历史分发证据；未核实的外传不能称为发生或已排除。
- [x] 定向 lint/typecheck 与小型回归通过后，在固定新输入运行必要的真实 CSV 故事，核对新报告与资源清理；重要项修复不派第二次 Step reviewer，S6 仍做独立 Phase 审查及原完整门禁。安全结果/源码无漂移后正常中文提交。

## 自审

前三个任务分别证明公开入口、真实显示数据及拒绝边界；共用辅助只包含用户动作和样本，不成为另一个产品实现。Task 4 只修实际发现的报告边界；用户已批准，原件与派生件区分保留。S1/S2 已有精确容量/字段/编码边界继续保留，S4 幂等创建和原交接故事仍随五文件回归。完整 API/覆盖率/全 E2E/CI 留给 S6。

# P5-S4 CSV 新建文档实施计划

> 使用 `superpowers:executing-plans` 在同一 Phase worktree 逐任务实施，测试先行；用户已授权自主推进，不另开分支或重复询问执行方式。

**目标：** 在空间/文件夹从 CSV 创建表格；创建前完成解析、预览和候选容量检查，创建后在同一页挂载正式编辑器并沿原保存通道导入。

**架构：** 平台包只生成 `/documents/new/csv?spaceId=…&folderId=…` 链接；既有 editor.html 接收此路由。独立创建控制器拥有本轮内存和幂等创建意图，正式 EditorPage 继续拥有会话、租约、正文和保存；以窄接口交接，不增加上传、存储或权限协议。

**技术：** TypeScript、React、既有 API/RequestIdLedger、S1 编解码、S2 SDK 适配、S3 控制器与正式测试入口。基线 `fbe3341734f4744932eb133d4bc0c83f63754425`。

**依据：** [P5 设计](../05-P5-CSV.md) §4.2 及已批准 M5 总设计 §6.6。S1–S3 已独审接受；S5 全故事和 S6 完整门禁仍保留。

## 全局约束

- 5 MiB 文件/最终快照、50,000 行、1,024 列、100,000 格、32,767 UTF-16 字段预算不变；预览最多 8×8 格/80 字符。
- CSV 内容只在本页内存；URL 只含目标 UUID，不写 localStorage、明文数据库、日志或独立正文 API。
- 平台包无 SDK；同一 editor HTML 内交接，不整页跳转而遗失 CSV。
- 不改变创建 requestId、CSRF、会话或编辑租约协议；不增加依赖，不改旧断言、超时与门禁。
- 成功/失败/中断均由受管入口清理；重型串行、workers 受控。每 Step 通过后正常中文提交，整个 P5 完成前不合并 main。

## 审查重点

- 创建响应丢失、再试及服务端 replayed：沿用原 requestId；重放只提供已创建文档链接，不自动写入正文（T2/T4）。
- 同一用户 CSRF 已变化、换人/签出、晚到读取或创建响应：取消旧内存意图；创建发出后不声称服务端事务已撤销（T2/T3）。
- 创建成功后加载失败、权限变化或保存失败：如实显示已创建和文档入口，应用前失败保留本轮数据供重试；应用成功后不能重复插入（T2/T3）。
- 刚创建的文档在挂载前已经被修改或本页产生输入：原身份、revision=1、未改动的空白模板均须成立；最终同步边界再核对，不能盲目自动导入（T3）。
- 前端和服务端路由一致、目标 folder 属于 space、只读/归档空间无入口、离线禁创建；原平台列表与原文档页不受影响（T1/T4）。

## Task 1: 路由契约与创建前容量检查

**Files:** `packages/contracts/src/documents/csv-create-page.ts` 及测试、contracts 出口；`apps/web/src/editor/csv/new-csv-document.ts` 及测试、editor 出口。

**Interfaces:**
- Produces: `CSV_CREATE_PAGE_PATH`、`CSV_CREATE_PAGE_PATTERN`、`csvCreatePagePath({ spaceId, folderId? })`、`csvCreateLocation(pathname, parameters: Iterable<readonly [string, string]>): CsvCreateLocation | undefined`；目标 UUID 严格核对，folder 省略代表根目录，重复/未知参数拒绝。
- Produces: `assertNewCsvDocument(table: CsvTable): void`；使用真实空白模板、相同类型转换、相同插表 prepare 和 `assertCsvSnapshot` 检查候选，无 SDK 实例和写入。实际应用时仍检查当时完整快照。

- [x] RED：根目录/文件夹往返、错误路径/UUID/重复参数；普通文档路由不被当作 CSV 创建。
- [x] RED：正常/公式形态文本通过、模板不变；CSV 文件本身较小但 JSON 字节超限须创建前拒绝；十万格在既定复杂度预算内通过，真实 SDK 插入候选与预检口径一致。
- [x] 最小实现；受管 contracts 和 unit-web 定向 GREEN，lint/typecheck。

## Task 2: 单轮文件与幂等创建控制器

**Files:** `features/sheet-editor/csv-create-controller.ts`、相应测试/测试工厂；按需从 S3 提取 `csv-file.ts`（类型/文件读取/有界预览），原出口兼容。

**Interfaces:**
- Consumes: 位置、现有 session/adopt/access/create API 端口，`RequestIdLedger`，T1 容量检查；`openCreated(document, owner): Promise<CsvCreatedHost>`。
- `CsvCreatedHost` 提供 `apply(table, current: () => boolean): Promise<boolean>` 和 `dispose()`；成功表示已应用模型，保存结果由正式页头显示；失败允许本轮继续保留尚未应用的矩阵。
- Produces: `createCsvCreation(options)`，`view/subscribe/load/chooseFile/confirm/retry/invalidate/cancel/dispose/hasPendingWork`；view 仅含有限预览、固定说明和已创建文档摘要，不含矩阵或凭据。

- [x] RED：读取前 5 MiB 拒绝、真实解析/候选校验先于 POST；取消/解析失败/超限零创建，重复点击单飞。
- [x] RED：创建前再次核对原用户/CSRF 和目标权限；各等待阶段作废，不能使用新身份继续原文件。
- [x] RED：未知结果原样重试同 requestId、冻结文件/载荷；会话类拒绝不能丢掉旧 requestId；replayed 不挂载/导入。
- [x] RED：创建后加载/应用失败保留数据、提示已有文档且重试不再创建；已应用不重试插入；创建发出后取消/离开提示真实，晚到结果不误报未创建。
- [x] GREEN：沿现有 ledger/API 语义实现；错误不含 CSV 正文；按身份事件和页面销毁释放内存，文件副本不落盘。

## Task 3: 同页正式编辑器交接与创建 UI

**Files:** `csv-create-entry.tsx`、`csv-create-start.tsx` 与测试；`start.tsx`、`editor-page.ts`、`edit-mode.ts`、`csv-controller.ts` 及测试；`shared/i18n/zh-cn/editor.ts`。

**Interfaces:**
- `startSheetEditorPage` 仍服务原入口；新增可释放的挂载句柄供创建后本页重试，页头渲染容器可作为 chrome 的子节点，交互屏障仍覆盖完整 chrome。
- 正式 `EditorPage.importCreatedCsv` 接收矩阵与创建时的文档/用户/CSRF 见证。复用 S3 的输入/会话准备和 S2 单次插表；目标额外证明 revision=1、模板未改、原 SDK/租约仍有效。
- 创建页前期显示选择/预览/确认，后期保留紧凑状态条与文档链接；普通 EditorChrome、保存和离开提示继续生效。

- [x] RED：正式页不同用户/令牌/文档/租约拒绝；已被修改的文档、当前输入与旧续体均不自动导入；仅原新空白实例一次应用。
- [x] RED：创建前取消焦点/返回、键盘文件选择、处理中防重、真实失败提示；创建成功挂载不整页跳转，不把 CSV 放地址。
- [x] RED：尚未展示的挂载失败/晚到实例释放；已打开的宿主由原页面保留正文，应用重试不销毁重建；pagehide 释放文件、晚到异步不重建；原新建/普通文档入口测试保持。
- [x] GREEN：先完成身份和原始空白证明，再调用 S3 的预解析导入窄端口；普通自动/显式保存复用，无另一次 CSV 上传。

## Task 4: 平台链接、真实流程与 Step 收尾

**Files:** `features/spaces/space-page.tsx`/文档入口及原测试；`entries/editor/mount.tsx`、`vite.config.ts`、API web-hosting 路由与测试；`tests/e2e/specs/editor/csv-create.spec.ts`；Phase/复核文档。

- [x] RED/GREEN：可创建空间/文件夹提供目标链接，归档/只读无入口，离线禁操作；平台依赖仍无 editor。生产/开发同路由映射，登录回到安全本地目标。
- [x] 正式 Chromium 故事：创建前错误/取消零文档；空间/文件夹创建后导入、保存重开；丢失创建响应重试只一份且重放不改正文；创建后失败有链接且不重复创建。
- [x] 串行定向 lint、全仓 typecheck、受管完整单元和本 Step Chromium；按 run 原件核对清理、磁盘与负载，输入冻结后独立审查；四项 Important 经 RED/GREEN 修复，输入04 最终回归及原预算通过。
- [x] 正常中文提交 S4，再在同一 P5 分支接续 S5；S5/S6 和原环境欠账不预签通过。详见 [Step 复核](../reviews/P5-S4-CSV新建文档复核.md)。

## 自审

T1 的路径和候选校验供 T2/T4；T2 只通过窄宿主端口把矩阵交给 T3；T3 的页面身份/租约证明与现有保存保持单一归属；T4 检查真实路由和用户链路。创建后的事务不能撤销，未知结果和 replayed 明确区分，不新增“后台重建文档”的隐式行为。以上均在已批准 P5 §4.2 范围内。

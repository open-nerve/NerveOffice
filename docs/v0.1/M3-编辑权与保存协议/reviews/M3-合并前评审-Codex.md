审查者：Codex（GPT-6）｜日期：2026-10-08（Asia/Shanghai）｜范围：`v0.1-m2..eceaa40b31b3dfaf5ca5bbd7a007de01e0040da0`｜结论：不通过

# M3 合并前代码审查

> 本报告先保存已确认发现，再随续审增量补充。仅审查、未修复；问题表的“处理”“复验证据”留给维护者填写。

## 1. 结论摘要

确认 4 条：阻断 1、重要 2、一般 1。CX1 破坏撤权提交与在途保存的数据库顺序保证；CX2 迟到的旧申请响应驱逐新代持有者；CX3 空吊销与首次取钥并发时虚报吊销成功。CX4 面板防抖中的输入既不触发离开提示，页头还显示已保存，真实导航丢失该段修改。尚未修复，不能给出“修复后通过”。

本次审查曾中断一次。中断之前已完成：编辑器单元 26 文件 / 1448 条通过、集成 38 文件 / 1274 条通过、密钥与门禁相关单元 12 文件 / 449 条通过、Chromium 生产节奏（`E2E_AUTOSAVE=running`）选定 E2E 26 条通过；另有 3 个确定交错探针确认以下问题。以上来自保留日志，不冒称续审重新执行。续审新执行：两个HTTP并发探针再次确认（2/2），面板标准事件和真实导航各1条浏览器反例，带数据迁移/进程23条通过，生产前端构建与artifacts门禁通过。完整 verify、完整容器 E2E、真实 Safari 本次未执行。

开始核对：指定 worktree 分支 `m3-p6-local-keys`，HEAD `eceaa40b31b3dfaf5ca5bbd7a007de01e0040da0`；`git status --short` 空；范围共 415 个提交、664 个文件。源码只读；只有本报告可写。执行副本 `/tmp/codex-m3/review`，自建 PostgreSQL 18.6 容器 `codex-m3-review-pg`，端口 55483；不使用开发库 54318、不联网、不访问 GitHub。

## 2. 检查项

以下“静态核对”包括读取测试的实际控制点、服务端内容／修订号／状态断言，不是只检查标题。既有阶段报告是历史证据，不能替代本 HEAD 的完整门禁。

| 模板检查项 | 做了什么 | 结论 |
|---|---|---|
| 正确性与边界条件 | 对照计划书指定章节、r13–r19、M3 总设计与 P1–P6 的实施记录，核对租约、交接、保存、面板输入和密钥并发；运行确定交错探针 | 不通过：CX1–CX4 |
| 模块边界、依赖方向与 SOLID | 核对 documents/workspace/admin/local-keys 的公开入口、全局锁序；保存状态机与 Univer 适配层的边界；主密钥专用配置注入 | 未确认新增模块导入违例；CX1 把数据库保证依赖于页面调用顺序、CX2 把过时授权当现时事实、CX4 缺少面板待提交状态接口，需从协议／状态模型修复 |
| 测试是否充分：单元、集成、E2E 覆盖故事 | 逐条矩阵见下；读取 stories 门禁与真实枚举，恢复旧测试日志，补迁移、进程与浏览器反例 | 正常主链有较多实际断言，但 4 个窗口未钉住；登记 active 不等于验收通过 |
| 安全：鉴权、输入校验、敏感信息 | 本机代码质量审查：租约与撤权事务、快照结构／资源／链接校验、会话再核对、本机密钥配置／包装／日志／审计；无外部系统测试 | CX1 不满足既定撤权提交顺序；未发现新的密钥材料输出问题；CX3 是错误操作反馈，不认定当前草稿泄露 |
| 性能与资源使用 | 阅读子进程池、按账户限份数、保留期清理、实例重建与历史测量；本次生产构建与产物扫描 | 未重跑内存压力、长稳和切换性能；DEF-051/054/058 等维持已登记限制，不据静态检查宣布性能通过 |
| 文档：架构总览、ADR、交接单已更新 | 核对所有指定 ADR 的 M3 内容、P1–P6 设计／审查／交接、Safari 报告与 DEF-042–070 | 核心文档及 6 份 Phase 交接单存在；上层口径、旧充分性结论的异议见 §5；M3 总交接与收尾汇报仍待完成 |
| 每条修复都有变异验证，包括测试前提失效 | 阅读既有报告中变异、存活与补测说明；新探针固定真实事务／响应／SDK 时钟，设正常路径阳性对照 | 本次只读，未修复、未重复全部历史变异；不能替既有每条修复重新背书。后续处理 CX1–CX4 仍需变异复验 |
| 新全局约定逐接口核对，新机制另请复验者 | 分片复核服务端、页面、P6/测试；检查 503、格式门槛、租约结束、密钥版本与构建隔离 | 未创建新机制；CX1/CX2 的全局前提有反例。修复后需独立复核全部入口，不能只补一个调用点 |
| 复验者的复现用例已移入仓库作回归 | 新用例只存在私有副本，完整源码归档在本报告附录 | 未移入产品仓库，遵循本次只写报告的要求；待维护者修复时移入并改为守住正确行为 |

### 2.1 US-M3-01 至 17 的验收证据

路径在本节用仓库相对路径；编辑器 E2E 的短文件名均位于 `tests/e2e/specs/editor/`。状态“有断言”只表示核对过断言的含义；本次实测范围见 §7。

| 故事 | 对验收的逐项核对与证据 | 判断与未覆盖部分 |
|---|---|---|
| US-M3-01 | `edit-mode.spec.ts:61` 读态键入/快捷键无保存、编辑后读回内容、撤销阳性对照与重建后清栈、退出请求序列 `[save, release]`、DB released、每次仅1个Worker；`:136` 新建例外/刷新阅读；`:151` 查看者/归档；`:202` 落后时取最新；`:240/259` 只读入口；`:277` 同表/滚动/选区 | 验收子项有断言；普通主链包含在中断前26条Chromium实测，全部只读入口/视图类仍是历史报告＋静态核对，未重跑三浏览器 |
| US-M3-02 | `autosave.spec.ts:48/78` 1秒捕获、2秒上传、3秒/15秒上限；`:121/143/157` 按钮、快捷键、后台、退出；`:172` 旧确认只覆盖旧序号；`:281` 插件样本自动保存后重开逐内容比较且 unchanged/revision不增；`:316/348/395/453/494` 离线、重试、拒绝与会话；`:436` 离开提示；`:628/640` 面板退出前等待 | **不满足：CX4**。原测试覆盖落模型后的修改与显式退出，漏掉面板尚未落模型的正常离开与虚假已保存。交出保存链另见US06 |
| US-M3-03 | `autosave-formulas.spec.ts` 按独立公式定义核对服务器值，覆盖依赖链/聚合/跨表/SUMPRODUCT/易变、静默期及计算中再改、Worker与主线程、3秒标记/补存/强制重算、组合输入；`formula-rebuild.spec.ts` 检查主线程重建后811个公式 | 有实际断言；真实SDK计算与控制调度时钟分开。三浏览器/真实Safari的完整公式结果采用P4历史报告，本次未重跑；真实操作系统IME不由合成composition事件证明 |
| US-M3-04 | `lease-acquire.spec.ts:57/107/134` 两用户只一成功、查看者仍阅读并显示持有者、同浏览器两页占用/交出；服务端集成核对并发申请与代次 | 基础排他有证据，中断前Chromium已跑。CX2表明页面会错误驱逐新代，不能扩大为“任何乱序都正常”；未证明数据库两代同时能提交 |
| US-M3-05 | `reading-updates.spec.ts:68` 定格时钟→保存→拨30秒，编辑状态请求恰增1、内容请求仍只有首次；点击后带旧ETag、展示新格值、视图保持；后续轮询不取内容；`:137` 隐藏停/可见即查；`:174` 刷新与进入串行；条件读取集成钉304 | 验收有真实请求与内容断言；此组含@test-build，不能以容器排除后的套件声称重新覆盖，当前为静态＋P2历史证据 |
| US-M3-06 | `handover-request.spec.ts:145/166/215` 空闲已有/主动交出/忽略至2分钟均读回双方格值；`:188` 拒绝后不交出；`:231` 取消；`:250` 断心跳/改库到期后新代进入、旧页恢复失权；`:274` 第三人409、请求方回前台进入；`:310` 提示前后焦点不变且继续同格输入；服务端600秒请求TTL、120秒保留另有断言 | 主链有断言；真实Safari“持有者真正暂停→到期”尚无实测（DEF-069），不能用断请求或盖屏替代；请求方隐藏后回来在P6 Safari历史报告已测 |
| US-M3-07 | `handover-idle.spec.ts:53` 页面clock拨10分钟，先保存再DB released且内容存在；`:72` 保存失败不释放、恢复再释放；`:99` 服务端12分钟兜底，人不在不续上/代次不增，有操作再续上 | 有断言；数据库时间由私有测试库调整，页面计时可控，非真实等待10/12分钟 |
| US-M3-08 | `handover-same-browser.spec.ts`、`handover-takeover.spec.ts` 覆盖有响应先存、3秒无响应接手、跨设备、关闭后孤儿租约、刷新在途记号；新反例先真实提交A的N代、延迟回包、B正常接管N+1 | **不满足：CX2**。正常顺序通过不能证明旧成功响应不会驱逐新代；DEF-064的20秒慢保存副本是另一个已接受情形 |
| US-M3-09 | `handover-force.spec.ts:71` 取消不发请求、确认仅force、数据库forced、旧页失权、副本保留旧内容且原文只有新持有者内容、审计holderId；`:131/162` 个人所有者和无权者；`handover-interruption.spec.ts:80/109` 系统管理员重置与停用 | 验收主链有断言；系统管理员“结束”经重置/停用是r14决定，不应要求不存在的单独按钮 |
| US-M3-10 | `handover-interruption.spec.ts:80/109/127` 重置会话有提醒、停用revoked和released无提醒；`:141` 29/31分钟边界、拨时钟后提醒消失；`:162/177` 同人新页/同页及确认焦点；集成覆盖过时代次/空闲/登录失效事实 | 有实际断言；提醒已按r18扩为按事实判断。未实测真实睡眠进程，不能与模拟数据库时间混称 |
| US-M3-11 | `lease-recovery.spec.ts:22/44` 到期/换登录后没人保存即取得新代并读回修改，无失效提示；`conflict.spec.ts`、本人/强制接管链与服务端代次/修订双检查覆盖B保存后A拒绝、副本保留 | 有对应断言，未新增数据库旧代覆盖反例；CX2影响同浏览器接手体验。断网/休眠主要用断请求及改库过期模拟，M4离线恢复不在本次范围 |
| US-M3-12 | `lease-revocation-locks.test.ts` 各撤权入口及存活/自然死亡窗口的确定交错；`edit-mode.spec.ts:372/417` 仍能读时副本位置/标题/内容和重建失败恢复；访问/冲突相关E2E核对降级/移出/取消分享/停用的拒绝 | **不满足：CX1**，明确释放后撤权漏等在途保存。另有“读不到丢弃”与“保留显示但不许副本”的已接受口径差异，列§5异议，不重复计新缺陷 |
| US-M3-13 | 保存实现事务外重放预检→格式→检查池→事务内再查账本；`save-protocol.test.ts`、`request-ids.test.ts` 核对相同requestId原结果、跨两表唯一、权限/代次变化；`lease-recovery.spec.ts:154` `route.fetch`真提交后丢回包，降级仍同requestId重放、只增一次、不假称未存，`:111/134` 心跳/保存两条续上 | 有真正提交后丢回包的断言；本次未重跑完整确认丢失E2E。重放仍要求可读与有效请求身份，不把“先于其余检查”扩成匿名/不可读也可重放 |
| US-M3-14 | `save-protocol.test.ts` 的规则表、合法/不合法对照、不缩水、5MiB/80%、压缩/嵌套/资源/链接/图片；进程池繁忙和隔离测试；`links.spec.ts` 键入/粘贴并保存重开；`save-protocol.spec.ts:170/213` 容量提示与相同内容不加修订 | 对M3表格范围有对应断言；本次未重跑完整畸形快照/内存压力/跨浏览器链接集合。图像与文字文档的后续功能不计缺失，内部部分缩水限制见§5 |
| US-M3-15 | `open-check.spec.ts:113` 模板/六类资源/大表正常阴性对照；`:168` 解析失败/吞空/加载抛错/序列化抛错的只读、无编辑、上报204且不含内容；`:186` edit=new先取后放/无保存/修订不变；`:210` 缺插件与重载再上报 | 明确的三类失败有断言；任意资源内部部分缩水未承诺被算法检出，须收窄总设计文字（P4 B7已接受）；插件启动失败整个编辑器不可用是r17决定 |
| US-M3-16 | `ClientFormatGate` 与申请/续租/保存/副本接口；`save-protocol.test.ts` 检查字段缺失/三种格式差异/构建版本/文档更高SDK/重放先行；`save-protocol.spec.ts:80/105/129/145` 保存、申请、心跳旧页及文档太新终态 | 中断前Chromium4条已实测；普通发布、运维开关有集成断言。DEF-053依赖发版递增、DEF-055未来档案交叉、DEF-070回滚严格解析仍接受；不等于完成M7升级回滚演练 |
| US-M3-17 | `tests/e2e/specs/admin/local-keys.spec.ts:136` 键盘打开确认框、点击确认、版本v2/焦点/审计actor与被吊销v1；另一设备两次心跳v2且仍能保存，再取新字节；密钥包装KAT、配置/会话/并发/启动/日志各有单元或集成 | 正常主链中断前Chromium通过；**边界不满足：CX3**。M3页面不取用草稿密钥的客户端用途在M4，无须为本期缺失加密草稿误报 |

### 2.2 总设计 §4 的每项门槛

| 门槛 | 对承诺的证据判断 |
|---|---|
| A02 保存管道 | `autosave.spec.ts:281` 比对五类非空插件资源、服务端字节/重开规范内容与同内容修订不变；覆盖M3样本，图片已明确排到M5。CX4暴露管道前端输入边界缺口，不能把样本通过扩大为所有输入已完整保护 |
| A04 编辑唯一性 | 并发申请/代次与双用户/多页正常链有证据；CX2不说明数据库排他失守，但页面协议未完整成立 |
| A05 过期旧会话 | 令牌、代次、修订双条件、B保存后A拒绝并副本的链有断言；本期在线部分有证据，不扩为M4离线 |
| A06 撤权一致性 | **不满足CX1**；自然死亡窗口与70秒上界无法弥补明确结束过滤 |
| A07 确认丢失 | 真提交后丢回包、原requestId与账本重放有断言；当前未确认新增问题，完整浏览器矩阵未重跑 |
| A08 保存中继续输入 | `autosave.spec.ts:172` 检查旧确认后仍脏、服务端只有first、再存有second，断言有效；CX4是更早的面板输入尚未入序号缺口，不伪称此单元格断言本身失败 |
| A11 输入与容量 | 校验规则阳性/阴性、压缩与结构上限、链接和80%提示有断言；完整压力未重跑，限频多账户边界DEF-054仍在M7 |
| A13 拦截旧客户端 | 已覆盖本期格式/最低构建与DOCUMENT_TOO_NEW；不能覆盖未进行的升级/回滚演练，已知DEF-053/055/070不重报 |
| A14 体验真实 | **不满足CX2/CX3/CX4**：错误失权、虚假吊销、面板输入时虚假已保存；其他状态/焦点/读屏正常链有证据 |
| A17 插件资源完整 | 客户端三类失败和服务端资源白名单/必须为空/丢整个非空资源有断言；部分内部数据丢失仍非空是已接受的检测限制，不能无限扩大“完整” |
| A18 公式一致性 | 两模式、五类样本、再改/组字/3秒标记/补存/重算有断言与P4历史Safari证据；本次不替历史全量复验，真实IME限制保留 |
| A20 交接规则 | 请求单槽600秒、交出120秒、空闲10/12分钟、异常30分钟、本人/强制接管有证据；**CX2不满足**，真实Safari暂停仍为DEF-069 |

### 2.3 总设计 §8 的八条退出条件

| # | 退出条件 | HEAD 的判断 |
|---|---|---|
| 1 | US01–17本机3浏览器/CI4浏览器全通过 | 未满足：CX1–CX4反例；本次仅选定Chromium，未联网确认CI。历史P6报告的全量结果只适用于其记录的运行 |
| 2 | A02/A04–08/A11/A13/A14/A17/A18/A20验证完成 | 未满足：A06/A14/A20有反例，其余证据界限见上表 |
| 3 | 真实Safari复核完成并报告 | 指定Safari报告齐全，阅读/捕获/同浏览器交接/请求方有历史证据；P6盖屏持有者3次都自动交出，真暂停到期未测（DEF-069、r19明示延期）。只能按此收窄范围认可，不能写成全部Safari暂停场景通过；本次未运行 |
| 4 | verify、CI全绿、容器E2E通过 | 未完成本HEAD的完整复核；本次未跑完整verify/容器、不访问CI；单元/选定集成/E2E与产物门禁不能代替 |
| 5 | Phase报告/交接齐全，合并前审查已处理，延期已登记复核 | P1–P6报告与交接齐全，延期核对见§5；本报告4条仍待处理；P6计划S6第3/4项未勾，M3总交接/收尾汇报未见文件 |
| 6 | 架构总览与ADR已更新 | M3核心内容/ADR019及补充已存在；旧充分性说明需按§5纠正，架构总览页头仍写M3-P5（正文含P6），CI节仍写两个job，与现行三组不一致；不把文档存在等同于全部口径同步 |
| 7 | 计划书已按r13更新 | 有：r13–r19均已记录；CX1/CX2推翻r18中的充分性前提，需要随修复更新论证；US12术语差异仍需对齐 |
| 8 | tag v0.1-m3 | 收尾计划仍待打；本次不创建、不移动tag。本地 `git tag --list v0.1-m3` 为空；这是合并前待办，不另当缺陷 |

总设计八条复选框在 HEAD 仍未勾选，P6交接也把最终门禁/CI留到收尾记录。不能把尚未结束阶段写成伪报完成；也不能因故事全部active便批准退出。


## 3. 问题清单

| 编号 | 严重度 | 类别 | 位置（相对审查 worktree，行号对应 HEAD） | 现象与证据 | 影响与概率 | 建议的改法 | 处理 | 复验证据 |
|---|---|---|---|---|---|---|---|---|
| CX1 | 阻断 | 缺陷 | `apps/api/src/modules/documents/edit-leases.repository.ts:451` | **已实测：真实 Nest HTTP + PostgreSQL**。保存校验完成且仍持文档锁时释放租约，撤权因 `endedAt` 非空跳过文档锁；撤权提交后原保存仍可成功提交。控制点是私有测试库审计 INSERT 触发器中的 advisory lock，保存已写但未提交。 | 违反计划书 §6.4、A06；需在途保存、并发释放和撤权三者交错，概率低但影响提交一致性。 | 文档锁候选必须覆盖可能仍有在途保存的明确结束租约；在统一锁序下证明结束、撤权、保存三方互斥，补确定交错回归。 | 属实（阻断），主会话对照代码核实：保存在文档行的锁下不加锁地读租约，依据是"让租约失效的写都先锁文档行"，释放与交出只锁租约行打破了它；撤权"明确结束了的不锁"靠的是页面"先存上再释放"。已修（`6fdfd053`、`4706826d`，合并 `158fb038`；注释 `eb7174cb`）：释放与交出与申请、撤权一样先锁文档行、再锁租约行，明确结束与在途的保存互斥；结构上用类型凭据——`lockById` 给出 `LockedDocumentRow`，`lockUnder` 只凭它给出 `LockedEditLease`，`end`、`handOver`、`endAll` 只收 `LockedEditLease`，`replace` 只收 `DocumentRowLock`，以后的结束路径不先锁文档行就过不了类型检查；撤权不锁明确结束了的改由锁保证；释放先不加锁判断，释放不了的不取锁（同 M2 复验 RA7）。文档：P6 设计 §3.13，P5 设计 §3.5，ADR-014、ADR-018，计划书 r20 §6.4，规范 §5 | 评审的交错改写为 `lease-revocation-locks.test.ts` 的回归（释放、交出各一条：与随后的移出空间都停在锁上，保存提交之前租约没结束、他还是成员，之后照常结束、撤权不再收回）、锁顺序两条、释放不了的不取锁，四条在旧实现上失败；独立复验逐个核对改写有效性的入口都先锁文档行、锁序只有"文档行 → 租约行"一个方向，撤回修复之后 4 条失败；变异：修复者 13 条全部认出（含 3 条类型层面、3 条前提失效），复验者另做的认出；全量集成 96 个文件 4766 条、E2E 三个浏览器 1140 条通过 |
| CX2 | 重要 | 缺陷 | `apps/web/src/features/sheet-editor/edit-mode.ts:1013`；`:1027`；`:1456` | **已实测：真实 Chromium + Nest + PostgreSQL、原生 Web Locks**。A 的 N 代申请已提交、成功响应被延迟；B 正常 UI 接管至 N+1 后，A 的旧响应无条件 steal，B 错误进入失权状态。私有 E2E 期望 B 的保存按钮保留，实际消失；另有状态机单元反例。 | 同浏览器遇响应乱序时驱逐合法持有者、需要副本恢复；未证明旧代能覆盖数据库。 | 抢本机锁前后核对服务端当前代，失锁页也核对事实；让旧响应失效而不是把成功回包等同于当前授权。补真实响应乱序回归。 | 属实（重要），主会话核实：页面把申请成功的回包当成"本页这一代此刻仍是当前的"、把本机锁被抢当成"本页这一代已经失效"，回包乱序时两个推断都不成立。已修（`384298cb`–`821a0933`，合并 `f87defa2`；复验之后 `bb04eb06`、`5aefa967`、`c17a2bb8`（`cd0f32bb`）、`644cdaff`、`e3cf5b5d`（`8f467a57`）、`c3a3f6dd`（`c83f5264`））：本机锁的争用一律以服务端的事实裁决——租约加只问不改的 `confirm`（`current`、`superseded`、`ended`、`unknown`）与带发出时刻的 `onRenewed`；`local-lock.ts` 拿锁时被占着先核对、是当前的才抢；被抢之后先核对，令牌对不上（`taken_over`、`replaced`）才失去编辑权，这一代自己失效的交给租约已有的失效处理，核对不了的不持有锁、只认被抢之后发出的续租；核对得到失效时等本页在途的续上，本页有结果未知的申请时 `replaced` 交给租约。文档：P6 设计 §3.13，P5 设计 §3.1、§3.7，ADR-018，计划书 r20 §7.5，DEF-041 | 评审的复现改写为 `handover-same-browser.spec.ts` 的正式用例（A 回到阅读、说本浏览器的另一个标签页在编辑，B 照常保存），三个浏览器、两种打开状态通过；撤回修复之后它与"断网时被抢"的用例 6/6 失败；单元：本机锁 33 条、核对 38 条、编辑模式的本机锁 48 条、回包乱序 16 条（复验的探针 X1、X2、X3、X6 都收成正式用例）；独立复验三轮（初复验与复验之后的三轮）都"通过"，提出的 E1–E3、E8、E9、E11 都已修复；变异：修复者 27 + 19 + 12 + 7 条全部认出，复验者另做的除近似等价的几条外都认出 |
| CX3 | 一般 | 缺陷 | `apps/api/src/modules/admin/admin-users.service.ts:146`；`:170`；`apps/web/src/features/admin/users-page.tsx:271` | **已实测：真实 Nest HTTP + PostgreSQL；UI 文案静态确认**。空吊销 UPDATE 后、摘要 SELECT 前，用户首次取钥提交 v1；接口返回非空 v1，UI 据此声称已吊销并换版，库中却无吊销与对应审计。 | 窄并发窗口导致管理员收到虚假成功；M3 尚无加密草稿消费，不能据此声称当前草稿泄露。 | 响应明确区分本次操作结果与当前摘要，UI 根据操作结果显示 no-op 或成功。 | 属实（一般），主会话核实：吊销的响应只有操作之后读的账户摘要，页面从现状推断吊销了没有。已修（`51f55ee0`，合并 `158fb038`；页面用例 `ca5b9c12`）：响应分成 `revoked`（这一次的结果：吊销了哪一版、换成了哪一版，没有可吊销的为 null）与 `account`（账户的现状）；结果直接来自吊销、审计与它一致；页面按结果说话（"吊销的那一刻 {name} 还没有本机密钥，没有吊销任何密钥。"），按现状换上这一行。文档：ADR-019，P6 设计 §3.5、§3.8，计划书 r20 §7.6 | 评审的交错改写为 `local-key-races.test.ts` 的回归（语句级 AFTER UPDATE 触发器作闸门：结果为空、现状第 1 版、没有审计、第 1 版没被吊销），旧实现上失败；页面用例拦住刷新、钉住先按现状换上这一行（复验的变异 K1 认出）；US-M3-17 的 E2E 三个浏览器、`E2E_AUTOSAVE=running` 下通过；变异 8 条全部认出；独立复验确认响应、页面说法、审计三者一致 |
| CX4 | 重要 | 缺陷 | `apps/web/src/features/sheet-editor/save-coordinator.ts:383`；`:714`；`apps/web/src/editor/panel-debounce-watch.ts:65` | **已实测：真实 Chromium + Nest + PostgreSQL，生产自动保存节奏**。数据验证面板把已有规则100改250，SDK防抖尚未写模型时，beforeunload 未被阻止，页头仍为“已保存到云端”；第二轮真实导航无提示且服务器仍100。第一轮恢复计时保存得到250为阳性对照。 | 约1秒的普通离开窗口已实测漏提示并丢失未提交修改，关闭/刷新同根因静态确认，批注有同根因300ms静态路径；影响未保存修改，违反US-M3-02/A14。 | 适配层向保存协调器暴露面板待提交状态及变化通知，纳入脏状态与离开提示；显式保存、后台捕获与交接统一处理此状态。 | 属实（重要），主会话核实：保存的状态机只把单元格里没提交的输入算作未保存，面板防抖中还没写进模型的输入它看不到。已修（`d9498217`–`1d87fc00`，合并 `39840b8a`）：适配层把还没写进模型的输入（单元格编辑器里的、批注与数据验证面板防抖中的）合成一个状态 `uncommittedInput`（`pending`、`open`、`none`）连同变化的通知交给保存的状态机——页头、未保存与离开提示都算 `pending`，期间到来的旧确认不说已保存，写进模型之后由修改序号接着算，到点没有改动时清除；`SheetEditor` 去掉 `hasPendingCellInput`、`onCellEditingChange`；自动保存的节奏与先等面板照旧。文档：ADR-010，P4 设计 §3.4，P4 审查报告与交接单，计划书 r20 §7.3、§7.7 | 评审的两条改写为 `autosave.spec.ts` 的正式用例（防抖中的离开提示与页头、期间到来的旧确认、真实导航的离开提示），另加批注 300 ms 与到点没有改动两条；三个浏览器、两种打开状态通过，撤回修复之后 12/12 失败在缺陷那一行；变异单元 21 条、E2E 4 条全部认出；独立复验另做"面板关上之后不误报"的探针通过，接受的两处保守（面板开着时页头之外的任何输入都算、点"添加批注"之后的 300 ms）站得住 |

## 4. 问题详细说明

### CX1：明确结束租约让撤权跳过仍在途的保存

确定顺序：开始保存并通过租约/权限校验 → 在写事务内、已写修订但审计 INSERT 前暂停（尚未提交） → 真实 HTTP 释放租约成功 → 真实 HTTP 移出空间成功 → 独立连接确认旧修订仍在 → 放行保存，返回成功且修订递增。现有自然死亡与最近 70 秒窗口测试没有覆盖 `endedAt` 分支。交出具相同静态过滤条件，本次未实测，不视为同等证据。

中断前探针：`tests/integration/src/documents/codex-server-release-revocation.test.ts`（仅私有副本）。完整重建代码和命令见附录 A；删除全部临时目录后仍能按本报告重建。

证据范围：只在本机私有测试库加审计触发器，以数据库 advisory lock 挂住尚未提交的保存；生产源码未改。锁等待辅助核对请求确实还停在锁上，所以不是靠sleep猜先后。此例以错误行为为预期，测试显示“通过”正是反例成立。续审再次运行2个HTTP探针中的本条通过。

精确触发点：`edit-leases.repository.ts:455/460` 第一轮候选排除已结束；`:435` 注释给出页面先后假设；`edit-lease.service.ts:328/330`释放只取租约锁。虽然正常退出编辑会先等保存，服务端释放接口可独立并发，且页面`edit-lease.ts:498`格式不兼容与`:513`换登录恢复存在先释放的入口；后两入口仅静态线索，不冒称已按完整UI链复现。已经持文档锁的删除/移动等入口不能仅据共享过滤器推定同样绕过，需逐入口验证。

严重度依据：A06是本阶段明确的数据库质量门槛，现有接口三方交错即可反证，故阻断合并。建议分开“为等待保存锁文档”和“实际将活租约标记撤权”的候选条件；无论选近期明确结束窗口还是令释放共用文档锁，都须审查全局锁序与70秒界限。不能只加页面等待补丁。

### CX2：旧申请成功响应抢走更新代的本机锁

对 A 的申请用 Playwright `route.fetch()` 先执行真实服务端事务，只延后 `route.fulfill({response})`。在同一 browser context 打开 B，用正常“在此编辑”按钮取得更新代并编辑，再送达 A 的旧响应。B 被错误驱逐。未伪造成功响应，未模拟 Web Locks。

中断前探针：`tests/e2e/specs/editor/codex-stale-acquire.spec.ts`（仅私有副本）；日志 `/tmp/codex-m3/e2e-stale-acquire.log`，1 条失败，断言位置 62 行。完整重建代码和命令见附录 A；删除全部临时目录后仍能按本报告重建。

失败产物还明确显示B：“编辑权已失效：你在本浏览器的另一个标签页接手了编辑。本页的修改没有保存：可以另存为副本，或者放弃这些修改”，并出现副本/放弃按钮；所以不是仅凭按钮消失推断。源代码`:1013`抢锁、`:1032/1033`放弃租约并进入lost、`:1456/1457`在申请成功后走这条路径。既有`edit-mode.test.ts:2576`将“新批准意味着那页已失效”作为前提，`:2590`测试失权消息先到而不是旧成功响应晚到，均未覆盖本例。

建议由服务端代次和本机持有者身份共同决定是否接管，失锁方依据事实决定终态；把“批准→收到成功→拿本机锁”之间可再次换代纳入协议。至少补两页响应乱序、三页再次换代、关闭/刷新和正常先存交出回归。此处不提供未经实现验证的完整算法。

### CX3：操作结果被后读的密钥摘要覆盖

用户从未取钥 → 管理员吊销的真实 UPDATE 返回 0 行 → 在 `view()` 前暂停 → 用户经真实接口首取提交 v1 → 继续摘要查询 → 返回 v1；再次取用仍是同一把、`revoked_at` 仍为空、吊销审计 0 条。探针只控制仓储边界，数据库操作、Nest 路由与事务是真实的。UI 只以摘要非空推导成功属于静态确认。

中断前探针：`tests/integration/src/local-keys/codex-keys-revoke-first-fetch-race.test.ts`，日志 `/tmp/codex-m3/keys_tests/race.log`，1/1 通过（断言钉住错误行为）。完整重建代码和命令见附录 A；删除全部临时目录后仍能按本报告重建。

首取外键的 `FOR KEY SHARE` 与管理员账户 `FOR NO KEY UPDATE` 相容，故这段并发能真实提交，并非不可能的夹具状态。现有 `local-key-races.test.ts:292` 将首取提交安排在吊销响应之后；`local-keys.test.ts:241`空吊销为串行；US17先有v1才吊销，三者均未覆盖判空与摘要之间的提交。本条不反对已接受的“未提交首取不阻塞吊销”线性化选择，只反对从随后最新摘要推断本次操作成功。

建议契约返回明确的本次操作结果（如是否吊销、被吊销/新版本），账户摘要只作当前视图；页面依据操作结果报告no-op/成功，审计与其一致。严重度为一般：本期直接影响操作反馈，未来M4使用密钥时风险扩大，但不以未来草稿后果夸大当前事实。

### CX4：面板防抖期间漏离开提示且虚报已保存

续审新增实测：`E2E_AUTOSAVE=running`；已有规则100并确认保存干净，然后 Playwright 时钟冻结，仅经UI将数值改为250，派发可取消 beforeunload；`promptBeforeDebounce=false`，`saveStatusBeforeDebounce=已保存到云端`。恢复时钟并显式保存，数据库得到250的阳性验证先通过，最后应提示离开的断言失败。第一轮派发标准事件；第二轮以同样UI输入在防抖窗口内真实 `page.goto('/')` 离开，结果 `dialogs=[]`、导航成功，服务端仍是100，确认普通主动离开无提示且未保存这段修改。两轮分别使用新建专用库并清理。控制点是SDK防抖计时器。批注同根因未实测。

现有 `autosave.spec.ts:628/640` 的批注/规则用例改完立即“退出编辑”，显式等待 `settlePanels()`，不覆盖普通导航；`:172`保存中继续输入测的是已经入模型的修改。`panel-debounce-watch.ts:65`已经知道 pendingUntil，但`sheet-editor.ts:464`只暴露异步等待；`save-coordinator.ts:383/714`的脏判断未包括它，`page-guards.ts:31`因而不阻止离开。数据验证1000ms窗口真实实测；批注300ms同根因只静态确认。

建议适配层暴露可订阅的“面板尚未落模型”状态，纳入保存状态/同步离开守卫，待模型落地且对应序号获服务端确认后再清除，避免旧保存确认把后来面板输入标为已保存。保留显式保存/重建的等待规则。新增回归应含“控件已变但changeSeq未变”、旧确认到来、真实导航，以及模型落地后的正常自动保存。

## 5. 对已有结论的异议

以下针对结论的范围或已接受决定，不再另列 CX 编号。

| 已有结论／决定 | 本次异议及处理建议 |
|---|---|
| P5 撤权修复、ADR-014:105、ADR-018:103、计划书§6.4/r18：“刚死不久仍锁”加70秒上界足以维持撤权保证 | 论证只覆盖按时间死亡。CX1的明确结束分支仍被第一轮过滤，客户端“先保存再释放”不能充当数据库保证。保持DEF-044的历史规模优化目标，但把近期明确结束且仍可能在途的事务纳入证明 |
| P5审查报告和设计、计划书§7.5/r18：“服务端批给本页，另一页的租约必然失效” | CX2推翻把成功响应等同于当前授权的前提。服务端批准先于响应到达，中间可以再换代。应按代次设计本机锁协调／失锁核对，并覆盖响应乱序；不能把单次无锁GET再检查简单当成完整证明 |
| P4审查报告“面板防抖与组合输入都守得住”；P4设计与交接的“关页靠离开提示” | 显式保存和退出编辑等到SDK防抖，不代表同步离开提示也看到了待提交输入。CX4表明保护链在进入模型之前断开，应扩大模型边界及回归测试 |
| P6审查报告“第一次取用的并发”“从没取过”的正确性已覆盖 | 原首取并发测试让首取在吊销响应后提交；CX3是UPDATE判空后、view查询前提交。应区分操作结果和最新摘要，正常吊销的锁序/KAT/隐私证据不受此反例否定 |
| 总设计§2.1/US12“读不到就丢弃”，P2§3.4与ADR-018“404仍保留本页显示但不能副本” | 下层决定已接受，本次不把它当新缺陷。上层仍有不一致：应明确M3内存显示的保留及关闭后消失，和M4本机记录删除的关系；不要写成当前已彻底擦除已显示内容 |
| US15/上层“加载后资源缩水”；P4 B7接受“同一个资源内部部分丢失但仍非空不报” | 接受项限定了检测能力，但宽泛措辞容易被误读为任意内容完整性保证；服务端资源名/白名单/结构规则也不是任意内部语义丢失的最终兜底。应把“整体消失/空化”和“内部部分损失”分开写。无新的实测内部损失，不重报 |
| P6检查项“真实Safari的请求编辑两条路”及DEF-062关闭 | 必须连同报告正文读：路1是真Safari后台请求者；路2盖屏后三次仍续租、走空闲自动交出，未证明真暂停到期。P5/P6设计、DEF-069、r19已正确吸收；本次不提出重复缺陷、不要求运行Safari |
| stories全部active／历史通过即本HEAD已完成 | 门禁证明有对应可执行测试类别和标题，不检查验收语义；阶段报告未宣称最终收尾已完成。当前完整门禁、修复复验、M3总交接/汇报/tag仍待做，见退出矩阵 |
| 架构总览的“当前进度”与CI描述 | `docs/architecture/overview.md:3`页头仍M3-P5，正文含P6；§6写两个job，实际`.github/workflows/ci.yml:27/88/154`是verify、e2e矩阵、container。属于文档旧摘要，纳入收尾同步，不提升为产品缺陷。ADR-015旧分块名/17KB例子也应按当前构建更新，但本次实测两构建的首屏模块集合一致，不认定隔离失效 |

### 5.1 DEF-042–070 的已知背景与本次判断

| 登记 | 状态／目标 | 本次判断 |
|---|---|---|
| DEF-042 | 已完成/P5 | 孤儿租约由本人接管处理；CX2是成功响应乱序，非本项重报 |
| DEF-043 | 已完成/P2 | 后台编辑状态/续租不顺延登录，P5请求续期亦为后台；保存是用户活动 |
| DEF-044 | 已完成/P5 | 自然死亡筛选和等待窗口已落地；CX1是遗漏的明确结束分支 |
| DEF-045 | 已完成/P4 | 共用重试状态接线作为背景，未发现新反例 |
| DEF-046 | 已完成/P3 | 目标子文件夹首次失败的重试已补，未重报 |
| DEF-047 | 已完成/P3 | 登录原因初始焦点，随DEF-048后续调整，未重报 |
| DEF-048 | 已完成/P6 | 登录说明/错误分离有单元/E2E，未确认新问题 |
| DEF-049 | 已完成/P6 | 目标位置相关焦点有单元/E2E，未确认新问题 |
| DEF-050 | 待处理/M7 | 当前修订全局不变量未纳入；保留期专项断言不等于所有用例扫到，沿用限制 |
| DEF-051 | 待处理/M7 | 保留期扫描历史当前行的成本，需负载实测；本次无推翻延期的新证据 |
| DEF-052 | 待处理/M5 | 校验原因缺格子位置，随链接/图片入口补；不误作M3新缺陷 |
| DEF-053 | 待处理/M8 | 最低构建开关依赖发布递增，属于发布流程条件，A13结论必须保留此条件 |
| DEF-054 | 待处理/M7 | 每账户2份不能防多个账户占满；请求频率在压测后定，不能把当前配额描述成完整限频 |
| DEF-055 | 待处理/M6 | 档案与文档类型未交叉核对，当前只有sheet@1，接受当前范围理由 |
| DEF-056 | 待处理/M5 | SDK数据验证空闲回调在销毁后拒绝，位置/现象已有登记；不展开第三方修复 |
| DEF-057 | 待处理/M5 | SDK Ready前销毁的未处理拒绝已有登记；不重复 |
| DEF-058 | 待处理/M7 | SDK空闲/rAF循环可能累积，历史切换测量不能证明无限长稳；本次未定量 |
| DEF-059 | 待处理/M4 | 无引用样式导致撤销后多一个修订，非数据丢失，规范化变更随M4 |
| DEF-060 | 待处理/M7 | 首屏入口下载失败空白页是已知弱网限制，未重报 |
| DEF-061 | 待处理/M5 | 损坏文档恢复入口依赖历史版本；当前只能阅读/复制可见内容，接受阶段范围 |
| DEF-062 | 已完成/P6，拆出069 | 只按真实观测的两条实际路径认可关闭，不扩大成暂停到期实测 |
| DEF-063 | 待处理/M7 | 单一读屏状态区整段重播，需真读屏验证；本次无VoiceOver/NVDA结论 |
| DEF-064 | 待处理/M4 | 同浏览器20秒总预算可能迫使慢保存走副本；与CX2旧响应抢新代不同 |
| DEF-065 | 待处理/M7 | 主密钥轮换运维命令，当前数据模型留了标识；未重报 |
| DEF-066 | 待处理/M7 | 批量作废，当前逐人吊销；CX3独立影响单次结果，不否定范围决定 |
| DEF-067 | 待处理/M7 | 恢复备份须重做之后的吊销，不能把擦当前行说成历史备份擦除 |
| DEF-068 | 待处理/M7 | 字符串/转储不能清零的限制透明，Buffer清零不能替代部署转储策略 |
| DEF-069 | 待处理/M7 | 真Safari暂停/最小化/跨保留期等未实测，已回写r19，保留明确限制 |
| DEF-070 | 待处理/M7 | 回滚严格响应解析不兼容已有登记；本次没有升级/回滚演练，不重报 |

另沿用各阶段§7/审查“不改”的决定：P4 B7资源内部部分缩水、立即捕获保守带公式标记、Retry-After上界及会话持续失败退避；P5 B12三页瞬时占锁与20秒预算；P6 B8审计明细记被吊销版、D4无反应按文字比对、O1审计事务开始时间可能与吊销版本先后倒置。未发现新的证据足以推翻这些决定。CX4只改单个规则值，区别于UR-033的两类更新共用SDK防抖；本报告不展开上游缺陷的实现细节。


## 6. 覆盖限制

- 本次为上述范围的定向审查，按设计承诺、实际断言与跨模块链路取证；不声称逐行穷尽664个文件或重新验证所有历史变异。指定Phase设计的实施/接受项、审查/交接和ADR由对应分片补读；中断前截断的关键规则在续审补读，不依赖被截断的输出认定通过。
- 未执行完整 `pnpm verify`、完整容器E2E、网络依赖audit、CI、真实Safari、全部三浏览器E2E、性能/内存/长时间运行测试；不访问GitHub，不拉取镜像/依赖。生产构建和artifacts门禁是本机静态产物验证，不能代替生产镜像端到端。
- 中断前38文件/1274条集成日志只保留聚合，不带文件清单，不能据此宣称每一组专项都实际跑过；本轮用明确命令补了有数据迁移、API进程和两个确定并发探针。旧编辑器26文件/1448条也只按聚合计，不据此逐文件背书。
- 新浏览器探针只跑Chromium；CX2/CX4对Chrome/WebKit的同根因是静态可达性判断，尚未独立实测。CX4批注300ms入口仅静态确认。CX1真实HTTP只复现释放＋移出空间，同一筛选器的其他撤权范围、交出入口不得写成逐个实测。
- CX3实际复现接口/数据库/审计；管理员错误文案由当前前端分支静态推出，未另做UI并发测试。M3尚无本机草稿，不宣称现有草稿泄露。P6的独立Python/OpenSSL KAT复算来自既有报告，本次没有再次独立复算。
- Safari历史报告中的组合输入是合成事件，不能替代真实输入法；遮挡不等于进程暂停。M4发件箱/写入栅栏/离线草稿、M5图像与历史、M6文字、M7运维不在本次实现验收范围。
- 探索但未升格：非有限JSON数值的语义、会话在事务最后一次核对后被撤销、心跳等待锁的事务时间、SDK长期回调累积。未形成满足真实输入和上层承诺的反例，不计入问题数，也不作为新增阻断项。
- 所有探针只改变私有测试数据库/私有副本（如CX1审计触发器），没有改变被审代码。附录含复现源码及控制点，便于将证据迁移到正式回归测试。

## 7. 运行过的命令与结果

执行环境：Node v24.21.0、pnpm按仓库锁定版本、Vitest 4.1.11、本机Chromium、PostgreSQL 18.6。全部运行目录在 `/tmp/codex-m3/review`；E2E命令在其 `tests/e2e` 下。`NERVE_TEST_DATABASE_URL` 始终显式指向自建容器的 `127.0.0.1:55483/postgres`，没有使用默认54318。每个集成文件/E2E运行按仓库辅助独立建库并清理。

| 时间段 | 命令／运行及证据位置 | 结果与口径 |
|---|---|---|
| 开始 | 指定worktree执行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`、`git rev-list --count v0.1-m2..HEAD`、`git diff --name-only v0.1-m2..HEAD` | 干净；分支/HEAD正确；415提交、664文件 |
| 中断前 | 后端构建，`/tmp/codex-m3/api-build.log` | tsc + nest build完成；日志未留退出码，不补造精确启动命令 |
| 中断前 | 前端测试构建，`/tmp/codex-m3/web-build.log` | dist-e2e构建完成；不是生产构建，不替代续审生产构建 |
| 中断前 | 编辑器单元，`/tmp/codex-m3/editor-unit.log` | 26文件/1448条通过，10.73秒；原完整选择命令未保留 |
| 中断前 | 集成，`/tmp/codex-m3/integration.log` | 38文件/1274条通过，40.48秒；原文件选择未保留，不推定全套通过 |
| 中断前 | 密钥/配置/日志/门禁/构建插件单元，`keys_tests/unit.log`、`unit-retry.log` | 首轮448/449，唯一失败为临时clone缺main ref；设 `GATE_MIGRATIONS_BASE=v0.1-m2` 后12文件/449全通过，属于复建环境基准修正 |
| 中断前 | `GATE_MIGRATIONS_BASE=v0.1-m2 pnpm gate stories migrations`，`keys_tests/gates.log` | exit0；42故事、M3的17条active；12419个被枚举的测试含私有探针，不能当仓库原生用例总数；迁移基准22/当前27通过 |
| 中断前 | `E2E_AUTOSAVE=running`、Chromium选定现有E2E，`e2e-running.log` | 26条通过，约1.3分钟；涵盖edit-mode/lease-acquire/same-browser/save-protocol/admin-local-keys的日志所列场景。测试构建以生产节奏运行，不是完整生产镜像验收 |
| 中断前 | `codex-stale-acquire.spec.ts`，`e2e-stale-acquire.log`；对应状态机单元反例 | E2E 1失败（应留编辑，实际错误失权）；真实浏览器＋服务＋DB。单元为真实状态机＋仓库fakeBrowser，不能把fakeBrowser当原生Web Locks |
| 中断前及续审 | 两个HTTP并发探针（CX1/CX3），旧 `keys_tests/race.log` 与新 `continued-confirmed-probes.log` | 续审21:19:43，`pnpm exec vitest run --project=integration tests/integration/src/documents/codex-server-release-revocation.test.ts tests/integration/src/local-keys/codex-keys-revoke-first-fetch-race.test.ts`：2文件/2条通过，1.99秒；通过的是对错误行为的断言，不表示产品符合设计 |
| 续审 | `pnpm --filter @nerve-office/web run build`，`keys_tests/production-build.log` | exit0，1.44秒，生产dist；仅Vite大分块提示 |
| 续审 | `pnpm gate artifacts`，`keys_tests/production-artifacts.log` | exit0，178文件、扫描174、按来源核对170脚本、108第三方包；静态扫描列出的主机名不是发出网络请求 |
| 续审 | 比较dist与dist-e2e manifest静态imports闭包及module-sources集合 | 平台均221模块、编辑器均839模块，差集为空；分块数不同不构成测试专用模块泄入 |
| 续审 | `pnpm exec vitest run --project=integration tests/integration/src/database/migrations-with-data.test.ts tests/integration/src/api/process.test.ts`，`keys_tests/migration-process-continued.log` | 21:17:01，2文件/23条通过，9.90秒；14个带数据历史基准涵盖0021→0022至0025→0026及9条进程测试；0026→当前只是当前幂等，不虚称未来迁移 |
| 续审 | `E2E_AUTOSAVE=running pnpm exec playwright test specs/editor/codex-panel-beforeunload.spec.ts --project=chromium --workers=1 --grep '尚未结束防抖'`，`editor/panel-beforeunload.log` | 1失败，仅最后应提示断言false；100→250阳性持久化先通过 |
| 续审 | 同命令改 `--grep '真实导航'`，`editor/panel-navigation.log` | 1失败，仅最后期望beforeunload对话框未出现；导航成功、服务器仍100，确认CX4。两次服务退出0并删库 |
| 收尾 | 源与私有副本Git状态、引用行号核对、正文结构与附录检查、自建资源清理 | 见§8；不运行有网络步骤的完整verify或audit |

上述分组重叠，不合计成“通过N条不重复测试”。失败探针是本次审查发现的证据，不隐藏成环境失败；历史环境失败也不归为产品缺陷。


## 8. 结束核对

结束核对（2026-10-08，Asia/Shanghai）：

- `git branch --show-current` → `m3-p6-local-keys`；`git rev-parse HEAD` → `eceaa40b31b3dfaf5ca5bbd7a007de01e0040da0`，与开始一致。
- `git diff --exit-code` 与 `git diff --cached --exit-code` 均 exit0；`git -c core.quotePath=false status --short` 唯一输出为 `?? docs/v0.1/M3-编辑权与保存协议/reviews/M3-合并前评审-Codex.md`。未提交、stash、切分支或修改产品文件；未在主目录执行操作。
- `git tag --list v0.1-m3` 无输出，本地尚无该tag。
- 所有E2E专用库已随服务退出删除；删除容器前再次查询，无 `nerve_e2e_*` 与运行中的测试客户端，只剩集成迁移模板库。
- 执行 `docker rm -f -v codex-m3-review-pg` 成功，随后按名称查询容器及其匿名卷均无输出，模板库也随卷删除。未创建审查专用镜像；原有 `postgres:18.6-alpine` 为其他既有容器共用，`nerve-office:test` 为此前镜像，均未删除。没有碰开发库54318及其他容器。
- 保留 `/tmp/codex-m3/` 的私有副本、日志与失败产物供维护者核查；本报告已嵌入所有核心复现代码，证据重建不依赖它们继续存在。
- 最终报告校对：4条问题各自的证据等级/控制点/影响/建议齐全；处理与复验证据列均为空；17故事、12门槛、8退出条件、DEF-042–070及4份完整探针均存在。

## 附录 A：可独立重建的完整探针

下面四个源码块存到各自标出的相对路径，即可在该HEAD的新私有副本重建，不需要保留原 `/tmp/codex-m3/`。沿用该HEAD测试辅助，所以请使用此提交的仓库和离线可用的锁定依赖/浏览器；不需要改生产实现。注释及测试名称作了中文整理，控制点和断言不变。

环境复建示例（本地已有镜像与依赖，不下载；所有命令在新私有副本，不能在被审worktree/主目录执行）：

```sh
# 已在私有副本，并准备好本地缓存的依赖与Playwright Chromium。
# 从本机已有镜像创建独立维护数据库；端口由Docker挑选。
docker run --pull=never --name codex-m3-replay-pg -e POSTGRES_PASSWORD=codex_m3_replay_only -p 127.0.0.1::5432 -d postgres:18.6-alpine
# docker port codex-m3-replay-pg 5432/tcp 获取端口，填入以下连接。
export NERVE_TEST_DATABASE_URL='postgres://postgres:codex_m3_replay_only@127.0.0.1:<专用端口>/postgres'
pnpm --filter '@nerve-office/api...' run build
pnpm --filter @nerve-office/web run build:e2e
pnpm exec vitest run --project=integration tests/integration/src/documents/codex-server-release-revocation.test.ts tests/integration/src/local-keys/codex-keys-revoke-first-fetch-race.test.ts
# 在私有副本的tests/e2e目录执行，各次自动新建并删除E2E数据库：
E2E_AUTOSAVE=running pnpm exec playwright test specs/editor/codex-stale-acquire.spec.ts --project=chromium --workers=1
E2E_AUTOSAVE=running pnpm exec playwright test specs/editor/codex-panel-beforeunload.spec.ts --project=chromium --workers=1 --grep '尚未结束防抖'
E2E_AUTOSAVE=running pnpm exec playwright test specs/editor/codex-panel-beforeunload.spec.ts --project=chromium --workers=1 --grep '真实导航'
# 跑完或中断也清理自己创建的容器与其匿名数据卷：
docker rm -f -v codex-m3-replay-pg
```

复建时先确认维护URL端口不是开发库；若示例容器名已存在，换独立名字，不复用不明实例。这里的数据库密码仅为可公开的隔离测试值。

当前HEAD的预期：CX1/CX3脚本通过，表示错误交错确实成立；CX2脚本在“新页仍能保存”失败；CX4第一条在应提示失败，第二条在应出现原生离开对话框失败。CX4第二条先断言库仍100，是为了证明数据后果，不能把该断言直接当修复后应保留的期望。正式回归应断言正确行为并对修复做变异验证。

### CX1：`tests/integration/src/documents/codex-server-release-revocation.test.ts`

```ts
import type { TestApp } from '../support/api-app.ts'
import type { TestDatabase } from '../support/database.ts'
import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'
import { EDIT_LEASE_HEADER, SHEET_TEMPLATE } from '@nerve-office/contracts'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { seedDocument } from '../support/documents.ts'
import { acquireLease, saveContent } from '../support/edit-leases.ts'
import { raceAgainstHeldLock } from '../support/held-lock.ts'
import { asUser, login } from '../support/session-client.ts'
import { createTeamSpace } from '../support/spaces.ts'

let database: TestDatabase
let app: TestApp
beforeAll(async () => {
  database = await createTestDatabase()
  await database.query(async client => client.query(`
    CREATE FUNCTION codex_server_audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'documents.content_saved' THEN
        PERFORM pg_advisory_xact_lock_shared(7924411);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER codex_server_audit_gate BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION codex_server_audit_gate();
  `))
  app = await startTestApp({ databaseUrl: database.url })
})
afterAll(async () => { await app?.close(); await database?.drop() })

it('US-M3-12 反例：释放租约让移出空间先于已校验保存提交', async () => {
  const admin = await createAccount(database, { username: 'codex-server-admin' })
  const editor = await createAccount(database, { username: 'codex-server-editor' })
  const adminSession = await login(app.baseUrl, admin.username, admin.password)
  const editorSession = await login(app.baseUrl, editor.username, editor.password)
  const space = await createTeamSpace(database, { name: 'codex server probe', createdBy: admin.id, members: { [admin.id]: 'admin', [editor.id]: 'editor' } })
  const document = await seedDocument(database, { spaceId: space, createdBy: admin.id, title: 'codex server probe' })
  const lease = await acquireLease(app.baseUrl, editorSession, document.id)
  const raw = Buffer.from(JSON.stringify({ ...SHEET_TEMPLATE, id: document.unitId }))
  let beforeSaveCommit: unknown
  const save = await raceAgainstHeldLock(database, {
    hold: async client => client.query('SELECT pg_advisory_xact_lock(7924411)'),
    request: async () => saveContent(app.baseUrl, editorSession, document.id, zlib.gzipSync(raw), { baseRevision: 1, lease }),
    change: async () => {
      // 保存已核对租约并写修订、尚未提交时，真实HTTP释放照常提交。
      const released = await asUser(app.baseUrl, editorSession, `/api/documents/${document.id}/edit-lease`, { method: 'DELETE', headers: { [EDIT_LEASE_HEADER]: lease.token } })
      expect(released.status).toBe(204)
      await released.arrayBuffer()
      const revoke = await asUser(app.baseUrl, adminSession, `/api/spaces/${space}/members/${editor.id}`, { method: 'DELETE' })
      expect(revoke.status).toBe(204)
      await revoke.arrayBuffer()
      beforeSaveCommit = await database.query(async client => (await client.query(`
        SELECT d.revision, l.end_reason, EXISTS(SELECT 1 FROM space_members m WHERE m.space_id = $2 AND m.user_id = $3) AS member
        FROM documents d JOIN document_edit_leases l ON l.document_id = d.id WHERE d.id = $1`, [document.id, space, editor.id])).rows[0])
      expect(beforeSaveCommit).toEqual({ revision: 1, end_reason: 'released', member: false })
    },
  })
  expect(save.status).toBe(200)
  await save.arrayBuffer()
  const after = await database.query(async client => (await client.query('SELECT revision FROM documents WHERE id = $1', [document.id])).rows[0])
  expect(after).toEqual({ revision: 2 })
  console.log('CODEX_RELEASE_REVOKE_PROBE', JSON.stringify({ beforeSaveCommit, saveStatus: save.status, after }))
})
```

### CX2：`tests/e2e/specs/editor/codex-stale-acquire.spec.ts`

```ts
// 只读对抗评审的私有探针：只扣住真实成功回包，不伪造服务端响应或本机锁。
import type { APIResponse } from '@playwright/test'
import { createUser, editLeaseEpoch } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { blockSaves, createSheetThroughApi, EDITOR_TEST_TIMEOUT, enterEditButton, openReader, saveButton, statusRegion, takeOverHereButton, typeInCell, waitForEditorAccess } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M3-08 旧申请的真实成功回包晚到时不得抢走更新代持有者的本机锁', async ({ page, context }, testInfo) => {
  await loginThroughApi(page, await createUser('codex-stale-acquire'))
  const documentId = await createSheetThroughApi(page)
  await openReader(page, documentId)
  let deliver: () => void = () => {}
  const held = new Promise<void>((resolve) => { deliver = resolve })
  let committed: (response: APIResponse) => void = () => {}
  const firstCommitted = new Promise<APIResponse>((resolve) => { committed = resolve })
  let intercepted = false
  await page.route(`**/api/documents/${documentId}/edit-lease`, async (route) => {
    if (route.request().method() !== 'POST' || intercepted) {
      await route.continue()
      return
    }
    intercepted = true
    const response = await route.fetch()
    committed(response)
    await held
    await route.fulfill({ response })
  })
  try {
    await enterEditButton(page).click()
    const response = await firstCommitted
    expect(response.status()).toBe(201)
    const firstEpoch = await editLeaseEpoch(documentId)
    // A 已获得服务端批准，但成功回包未送达，因此还没有拿本机锁、还没有启动心跳。
    expect(await page.evaluate(async id => (await navigator.locks.query()).held?.filter(lock => lock.name === `nerve-doc:${id}`).length, documentId)).toBe(0)

    const newer = await context.newPage()
    await openReader(newer, documentId)
    await expect(takeOverHereButton(newer)).toBeVisible()
    await takeOverHereButton(newer).click()
    await waitForEditorAccess(newer, 'edit')
    expect(await editLeaseEpoch(documentId)).toBe((firstEpoch ?? 0) + 1)
    // 两种构建都让 B 保留未保存的真实输入，便于观察错误驱逐的后果。
    const saves = await blockSaves(newer)
    await typeInCell(newer, 'A1', 'newer holder pending edit')
    await expect(saveButton(newer)).toBeVisible()

    deliver()
    await waitForEditorAccess(page, 'edit')
    await testInfo.attach('stale-acquire-observation.json', {
      body: JSON.stringify({
        firstEpoch,
        epochAfterOldReply: await editLeaseEpoch(documentId),
        oldPageStatus: await statusRegion(page).textContent(),
        newPageStatus: await statusRegion(newer).textContent(),
        newPageAlerts: await newer.locator('#editor-chrome').getByRole('alert').allTextContents(),
      }, null, 2),
      contentType: 'application/json',
    })
    // 应由 B 继续编辑；当前实现因 A 的旧成功回包无条件 steal，使 B 进入失权、副本状态。
    await expect(saveButton(newer)).toBeVisible()
    await saves.unblock()
  }
  finally {
    deliver()
  }
})
```

### CX3：`tests/integration/src/local-keys/codex-keys-revoke-first-fetch-race.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { LocalKeysRepository } from '../../../../apps/api/src/modules/local-keys/local-keys.repository.ts'
import { createAccount } from '../support/accounts.ts'
import { startTestApp } from '../support/api-app.ts'
import { createTestDatabase } from '../support/database.ts'
import { takeLocalKey, revokeLocalKey, localKeyRowsOf } from '../support/local-keys.ts'
import { login } from '../support/session-client.ts'

describe('Codex: 首次取用在空吊销与响应摘要之间提交', () => {
  it('证明未吊销任何版本却返回非空第1版，界面将误报已吊销', async () => {
    const db = await createTestDatabase()
    const app = await startTestApp({ databaseUrl: db.url })
    try {
      const root = await createAccount(db, { username: 'cx-keys-root', systemRole: 'admin' })
      const user = await createAccount(db, { username: 'cx-keys-user' })
      const rs = await login(app.baseUrl, root.username, root.password)
      const us = await login(app.baseUrl, user.username, user.password)
      const repository = app.runtime.get(LocalKeysRepository)
      const original = repository.revokeCurrent.bind(repository)
      let generated: { version: number, key: string } | undefined
      const spy = vi.spyOn(repository, 'revokeCurrent').mockImplementationOnce(async (...args) => {
        const revoked = await original(...args)
        expect(revoked).toBeUndefined()
        generated = await takeLocalKey(app.baseUrl, us)
        expect(generated.version).toBe(1)
        return revoked
      })
      const response = await revokeLocalKey(app.baseUrl, rs, user.id)
      spy.mockRestore()
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.localKey.version).toBe(1)
      expect(await takeLocalKey(app.baseUrl, us)).toEqual(generated)
      const rows = await localKeyRowsOf(db, user.id)
      expect(rows.map(row => [row.version, row.revokedAt])).toEqual([[1, null]])
      const audit = await db.query(async client => (await client.query("SELECT details FROM audit_events WHERE target_id=$1 AND action='users.local_key_revoked'", [user.id])).rows)
      expect(audit).toEqual([])
      console.log(JSON.stringify({ responseLocalKey: body.localKey, actualVersions: rows.map(row => [row.version, row.revokedAt]), audit, uiWillSay: `已吊销，换成了第 ${body.localKey.version} 版。` }))
    }
    finally {
      vi.restoreAllMocks()
      await app.close()
      await db.drop()
    }
  })
})
```

### CX4：`tests/e2e/specs/editor/codex-panel-beforeunload.spec.ts`

```ts
// 私有评审探针：仅用正常界面、页面时钟和真实服务。
import { pauseTime } from '../../support/autosave.ts'
import { createUser } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { loginThroughApi } from '../../support/session.ts'
import { createSheetThroughApi, EDITOR_TEST_TIMEOUT, openAndEnterEditing, resourceOf, ribbon, saveAndCapture, savedContent, saveStatus, selectCell, wouldPromptOnLeave } from '../../support/sheet.ts'

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

test('US-M3-02 数据验证面板里尚未结束防抖的修改必须触发离开提示', async ({ page }, testInfo) => {
  await page.clock.install()
  await loginThroughApi(page, await createUser('codex-panel-leave'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId)
  await selectCell(page, 'C3')
  const data = await ribbon(page, '数据')
  await data.getByRole('button', { name: '数据验证' }).click()
  await page.getByRole('menuitem', { name: '新建规则' }).click()
  const value = page.getByRole('complementary', { name: '侧边栏' }).getByRole('textbox').last()
  await expect(value).toHaveValue('100')
  await saveAndCapture(page)
  expect(await wouldPromptOnLeave(page)).toBe(false)
  const before = resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')

  await pauseTime(page)
  await value.fill('250')
  await expect(value).toHaveValue('250')
  const prompt = await wouldPromptOnLeave(page)
  const shown = await saveStatus(page).textContent()
  // 恢复时钟、把同一次修改明确保存：排除面板控件只是临时 UI、不改变持久化内容的假阳性。
  await page.clock.resume()
  await saveAndCapture(page)
  const after = resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')
  await testInfo.attach('panel-beforeunload-observation.json', {
    body: JSON.stringify({ promptBeforeDebounce: prompt, saveStatusBeforeDebounce: shown, before, after }, null, 2),
    contentType: 'application/json',
  })
  expect(after).toMatchObject({ 'sheet-1': [{ formula1: '250' }] })
  expect(prompt).toBe(true)
})

test('US-M3-02 面板防抖尚未结束时真实导航应先给出未保存提示', async ({ page }, testInfo) => {
  await page.clock.install()
  await loginThroughApi(page, await createUser('codex-panel-navigation'))
  const documentId = await createSheetThroughApi(page)
  await openAndEnterEditing(page, documentId)
  await selectCell(page, 'C3')
  const data = await ribbon(page, '数据')
  await data.getByRole('button', { name: '数据验证' }).click()
  await page.getByRole('menuitem', { name: '新建规则' }).click()
  const value = page.getByRole('complementary', { name: '侧边栏' }).getByRole('textbox').last()
  await expect(value).toHaveValue('100')
  await saveAndCapture(page)
  expect(await wouldPromptOnLeave(page)).toBe(false)
  await pauseTime(page)
  await value.fill('250')
  await expect(value).toHaveValue('250')
  const dialogs: string[] = []
  page.on('dialog', async dialog => {
    dialogs.push(dialog.type())
    await dialog.accept()
  })
  const shown = await saveStatus(page).textContent()
  await page.goto('/')
  const afterNavigation = resourceOf((await savedContent(page, documentId)).snapshot, 'SHEET_DATA_VALIDATION_PLUGIN')
  await testInfo.attach('panel-navigation-observation.json', {
    body: JSON.stringify({ dialogs, shownBeforeNavigation: shown, afterNavigation }, null, 2),
    contentType: 'application/json',
  })
  expect(afterNavigation).toMatchObject({ 'sheet-1': [{ formula1: '100' }] })
  expect(dialogs).toContain('beforeunload')
})
```

## 附录 B：ADR-019 的逐条核对

| 决策 | 实现与真正的测试断言 | 判断 / 证据边界 |
|---|---|---|
| 每人最多一把当前；版本连续；吊销材料擦掉、下一版同事务产生 | 0026 SQL 的部分唯一索引、长度/状态 CHECK、restrict FK；`local-keys.repository.ts:80–107` UPDATE + INSERT；`LocalKeyRevocation.revoke` 同事务调用；`local-keys.test.ts:160–238` 核对旧行为空、新行存在、内容变化、逐微秒时间线 | 符合；I19/I20/I21 由集成删库时扫描。`migrations-with-data.test.ts`续审已实测 |
| 第1版 now；吊销 clock_timestamp；下一版 created_at 取上一版 revoked_at | `local-keys.repository.ts:62–67,80–107`；`local-key-races.test.ts:248,269` 固定事务顺序；`local-keys.test.ts:209` 上海时区 | 符合；不把审计 occurred_at 的历史倒序另报新问题（已接受 O1/C4） |
| HKDF用途分离、AES256GCM、IV12+密文32+tag16、AAD绑定用户/版本/id | `master-keyring.ts:40–98,116–193`；KAT `master-keyring.test.ts:65` 固定逐字节结果；加解密参数均 authTagLength=16 | 符合；KAT 与篡改/截短/参数单元已在中断前 449 条内实测；本轮不重复独立密码实现复算 |
| 配置唯一来源，标准base64 32字节、_FILE互斥、HTTPS拒可读、server必需/CLI不必需 | `config.ts:275–317,566–644`；`config.module.ts:27–35` APP_CONFIG 排除 localKeys；`process.test.ts:85–161` 真进程退出码、fatal、输出无取值、_FILE启动、三种CLI | 符合；本轮真进程已实测，未把单元结果冒称容器验证 |
| 原始密钥仅POST给本人；第一条事务语句复核会话；不锁账户行 | `local-key.service.ts:39–69`；控制器/守卫；`local-keys.test.ts:89,109,125` 响应、库内包装与CSRF；`local-key-races.test.ts:314` 守卫后撤销；权限矩阵 `local-key-matrix.test.ts:68` | 符合；第一次取用 ON CONFLICT 后重读，只取 principal 的 userId；会话后续并发撤销的快照语义属于已定约定 |
| 吊销system-admins→账户→密钥→审计；空吊销原样返回、不审计 | `admin-users.service.ts:146–173`；`local-key-revocation.ts`；`local-keys.test.ts:160,241,251,267`；races:219,248,269,292 | **CX3例外**：正常吊销/并发串行化成立，但空吊销的响应摘要受后续首取影响，使前端虚报成功。races:292 只测首取在响应之后提交 |
| 不顺带撤销登录；停用不顺带吊销 | 上述 local-keys:251/267；账户页确认框三版及停用/启用说明 | 与已接受的单一职责决定一致；M3 不实施 M4 的浏览器草稿删除/换密钥行为 |
| 心跳只带本人当前版本，页面不消费 | `document-editing.service.ts:172–180`；local-keys:326 用文档创建人与持有者不同的用例，排除误读别人版本；E2E见下行 | 符合；回滚时新页面严格解析旧响应是已登记 DEF-070，不重报 |
| US-M3-17浏览器验收 | `tests/e2e/specs/admin/local-keys.spec.ts:135–214`：另一设备先取v1→进入编辑→心跳v1；管理员键盘打开确认框、点击确认→状态区v2→焦点→审计actor/target/revokedVersion1；两次后续心跳v2、整页文字/标题/对话框/读屏均不变；修改保存落库；再取v2不同字节 | 验收主链真实存在，不只是标题；未带@test-build，生产外部模式能执行。CX3不在此链中；中断前主审Chromium日志含此链，续审未重跑 |
| 主密钥不符仍启动、日志error、取用500、显式吊销恢复 | `master-key-check` + `master-key-mismatch.test.ts:79,136`；测试照抄部署SQL找旧包装的账户，核对文档/登录可用、新旧id把数、500不自动重建、吊销恢复 | 符合；历史报告的真实容器结果只按既有证据引用，不充当本HEAD本轮新证据 |
| 日志/错误/审计/管理员响应不含材料；用完Buffer清零；不自动ETag | 主密钥环异常不挂原异常；服务与revocation finally清零；全局日志脱敏和错误序列化；`configure-http.ts`关闭自动ETag；单元各清零/序列化断言，local-keys集成输出逐字 | 未见新增泄漏；常驻字符串、MVCC/WAL/备份、dump限制已明确接受（DEF-067/068） |
| 公开模块边界、配置最小暴露 | `local-keys/index.ts`只暴露module/revocation/versions/类型；`eslint.config.ts:604–616,737,993`限制；`lint-rules-api.test.ts:430–474`别名/type/namespace/reexport/direct-path矩阵 | 未见绕开；本子审仅静态核对这组lint用例，未额外运行整仓lint |


## 附录 C：时间、保留期与测试时钟的补充

- `tests/integration/src/documents/lease-requests.test.ts`：请求方停止续期600秒后失效、交出留120秒，self/force均受保留阻挡；页面2分钟/10分钟用可控时钟推进，服务端有效时间通过私有测试数据库控制；不把假页面时间当数据库时间。
- `tests/integration/src/documents/edit-leases.test.ts:617`：异常提醒边界29分50秒有/30分10秒无，精确30分钟边界另由纯规则单元测试；集成保留10秒余量。页面长时间空闲不真等10/12分钟，相关断言检查新代次与内容。
- `tests/integration/src/jobs/revision-purge.test.ts`：29天不删、30天边界、回执恰好30天暂不删再1ms删、400天当前修订仍留；按数据库时间与可控测试时间，而非机器墙钟猜测。重放的账本保留30天，不能宣称永久幂等；默认30天、配置下限15天长于M4草稿14天的设计限制保留。
- `lease-revocation-locks.test.ts` 的等锁辅助确认请求正在被锁阻塞，70秒保存事务上界分解为10秒内开始设置限时＋之后至多60秒；CX1说明该时间证明不足以覆盖明确结束的租约筛选。
- `autosave.spec.ts` 的精确2000/4000ms断言基于受控调度时钟；公式Worker计算仍是真实执行，不能快进浏览器时钟就声称计算已完成。P4交接记录CI上stop到达晚于算完的用例曾增大工作量校准；本次未在慢CI重复测量稳定性。
- 测试构建和生产构建分目录；`E2E_AUTOSAVE=running`只恢复生产的自动保存调度，并不消除测试构建所有专用模块，故本次把此结果称“生产节奏”，不称“完整生产镜像实测”。

## 附：处理与复验（主会话，2026-10-09）

评审者的结论与正文不改，这一节与 §3 表的"处理""复验证据"两列由主会话填写。

- **核实**：四条逐条对照代码核实，都属实；修法按根因定下，写进 P6 设计 §3.13（`8ab76dc4`），实施之后各文档订正（计划书 r20）。
- **修复**：三位修复者并行（服务端 CX1、CX3；编辑器页的本机锁 CX2；适配层与保存的状态机 CX4），各自的私有副本，主会话合并（`158fb038`、`39840b8a`、`f87defa2`）。
- **复验**：一位没参与评审与修复的复验者只看这批修复，"通过"，另提 E1–E7（`f87defa2` 上：单元 6632 条、集成 4766 条、E2E 三个浏览器 1140 条、`E2E_AUTOSAVE=running` 447 条）；E1–E5 修复之后再复验"通过"，另提 E8–E10；E8、E9 修复之后再复验"通过"，另提 E11；E11 修复之后再复验"通过"，只记 E12（文档，已订正）。E6、E7、E10 是文档，已订正；其余都已修复，没有登记延期。
- **评审 §5 的异议**：P5 撤权论证与计划书 §6.4（CX1）、"服务端批给了本页另一页必然失效"与计划书 §7.5（CX2）、P4"面板防抖守得住"（CX4）、P6"第一次取用的并发已覆盖"（CX3）随修复订正；US-M3-12、US-M3-15 的上层说法，架构总览的页头与 CI 一节，ADR-015 的旧分块名已订正（`6285c0fb`）。
- **合并之前的门禁**：见 `reviews/M3-收尾汇报.md` §1、§3。

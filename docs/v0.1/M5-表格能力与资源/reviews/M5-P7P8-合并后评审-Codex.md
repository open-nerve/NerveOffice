审查者：Codex（GPT-6 系列；并行审查 gpt-6.1-sol）｜日期：2026-11-16｜范围：cd2d6403f7d4c63ad1435c8afe79d8bbe186e7a5..8cbe1ab57b8b53a8ee0c452ee2cc8b1b776bf089（M5-P7/P8）｜结论：不通过

## 结论摘要

发现 **0 项阻断、3 项重要、4 项一般**，均尚未修复。重要问题是：资源工具在首次清理核验失败后无法恢复收尾（CX1）；`IMAGE()` 合法首参空白导致漏建图片引用（CX2）；历史预览优化遗漏了图片自身授权来源变化（CX4）。其余涉及撤销后的图片恢复、测试前提守卫、归档清扫隔离与诊断完整性。

其中 **3 项由本轮小型受管探针复现，4 项为静态确认**。探针只证明各自的状态机或协议处理反例；没有执行浏览器、真实数据库或完整门禁，不把静态调用链称为端到端实测。未修改产品代码、项目测试或 Git 状态。

P8 重点关注的锁外旧库清理、会话换代判定，以及 `child_group.py` 的三个接入点未发现本次可确认缺陷。Q-10 的失败关闭符合批准口径。P7 的 `baseRevision` 接线和回退符合 ADR-023 及 11-06 的追认，未重复报告已裁决的限制。

## 检查项

| 检查项 | 结果 | 证据与说明 |
|---|---|---|
| 正确性与边界条件 | 有问题 | CX1、CX2、CX3、CX6：恢复、等价语法、缓存命中与损坏台账路径 |
| 模块边界与依赖方向 | 有问题 | CX4：历史详情授权无法证明图片的全部实际授权来源仍有效；其余新增接线有既有批准 |
| 测试是否真的钉住行为 | 有问题 | CX3 的直接 load 替身绕过 SDK 命中；CX5 取消守卫未包住初始等待；CX7 不完整回复可被认作完整诊断 |
| 权限与本机数据清理等业务规则 | 有问题 | CX4 影响已解码缓存的撤权清除；锁外清理仍在锁内核对原许可，未见跨会话误删 |
| 文档与代码是否一致 | 有问题 | CX3、CX4、CX5、CX6 的实现未覆盖对应文档所称的全部条件 |
| 资源与性能 | 有问题 | CX1、CX6 阻断后续受管运行；CSV 时间切片、图片写入策略优化和 DEF-081 补丁未发现额外确认问题 |

## 问题清单

表中的位置均相对于本仓库根。后两列有意留空，供维护者处理和复验。

| 编号 | 严重度 | 类别 | 位置（文件:行） | 问题与影响 | 证据与等级 | 复现或探针 | 建议 | 处理 | 复验证据 |
|---|---|---|---|---|---|---|---|---|---|
| CX1 | 重要 | 潜在缺陷 | `tools/test-resources/lifecycle.py:1242`；`tools/test-resources/run.py:337` | 已启动运行的 scratch 丢失，首次句柄核验失败后变成 cleanup-pending。后续核验恢复仍无匹配终结分支，短根不退役，同类测试一直被拒绝。 | **已实测**：第二次允许清理后实际仍为 `(cleanup-pending, False, True)`；P7 M-19/R14 的残余路径。 | `review_missing_scratch_retry.py`，附录 A；1 条断言失败。 | 将已启动且缺 scratch 的 cleanup-pending 纳入重新核验后的中断收尾；保留组、句柄、归属及容器/证据检查。 | 已修复（P9-S2 `1a3ee734`）。缺 scratch 的已启动 cleanup-pending 运行，在组与句柄核验（`assert_quiescent`）通过后与 prepared、running 同走中断收尾、退役短根；`requestedStatus` 保留第一次请求的结论，`commandExitCode`、`exitCode` 记命令结束时的事实、收尾不改写（资源规范写明口径）。夹具、证据、容器归属与托管路径的先行检查不变。 | 附录 A 探针在修复后通过；新用例 `test_started_run_without_scratch_finishes_once_the_retried_check_passes` 修复前失败、修复后通过；测试资源工具完整 Python 回归 540 项通过（第二轮复验之后）。同模型独立审查与复验确认，见 `reviews/P9-独立审查.md`。 |
| CX2 | 重要 | 潜在缺陷 | `apps/web/src/editor/images/image-formula-address.ts:63` | 首参外 U+00A0 被 SDK 当空白接受，但归一器只跳过四类 ASCII 空白，合法 IMAGE 的本站绝对地址原样存下，服务端不建引用。其他读者可能失图；无其他保留关系时资源可进入正常回收。 | **静态确认**：固定 SDK 的词法、首参来源证明、ValueNode、限制执行器与服务端提取链逐段核对；第二位审查员独立接受。 | `=IMAGE(\u00A0"https://docs.example.com/api/assets/11111111-1111-4111-8111-111111111111")`，其中 `\u00A0` 表示实际字符。未运行解释器探针。 | 首参字面量外空白与固定 SDK 的 trim 语义统一；同一测试同时核对实际执行器、归一结果及提取到的引用。 | 已修复（P9-S3 `ddd31384`）。核实时用真实解释器实测，范围比报告大：首参前、首参后与括号组内三处，旧集合（空格、制表、换行、回车）之外的 21 个空白码位都是“SDK 执行、规范未改写”。`skipSpaces` 改用与 `trim` 相同的 `/^\s$/u`，只改写字面量，空白原样保留。 | 新增真实解释器的一致性用例 `image-formula-address-sdk.test.ts`（25 个空白码位 × 3 个位置，另以 4 个非空白字符作对照）与 7 条显式用例：修复前 63 处不一致、8 条失败，修复后通过；图片、内部 API 与图片函数单元 957 条通过。 |
| CX3 | 一般 | 潜在缺陷 | `apps/web/src/editor/images/image-resources.ts:273`、`:202` | 单元格图首次读取失败，删除后刷新、再撤销时，SDK 命中旧占位元素，既不重新读取，也没有图片错误/重试入口。静默补读失败后撤销也可进入同一状态。 | **静态确认**：清空/撤销、骨架复用、ImageCacheMap 命中及页面失败提示接线均核对；两位审查员独立接受。 | 首读暂时失败→清空该格→恢复在线并完成刷新→撤销；保持同一实例、同一来源且缓存未淘汰。未运行浏览器。 | 在来源重新被显示时合并一次受授权的读取；通过真实 SDK 缓存命中的回归验证，不用直接 load 代替撤销。 | 已修复（P9-S4 `22d506db`；审查后补 `117c7628`、`552c1fc3`）。core 补丁让 `ImageCacheMap.getImage` 命中时调用实例 `IImageIoService` 的 `revisitImageSource`；平台记下刷新时跳过的、SDK 仍持有而没有像素的来源，以及静默补读失败的来源，命中时补一次正常读取，失败照常报告、页头给出重试。审查后另补：静默补读进行中被再次显示时，那一次读取转为在用，失败照常报告。方法名与移除条件记入 ADR-022。 | 真实 `ImageCacheMap` 的单元用例（撤销命中补读、补读失败报告、静默失败后撤销、补读期间命中、暂停与读取进行中不另读）修复前失败、修复后通过；新增浏览器故事 `images.spec.ts:260` 在本机 Chromium、Chrome、WebKit 各一次首次通过；反证运行（临时不补读）按预期停在撤销之后的像素断言。 |
| CX4 | 重要 | 设计不合理 | `apps/web/src/features/history-preview/preview-controller.ts:113`、`:174` | 后台仅复核会话及历史 D，无法发现图片 A 唯一授权来源 X 被撤权。D 的权限未变时已解码 A 可持续显示，虽新的资源 GET 已被服务端拒绝。 | **静态确认**：P7 删除每轮暂停/重读后，无资源级权限重核；D-01 允许正文保留未登记地址，历史关系不为该地址补授权。 | 共享历史 D 含未登记 A；乙经 X 可读 A，打开 D 历史后仅撤销 X 的授权；保持会话和 D 权限不变。未运行端到端场景。 | 保留无全量字节重下的体验，同时复核实际显示资源的读权，撤权时清除对应像素；协调 P4-S3 与 P2-S2 的权限规则。 | 需求方 11-16 决定登记已知限制，不改代码。现象属实，但符合计划书 §6.4“已经发送到客户端的内容收不回来”与 A06（服务端拒绝新的读取）；D-06 已批准就绪时的复核不重读图片；阅读页同样存在这个窗口。P2-S2 §5、P4-S3 的 P7 修订与 ADR-023 对齐口径（P9-S6 `3a57ff65`）；登记 DEF-088：M6 的共用编辑会话层加不下载图片字节的权限复核，表格页、历史预览与文字文档一并覆盖。 | 核实记录 `reviews/P9-Codex评审核实.md`。口径对照了代码：表格页的 `refreshDetail` 只由页头的刷新与重试、分享对话框触发；定时状态检查经 `imagePermissions` 只在权限位变化时刷新图片。同模型独立审查确认文档与代码一致。 |
| CX5 | 一般 | 逻辑链断裂 | `tests/e2e/specs/editor/handover-same-browser.spec.ts:118` | 初始点击、等待 acquisition 及查询 epoch 在首个取消竞速之前。A 在服务端初次回包期间被取消，守卫虽已拒绝，测试仍可能等待或先报不相干错误，不能立即写明前提失效原因。 | **静态确认**：held 在 :111 设置；取消拒绝在 :98；第一次 race 到 :136 才等待它。 | 在 route.fetch 尚未返回时让原页面 10 秒请求时限到达；现有已批准反例是在 B 接手前扣住，未覆盖这一窗口。未运行浏览器。 | 将 A 开始申请到放行前整段纳入同一守卫；真实路由失败也要终结 acquisition。保持原断言、请求时限及事务。 | 已修复（P9-S5 `9b186d58`；审查后补 `117c7628`）。从点击“编辑”到放行，每一步都与“被扣住的申请被放弃”竞速；`route.fetch` 失败时 `acquisition` 以写明原因的错误拒绝，并了结这次路由。原断言、页面 10 秒时限与真实事务不变。 | 本机 Chromium、Chrome、WebKit 各一次首次通过（4.4、4.9、6.5 秒）；同模型独立审查对照 `8cbe1ab5` 确认断言、时限与事务未变。 |
| CX6 | 一般 | 潜在缺陷 | `tools/test-resources/lifecycle.py:819`、`:823`；`:760` | 一条归档的 endedAt 类型损坏即可在候选排序/减法时抛错，其他健康候选也停止；普通 sweep 没有收尾的隔离边界，使所有类型的新测试启动受阻。 | **已实测**：有效 JSON 的字符串时间加正常过期记录，sweep 在 sorted(candidates) 抛 TypeError。P7 M-20/V4 只补了收尾边界，未覆盖此入口。 | `review_bad_archive_timestamp.py`，附录 B；1 条 error。 | 候选加入前验证必需字段及有限数值时间；单条保留并记录 collection-failed，其余继续。 | 已修复（P9-S2 `1a3ee734`；审查后补 `117c7628`、`552c1fc3`）。按建议在候选加入前校验：时刻须是有限的整数或浮点数（含超出浮点范围的整数），删除前要用到的 `version`、进程组、回收记录与发布列表一并校验，服务 scope 证明在句柄核对时校验；台账与归档记录的顶层须是 JSON 对象。不合格的这一条记 `collection-failed` 原样保留，其余候选照常回收；`archive.py` 同类处理。 | 附录 B 探针在修复后通过；新增与扩充的用例（坏时刻 6 种、删除前字段 5 种、坏发布列表 4 种、非对象的台账与发布标记、归档记录的时刻与顶层）修复前分别抛 TypeError、OverflowError、KeyError、AttributeError 或误删，修复后都只跳过这一条；完整 Python 回归 540 项通过。 |
| CX7 | 一般 | 逻辑链断裂 | `tests/e2e/support/context-close-protocol.ts:533`、`:549`、`:837` | 已识别 error 头但正文截断时，仍写 disposeDone，却未设置 disposeError，过滤器回报 answered。关闭事件到达后可把该诊断标为完整，错误证据反而被当作成功回复。 | **已实测**：实际过滤器对截断错误输出 `answered / unparsedBodies=1 / errors=0`；记录器只看 errors 与 disposeOutcome，静态确认没有兜底拒绝。 | `review_close_protocol.mjs`，附录 C；1 条断言失败。未接浏览器，仅喂协议模型。 | 以已识别的错误头作为错误事实；正文缺失/无法解析用固定原因判不完整，不能认作成功。 | 已修复（P9-S5 `9b186d58`；审查后补 `117c7628`）。以回复头认出的错误为准：正文截断、解析不出、缺 `message` 或 `message` 为空时记固定原因 `error-without-text`，`disposeOutcome` 为 dispose-error，记录标为不完整；正文有错误字段的照旧算错误。当前配置下触发不到（Playwright 默认不截断协议日志）。 | 附录 C 探针（只把导入改到 P9 worktree）修复后通过；`context-close-protocol.test.ts` 补上截断、缺 `message`、空 `message` 三种情况，修复前失败、修复后通过；关闭诊断单元 39 条通过。 |

## 关键证据与影响边界

### CX1：清理失败后缺少可恢复的状态转移

`finish()` 先调用 `assert_quiescent()`，失败由末尾 catch 持久化 cleanup-pending。之后 `sweep()` 会再次进入 finish；scratch 仍不存在时，仅处理 reports-collected、没有 childGroup 的未启动运行、prepared/running。已经启动的 cleanup-pending 直接返回旧数据。

现有 `test_lifecycle.py:300`、`:313` 验证了首次即可成功核验的丢目录路径，没有覆盖“先拒绝、后恢复”。本轮探针的句柄/进程观察是模型，实际外层运行器另行核对并清理成功。建议修复时还核对中断结果字段的一致性：当前缺目录分支可留下先前 `exitCode=0/interrupted=false`，而本轮 CLI 因 interrupted 实际返回 1；不应覆盖原始 commandExitCode。

### CX2：同一合法公式在显示与持久引用两端的解释不一致

`firstArgumentLiteral()` 只跳过 SPACE 中的空格、TAB、CR、LF。U+00A0 不在其中，直接返回 undefined。固定 engine-formula 1.0.1 会把该空白和引号字面量保留在同一个 token；词法来源证明及 ValueNodeFactory 用 trim 判定并解出相同 URL，`imageLiteralSource()` 与 `RestrictedImageFunction` 随后允许该本站地址。现有测试覆盖 U+00A0 在函数名与左括号之间，漏了首参前后的位置。

固定发布入口的关键位置为 engine-formula ES `3685`、`3752`、`3942`（词法），`2734`（首参证明）、`12714`（值节点）；受跟踪来源证明在 `patches/@univerjs__engine-formula@1.0.1.patch:21`。`packages/contracts/src/documents/asset-references.ts:25` 仅识别规范相对地址，因此在没有同一 assetId 的其他规范引用时不能登记。这是 P7 D-02 对当前写入修复不完整，非修复前存量迁移问题。

### CX3：单测绕过了决定实际行为的 SDK 缓存

`ClearSelectionContentCommand` 的撤销重放原 SetRangeValuesMutation，不销毁工作表骨架。固定 core ES `26850` 的 ImageCacheMap 命中直接返回旧 HTMLImageElement，只有未命中才登记并调用平台读取。重算字体/布局仍复用图片缓存。相关固定行为也可由本仓库 `patches/@univerjs__core@1.0.1.patch:28` 对照。

恢复在线调用 `editor-page.ts:448` 的 refreshImages，清掉 imageProblem 并刷新资源。此时图片已从快照删除，条目没有成功解码过，restore=false，因而不重读。撤销恢复来源后，缓存命中既没有 load，也没有新的失败通知。`editor-chrome.tsx:1213` 只在有 imageProblem 时显示重试入口。`image-resources-lifecycle.test.ts:311` 的“重新在用”手工调用 load，不能证明真实撤销会走到那里。

该问题不改坏保存的图片地址。再次切在线、显式详情刷新、缓存淘汰或重开可能恢复，因此主审定为一般；修复不能恢复对仍未显示的已删除图片无条件重读。

### CX4：历史资格与图片资格不是同一个判定

反例中 D 从未登记 A。检查点只复制 D 已有的资产关系（`document-checkpoints.repository.ts:72`），正文保留地址本身不授予图片权。乙打开历史时，可经其他文档 X 的授权并集读到 A（`document-asset-access.service.ts:18`、`workspace/asset-reading.service.ts:37`）。撤销 X 后，D 的历史详情（`document-history.service.ts:48`）仍可正常返回。

`preview-controller.ts` 对就绪后台复核不暂停图；同用户、同 CSRF 的 `session-image-access.ts:64` 不通知图片刷新。后续每轮成功复核都可以保留旧像素。服务端仍拒绝新读，问题限于当前预览已解码缓存的持续展示，未声称服务器允许撤权后的新下载。

D-06/P4-S3 批准避免反复隐藏和重下，但 P2-S2 §5（`specs/P2-S2-图片实例与可靠渲染.md:79`）明确指出“权限未改变但资源引用的权限可能变化”。本例是这两项规则缺少协调；不属于 ADR-023 已接受的跨文档主动分享、可改传副本基准或保留期回退。现有 E2E 覆盖的是撤销 D 本身，以及权限不变时零图片字节请求，均不能覆盖 X 独立撤权。

### CX5：守卫已收到取消，但主流程尚未等待它

`heldCancelled.catch(() => {})` 避免未处理拒绝；它不会打断裸 await。`acquisition` 仅在 route.fetch 成功时兑现，也没有失败入口。守卫应该覆盖整段依赖该前提的操作。此条只影响测试及时失败和定位质量，不声称产品交接错误，也不要求扩展原浏览器测试授权。

### CX6：只隔离收尾异常不足以隔离逐候选回收

P7 V4 确实已经识别过时间类型异常，但测试 `test_lifecycle.py:435` 只检查 `prune_isolated()` 能吸收整个 prune 的 TypeError。普通 sweep 的调用不经该函数，而启动受管运行先执行 sweep。探针同时放入坏时间记录和健康过期记录，确定复现相互影响。建议保留坏记录、报告具体的有界原因，继续安全处理其他已证明归属的候选。

### CX7：诊断完整性不能依赖成功解析错误正文

错误头已由 ERROR_HEAD 识别；完整正文 parse 返回 undefined 时，answerExtra 没有 error 字段。onAnswer 照常写 disposeDone，disposeOutcome 只凭该字段和 disposeError 判断 answered。记录器 save 没有因为 unparsedBodies 非零拒绝，finish('closed') 也只检查 disposeOutcome，形成虚假完整链。该标记属于补充诊断，不能单独推翻产品测试结果；本轮没有发现历史 CI 原件发生此种截断。

## 设计、实施与测试覆盖核对

审查采用差异、当前调用链、固定 SDK 源码与既有测试的交叉阅读。主审负责后端/契约/资源引用/GC/部署与汇总，三个并行审查员负责编辑器、本机清理/历史、资源工具/CI；确认发现由主审复核，两个图片问题另经跨分工复核。没有将并行审查员所有候选直接计入问题表。

| 范围 | 本轮核对与结果 |
|---|---|
| P7 S1 | 原审查来源、D-01～D-11、延期登记及授权边界；使用后续追认覆盖历史计划文本 |
| P7 S2 | extractAssetIds 线性剥离、短串差分与对抗长度测试；未发现本次额外问题 |
| P7 S3 | 分片计数、图片失败与写入失败通道、实际 SDK 命令/撤销覆盖；未发现额外问题 |
| P7 S4 | IMAGE 归一与服务端引用契约；CX2 |
| P7 S5 | 0039 迁移、unlinked_asset_ids、保存/新建/普通复制/冲突副本/历史恢复五条路径；回退、幂等摘要、锁顺序与 D-01 测试一致 |
| P7 S6 | 数据验证队列覆盖、卸载退回独立字段、取消错误与未提交事件、Worker 闸；未确认新问题 |
| P7 S7 | CSV 富文本文本、纯图空格、导出范围/错误码、创建未知结果与幂等状态；未确认新问题 |
| P7 S8 | 数组公式锚点、定向重算、捕获与重开、导出兜底；未确认新问题 |
| P7 S9 | 上传有界日志、GC 单任务失败继续、水位计数及警告、部署升级顺序工具；未确认新问题；未重做测量或真实库实验 |
| P7 S10 | 历史状态机、错误终态、慢复核截止、公式提示、失败页历史入口；CX4 |
| P7 S11 | 图片暂停/恢复、已删除来源、选择性粘贴、CSS 过滤；CX3，嵌套 CSS 影响仍未证实 |
| P7 S12 | 外站请求观察器、新设备、WebSocket、favicon 对照及能力边界；未把零请求当作零尝试 |
| P7 S13 | 根路径校验、缺目录恢复、候选隔离、Python 回归门禁与 CI 接线；CX1、CX6 |
| P7 S14 | 原独审、复验及追认逐项对照；CX3/CX6 是原有修复未覆盖的后续路径 |
| P7 S15 | 图片策略快速路径、changed 条件、NaN 反例、访问器及片段预算；30 秒仅用于获批六例；未确认额外问题 |
| P8 S1～S3 | 范围、Q-10 退出码/不可见记录、托管身份与 Mac 探测；保留精确分支及失败关闭边界 |
| P8 S4 | mac.yml、external-db、Apple 芯片、本机模式的分片等价与连接设置、CI 原六项；未联网重新验收平台 |
| P8 S5 | 各轮变更落到最终差异：桌面身份 PID/start/executable、10 秒读取、完成后计间隔、CSV 时间切片、只读菜单、图片 offline、逐段拨钟；CX5、CX7；锁外清理及三处子组信号调用未确认新问题 |
| P8 S6 | DEF-081 绝对工作表坐标、滚动/缩放回归、正式入口故事及原生验收边界；三份本轮变更补丁与锁文件/清单/本地固定产物摘要一致 |
| P8 S7 | P7/P8 交接、ADR-020/022/023/026、架构、测试生命周期与延期项；本地标签/范围核对；未把仓库记载的 CI 成功当成本轮重新执行 |

## 未计入确认问题的观察

- `conflict.spec.ts:49` 新的 expect.poll 默认 5 秒，和原先只有响应等待的路径有差异；缺少它实际导致失败的证据，本轮不据此要求改时限。DEF-086 已登记的另一处 30 秒拨钟不重复报告。
- 协议过滤器保留前 160 个 ASCII 错误文字。存在文字回显的潜在记录边界，但尚未证明固定白名单中的真实调用会回显凭据或正文，也未发现实际泄漏；未计入重要问题。可另评估仅保留错误码/固定分类。
- 诊断附件 path 被替换后，HTML reporter 的后续读取可能仍阻塞或跟随链接。共用 helper 延续 P6 已有路径机制，且没有真实 reporter 复现；不把它算作本次范围内新增的已确认问题。
- 粘贴 CSS 的嵌套子规则可能保留资源声明，但解析用 shadow root 同步拆除，未证实网络请求或 CSP 影响。本轮不联网、不运行浏览器，因此不认定为外发缺陷。
- DEF-004、057、073、074、079、080、082～086 及其他已有延期按最终裁决理解；跨文档分享、旧副本基准回退、修复前已存锚点、Mac 无容器 E2E、原生来源缺口不重复报告。未发现需另写上游私密安全细节的已确认问题。

## 本轮验证与清理

起始检查：主目录 HEAD 为目标完整 SHA，分支 main，`git status --short` 无输出。`git rev-list --count cd2d6403..HEAD` 为 100；差异为 240 文件，+18,553/−816。

私有副本为 `/private/tmp/nerve-m5-p7p8-codex-ctuxh21e/repo`，从本地执行 `git clone --no-hardlinks --single-branch --branch main`；使用项目 `git_repository.repository_environment` 清除子进程继承的 Git 仓库变量，并核对副本根与完整目标 SHA。没有创建 worktree，没有 checkout/stash/提交主目录。Node 为项目要求的 24.21.0；三个探针仅使用 Python 标准库或 Node 内建模块和项目源码，不需要安装依赖，没有执行 pnpm install，也没有触发网络安装。

三个探针串行、各执行一次，没有改实现、改断言或重复运行以取得通过。命令工作目录均为私有副本：

| 问题 | 命令 | 结果 | 受管 run |
|---|---|---|---|
| CX1 | `python3 -B tools/test-resources/run.py unit -- python3 -B review_missing_scratch_retry.py` | 1 条 failure，0.006 秒；仍为 cleanup-pending，模型短根仍存在 | `6d6fd8b1-7d0a-41fc-9ace-41ff88a47ec2` |
| CX6 | `python3 -B tools/test-resources/run.py unit -- python3 -B review_bad_archive_timestamp.py` | 1 条 error，0.007 秒；候选排序 TypeError | `045cb005-69be-4960-996f-443c82ae7b8a` |
| CX7 | `python3 -B tools/test-resources/run.py unit -- node review_close_protocol.mjs` | 1 条断言失败；answered 应为 dispose-error | `93fcc022-3ba3-420f-9a2a-7d810eb3977c` |

三个真实外层台账均为 `status=failed`、`cleanupStage=complete`、`commandExitCode=1`、`exitCode=1`、`interrupted=false`，没有 cleanupError；各自 scratch 与 `/private/tmp/nerve-t-<runId>` 短根已不存在。两个 Python 探针只在外层 NERVE_TEST_SCRATCH 创建 KiB 级模型，组和句柄使用替身，模型目录用 TemporaryDirectory 回收；从未启动模型内生产者，不把替身观察当作真实资源释放证明。

原始探针输出、所需台账字段及 command.log 摘要保存在同目录 `probe-results.json`。探针完整源码附在下面，均在删除副本前保存。未运行项目全量测试、浏览器 E2E、Safari、容器 E2E、完整门禁或真实数据库；未访问 GitHub。无临时容器、卷或其他项目资源需要清理。

收尾状态：**已完成**。删除前重新核对副本 SHA、只含三个本轮探针的未跟踪变更、三个真实子进程组均已退出，完整句柄查询确认私有根没有打开引用；随后删除整个 `/private/tmp/nerve-m5-p7p8-codex-ctuxh21e`，并确认路径不存在。主目录结束时仍为 `main`，HEAD 与 `v0.1-m5` 均为 `8cbe1ab57b8b53a8ee0c452ee2cc8b1b776bf089`，`git status --short` 仍无输出。清理摘要另存同目录 `cleanup-result.json`。已有 `.claude/`、其他 worktree 及其他 handoff 目录均未修改。

## 附录：本轮探针源码

以下是实际运行的原件；断言保留预期正确行为，因此在当前目标代码上失败。文件位于上述私有副本根，删除副本后可按附录重建。模型观测的适用边界见每条问题及验证表。

### A · CX1：缺目录运行在核验恢复后收尾

文件：`review_missing_scratch_retry.py`；SHA-256：`278696bfff075380443595b25c8b216ed5d9605db6dcdb3e8ded0a1e2c931593`。

```python
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path.cwd() / "tools/test-resources"))
import lifecycle


class MissingScratchRetry(unittest.TestCase):
    def test_retry_after_handle_check_recovers(self):
        with tempfile.TemporaryDirectory(dir=os.environ["NERVE_TEST_SCRATCH"]) as temp:
            root = Path(temp)
            store = lifecycle.Store(root)
            model_short = root / "model-short-root"
            model_short.mkdir()

            def reject_initial_check(path, **options):
                raise RuntimeError("simulated incomplete handle query")

            with ExitStack() as mocks:
                mocks.enter_context(patch.object(lifecycle.hosted, "context", return_value=None))
                mocks.enter_context(patch.object(lifecycle.service_scope, "register", return_value=None))
                mocks.enter_context(patch.object(lifecycle.Run, "short_root", return_value=model_short))
                mocks.enter_context(patch.object(lifecycle, "group_alive", return_value=False))
                query = mocks.enter_context(patch.object(lifecycle, "open_paths", side_effect=reject_initial_check))
                run = store.create("e2e")
                try:
                    run.update(status="running", childGroup=2**30,
                               commandExitCode=0, exitCode=0, interrupted=False)
                    run.scratch.rmdir()
                    first = run.finish("passed")
                finally:
                    run.release()
                self.assertEqual(first["status"], "cleanup-pending")
                self.assertTrue(model_short.exists())

                query.side_effect = None
                query.return_value = []
                swept = store.sweep()
                persisted = lifecycle.read_run_manifest(run.directory / "run.json")
                self.assertEqual((persisted["status"], run.id in swept["recovered"], model_short.exists()),
                                 ("interrupted", True, False))


if __name__ == "__main__":
    unittest.main()
```

### B · CX6：坏归档不应阻断正常候选

文件：`review_bad_archive_timestamp.py`；SHA-256：`3e657f1cd7d332b1f541f3ad19131f415cec4ae6726aed8053bdea11ee28bf3b`。

```python
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path.cwd() / "tools/test-resources"))
import lifecycle


class BadArchiveTimestamp(unittest.TestCase):
    def test_sweep_skips_only_the_unreadable_timestamp(self):
        with tempfile.TemporaryDirectory(dir=os.environ["NERVE_TEST_SCRATCH"]) as temp:
            store = lifecycle.Store(Path(temp))
            reports = []
            with ExitStack() as mocks:
                mocks.enter_context(patch.object(lifecycle.hosted, "context", return_value=None))
                mocks.enter_context(patch.object(lifecycle.service_scope, "register", return_value=None))
                mocks.enter_context(patch.object(lifecycle, "group_alive", return_value=False))
                mocks.enter_context(patch.object(lifecycle, "open_paths", return_value=[]))
                for ended in ("damaged", 1.0):
                    run = store.create("unit")
                    try:
                        run.scratch.rmdir()
                        run.update(status="passed", cleanupStage="complete", endedAt=ended,
                                   commandExitCode=0, exitCode=0, interrupted=False)
                        report = run.directory / "reports"
                        report.mkdir()
                        reports.append((run.id, report))
                    finally:
                        run.release()

                swept = store.sweep(now=2_000_000_000)
                self.assertTrue(reports[0][1].exists())
                self.assertFalse(reports[1][1].exists())
                self.assertEqual([event["runId"] for event in swept["pruned"]], [reports[1][0]])
                self.assertEqual([(event["runId"], event["reason"]) for event in swept["skipped"]],
                                 [(reports[0][0], "collection-failed")])


if __name__ == "__main__":
    unittest.main()
```

### C · CX7：截断错误回复不应算成功

文件：`review_close_protocol.mjs`；SHA-256：`78387d76b58c3b1eb4a6043bc24e40dad91b34590efc3f6399c8d103ae0c2c07`。

```javascript
import assert from 'node:assert/strict';
import { CloseProtocolFilter } from './tests/e2e/support/context-close-protocol.ts';
const f = new CloseProtocolFilter(0);
f.closeStarted(1);
f.feed('SEND ► {"id":7,"method":"Target.disposeBrowserContext","params":{"browserContextId":"AABBCCDDEEFF0011"}}', 2);
f.feed('◀ RECV {"id":7,"error":{"code":-32000 <<<<<( LOG TRUNCATED )>>>>> ', 3);
const snapshot = f.snapshot(4);
console.log(JSON.stringify({outcome:f.disposeOutcome(),unparsedBodies:snapshot.unparsedBodies,errors:snapshot.errors}));
assert.equal(f.disposeOutcome(), 'dispose-error', '截断的错误回复不得作为成功关闭回复');
```

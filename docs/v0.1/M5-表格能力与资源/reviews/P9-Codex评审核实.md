# M5-P9 Codex 合并后评审的逐条核实

核实者：Claude Opus 5.5（claude-opus-5-5）｜日期：2026-11-16｜对象：[M5-P7P8 合并后评审（Codex）](M5-P7P8-合并后评审-Codex.md)的 CX1～CX7

核实环境：m6-design worktree（HEAD `86f426f7`；与 main `8cbe1ab5` 的差异只有一份新增的 M6 总设计文档，代码相同）。

- Codex 附录的三个探针原样取出，sha256 与报告一致；CX7 探针只把相对导入改成 worktree 的绝对路径。
- CX2 另写了一个用真实 SDK 解释器的临时用例，跑完即删、未入库。
- 全部经 `python3 -B tools/test-resources/run.py unit -- …` 串行运行，各一次。5 轮台账都是 cleanupStage complete，scratch 与短根都已不存在，worktree 无改动。

探针原件、CX2 用例源码与结果（`cx2-result.json`）、5 轮台账摘要（`runs.jsonl`）存在主目录 `.codex/handoffs/m5-p7p8-review-20261116/claude-verification-20261116/`，不入库。

## 结论一览

| 编号 | Codex 定级 | 核实结论 | 证据 |
|---|---|---|---|
| CX1 | 重要 | **属实** | 探针复现 `('cleanup-pending', False, True)`。`Run.finish` 缺目录分支只处理 reports-collected、未启动（childGroup 为空）和 prepared/running；已启动（childGroup 已登记）且已是 cleanup-pending 的直接返回旧数据，`sweep` 把它记为 active，`run.py:337` 从此拒绝同类运行。进入这个状态要两个异常叠加：运行期间 scratch 被外部删除，且第一次收尾核验没通过（句柄未退、lsof 不完整，或 M5R-M-19 分支里退役短根失败）；也可由 run.py 的“首进程已退出但同组仍有进程”先记 cleanup-pending、之后 scratch 被删进入。后果是失败关闭（不误删），但要人工处理才能恢复同类测试。附带：缺目录分支沿用之前写入的 `exitCode=0/interrupted=false`，而运行器实际返回 1（本机路径的校验不拒绝，属记录不一致）。 |
| CX2 | 重要 | **属实，范围比报告更大** | 真实解释器（固定 engine-formula 1.0.1 + 补丁 + 平台限制 IMAGE）对以下写法都执行原 IMAGE、拿到本站绝对地址：首参前 U+00A0、U+3000（全角空格，中文输入法容易打出）、U+2003、U+FEFF，括号组内的 U+00A0，以及首参后（`)` 或 `,` 之前）的 U+00A0。`normalizeImageFormula` 对这 7 种都不改写，`extractAssetIds` 提取为空，服务端不会登记引用。根因：`skipSpaces` 只认 4 个 ASCII 空白，而 SDK 的来源证明与 `imageLiteralSource` 用 `String.prototype.trim`（全部 Unicode 空白）。同文件函数名与括号之间已用 `/^\s$/u`，首参位置漏了。 |
| CX3 | 一般 | **属实**（静态，链路逐段核对） | core `ImageCacheMap.getImage` 命中直接返回旧元素，只有未命中才登记并读取（补丁后的 ES 26839 起）；缓存随骨架创建（27504），`resetCache()` 为空（27511）；engine-render 27177 的单元格图片取自该缓存。P7 的 `refresh()` 只重读文档仍引用的来源，已删除、从未解码的条目只清任务（restore 为 false），静默补读失败也清掉 restore；回到在线的 `refreshImages()` 清掉 imageProblem（页头重试入口随之消失）。撤销清除后缓存命中、不调平台读取，所以一直是占位、没有提示。基线 `cd2d6403` 的 `refresh()` 重读全部登记来源，不会这样，属 P7 的 M5R-M-11 改动留下的边角。下一次刷新（再断网恢复、明确详情复核、重开）可恢复。 |
| CX4 | 重要 | **现象属实；不同意定为设计缺陷/重要** | 历史预览就绪时的后台复核只取会话与历史详情，不暂停、不重读图片；同用户同 CSRF 的 `confirm` 不通知。图片 A 只经文档 X 授权时，撤掉 X 而 D 的历史权限不变，已解码的 A 会一直显示，服务端拒绝新的读取。但是：①计划书 §6.4 写明“已经发送到客户端的内容收不回来；撤权保证的是后续的访问与写入被阻止”，A06 要求的是后续资源访问被拒绝，服务端照样拒绝，满足；②D-06（需求方 11-05 批准）与 P4-S3 的 P7 修订明确“就绪时的复核不重读图片”；③普通阅读页的定时状态检查也只在文档权限位变化时刷新图片（`onImagePermissions` → `imagePermissions` 只在变化时 `refreshImages`），明确详情复核只由用户操作触发，同样的窗口在阅读页也存在。P7 之前历史预览每轮全量重下，是顺带做到的。确实成立的部分：P2-S2 §5（详情复核完成要刷新，因为资源权限可能变）与 P4-S3 的 P7 修订口径没有协调。前提也窄：D 的正文里有 D-01 保留的未登记地址，且查看者只经别的文档能读这张图。 |
| CX5 | 一般 | **属实，只影响测试诊断** | 取消守卫在第一次 `Promise.race` 才接入；之前裸等 click、`acquisition` 与查库。A 的申请若在服务端第一次回包之前被页面取消，测试仍会在 `route.fetch` 返回后从第一次竞速拿到正确原因而失败，只是不是“立即”；只有 `route.fetch` 抛错或永不返回时，`acquisition` 没有拒绝路径，会等到用例总时限，报不出具体原因。不会让测试误通过。与 11-12 批准的“放行前被页面取消即立刻失败并写明原因”相比，覆盖范围窄了。 |
| CX6 | 一般 | **属实** | 探针复现 `TypeError: '<' not supported between instances of 'str' and 'float'`（`lifecycle.py:823`）。`read_run_manifest` 不校验字段类型；`prune` 的候选收集只接住 OSError/KeyError；`sweep` 直接调用 `prune`，不经 `prune_isolated`，于是 run.py 的启动前清扫抛错，所有类型的受管运行都起不来。台账由工具自己写、`endedAt` 总是数字，要手工改动或损坏后仍是合法 JSON 才会触发。M5R-M-20 的目标是“一个候选不挡住其余候选”，类型异常这条没做到。 |
| CX7 | 一般 | **代码缺口属实；当前配置下触发不到** | 探针复现：截断的错误回复被判为 `answered`。`onAnswer` 已从回复头认出错误（`isError`），但 `disposeError` 只在正文能解析、且带字符串 `message` 时才写。不过：Playwright 1.63 只在设置了环境变量 `MAX_LOG_LENGTH` 时才截断协议日志（默认 `Infinity`，coreBundle.js 20982、21037），本仓库没有任何地方设置它；Chrome 的协议错误回复总带 `message`。所以现有运行里不会出现。修起来便宜：以回复头的错误为准。 |

## Codex 未计入的观察（简评）

- `conflict.spec.ts:49` 的 `expect.poll` 没写时限，配置里也没有 `expect.timeout`，按 Playwright 默认 5 秒。P8 实施记录写“时限不变”不够准确：这里多了一个隐含的 5 秒上限（20 次拨钟各一次往返）。CI #104/#105、托管 Mac #8 都首次通过，没有失败证据。改时限要需求方同意，本轮不改，建议记进 DEF-086（同一文件的拨钟写法）并订正实施记录的措辞。
- 协议过滤器保留错误文字前 160 个 ASCII 字符：白名单里的命令，其错误文字是浏览器的固定说明，未见回显凭据或正文的路径；同意不计入。修 CX7 时可顺手改为只留错误码与固定分类（更少留存，不影响诊断）。
- HTML reporter 读取附件路径：P6 起已有的共用机制，同意不计入。
- 粘贴样式的嵌套规则：未证实外发，同意不计入。

## 需求方的决定（2026-11-16）

- 确认的问题以 M5-P9 修复，见 [P9 设计](../09-P9-Codex合并后评审修复.md)。
- CX4：登记已知限制，对齐 P2-S2、P4-S3 与 ADR 的口径；M6 的共用编辑会话层加不下载图片字节的权限复核，表格阅读页、历史预览、文字文档一并覆盖。
- 验证沿用 P7、P8 的做法；托管 Mac 不跑。

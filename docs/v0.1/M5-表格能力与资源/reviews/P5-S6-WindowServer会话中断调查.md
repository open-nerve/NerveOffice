# P5-S6 WindowServer 会话中断调查

2026-11-02。full05 在本机桌面会话崩溃期间失败，暂停后续重型测试。当前定位到 WindowServer 创建图形缓冲区失败后主动中止；尚未识别导致资源累积的客户端，不能宣称与测试无关，也不能据此认定 NerveOffice 产品代码或某个浏览器是根因。P5 尚未验收、合并或关闭。

后续决定：用户在本调查提交 `2b1dc038` 后已批准异常停测保护、小型模拟和只读定位；实施证据见[后续复核](P5-S6-桌面会话保护与图形路径复核.md)。批准不包含恢复真实浏览器或完整门禁，下述事故事实与原始失败不改写。

## 已确认的故障链

以下时间均为北京时间。原始系统报告为 `/Library/Logs/DiagnosticReports/WindowServer-2026-11-02-065819.ips`，取证副本与原件逐字节摘要相同。

| 时间 | 原始证据 | 可确认的事实 |
| --- | --- | --- |
| 06:58:06.827 | 本轮最后一次常规采样 | 可用空间 76.98 GiB、系统 free percentage 57%、swap 为 0、1 分钟负载约 2.85；当时没有记录到测试失败 |
| 06:58:14.708 起的 7.289 秒用例窗口 | WebKit `cleanup-storage.spec.ts` 首条失败 | 专用测试数据库 `127.0.0.1:53522` 连接被拒；这是用例开始时间，不能据此认定数据库错误先于或造成桌面崩溃 |
| 06:58:17–19 | 旧 WindowServer PID 989 系统日志 | 创建 1280×720 的 IOSurface 失败；日志判断尺寸正常时可能是 IOSurface 泄漏并达到系统上限，但没有取得随后标题所指的逐客户端统计行 |
| 06:58:19.125 | launchd 日志与崩溃报告 | WindowServer 自行触发 SIGABRT；调用栈包含 `WSIOSurfaceDebugTallyAndAbort`、`CaptureSurfaceMetal::CreateMetalBacking`、`CompositorMetal::CreateCaptureSurface`、`captureWindowList` |
| 同一秒 | loginwindow 日志 | 明确记录 Window Server 退出，立即关闭桌面会话并重新启动登录窗口；新 WindowServer/loginwindow 均在此时启动 |
| 06:58:26 之后 | 测试错误与 29 份 Playwright 系统报告索引 | 继续启动的浏览器在 AppKit 注册应用阶段中止，属于桌面失效后的后续故障证据，不能反向证明它们造成了最初的崩溃 |

本机 `kern.boottime` 仍为 **2026-10-25 17:23:38**，调查时 uptime 连续超过七天。此次证据指向桌面会话被强制退出，解释了应用消失、看起来像重新开机的现象；没有本次内核重启的记录。

崩溃报告的 `vmSummary` 中 IOSurface 为 **92.1G 虚拟映射、46,528 个 non-coalesced VM region**。这不是 92.1 GiB 物理内存或磁盘占用，也不能把 region 数当作已核实的独立 IOSurface 对象数。故障前约 12 秒仍有 76.98 GiB 磁盘余量，恢复后调查时约 94.58 GiB；当前证据不支持本次由磁盘写满引起，前后差值也不记为本轮清理实际释放量。

## 与旧故障及测试的关系

用户此前提供的 2026-10-23 06:23:41 报告同样是 WindowServer 的 SIGABRT，具有相同的四个图形缓冲创建/捕获关键栈。旧系统为 macOS 27.0（26A428），本次为 27.0.1（26A434）。这证明相同故障类型在升级后复发，不能继续只按升级系统后观察处理；尚不能证明两次由同一个客户端泄漏。

本次发生在长时间浏览器测试期间，存在值得调查的联系。1280×720 只是失败分配的尺寸，窗口捕获调用栈也不标识调用客户端；浏览器渲染/trace、系统图形层或其他使用窗口捕获的进程均未完成归因。没有证据把责任确定归给 WebKit、远程软件或产品业务代码。

当前完整门禁包装器 `s6/gate_helpers.py::run_logged` 每 15 秒采样磁盘及负载，磁盘低于 12 GiB 时停止本轮进程组；外部观察另记普通内存/swap。它没有识别 WindowServer/桌面会话身份变化，也没有图形资源增长的可靠观测或停止条件。测试配置保留 `trace: retain-on-failure` 和 `screenshot: only-on-failure`，macOS WebKit 已是单 worker。已有的串行、磁盘限额和临时文件清理无法覆盖本次失效，不能把清理通过等同于宿主稳定。

## 本轮门禁、代码与资源状态

- 受测提交 `799ac8ec9ee2490bd3e290f55207ccf3d4f7a49e`，主目录仍为 `main@884591c8395b99e2ec4a92fd3a12c9866e423aeb`。恢复调查时主目录和 P5 worktree 均干净，4,726 项源码/形态与冻结输入相符，16 个安装 SDK 未变，没有发现写一半的源码。
- full05 的 737 文件/17,609 项单元与集成通过。浏览器报告为 **2,242 passed、176 failed、79 skipped、0 flaky**，其中 CSV 57 项已通过。79 项不能整体作为许可平台跳过接受；本轮有后续连锁失败及未完成链路，最后依赖 audit 未执行，完整门禁失败。
- 命令日志明确记录 verify 失败，内层 E2E 运行器退出 1。外层包装记录停在 `running`，没有可信最终退出码；保留原始 `run.json`，另记 `wrapperExitCode=null`，不补写成功或虚构最终退出码。当前启动指针已置 `needs-attention`，阻止未经检查再次创建环境。
- 本轮 integration `ab6824c0-c0b7-472c-8b1f-994224585ab7`、E2E `fcedfb30-5c8a-486d-82cd-951b5195841b` 均记录实际 `cleanupStage=complete`；生产者组 97634 已退出，scratch 与短根不存在，严格句柄核对通过。
- 新报告配置检查的 JSON/HTML 两项均通过，实际发布完成；这只证明已知报告环境对象边界，不宣称所有附件都无秘密。此前 full04 的原拒绝状态保持。
- 一个失败 profile 保留 **18,260,621 字节（约 17.4 MiB）**，仍受 7 天、每轮 256 MiB、合计 2 GiB 约束，不冒称所有诊断都已删除。
- coverage、JSON/HTML、trace 等 6,548 个报告文件共 **81,171,169 字节**，经归属/锁/生产者/句柄检查后移入原 full05 的受管 `output/`；逐文件 SHA-256 和长度复核相同，原固定发布目录已腾空。七份系统诊断共 **1,827,019 字节**也移入同一 bulk 归档，遵守 14 天/合计 5 GiB，未作为通过证据 pin 或上传。小型摘要、索引与移动回执保留。
- 调查期间没有启动任何测试、Docker、VM 或浏览器，没有修改系统设置或结束其他应用；本次提交仅落档调查与接续状态。

## 建议的接续边界（尚待用户决策）

先保持完整门禁与容器测试暂停，在现有 P5 分支补充**本轮测试的桌面会话异常停止保护**，并用小型模拟验证正常结束、会话变化、读取失败、中断和归属隔离。停止只能作用于本轮已登记的进程组，沿既有有序退出和严格清理规则；不能杀死全局 WindowServer、浏览器或 Docker，也不能把信号发送成功当作清理完成。

与此同时只读检查图形资源可观测性和实际捕获调用路径，明确哪些指标能可靠取得、哪些无法取得。会话变化保护只能减少崩溃后的连锁启动，**不是预防首次 WindowServer 崩溃的根因修复**；不能凭未经校准的阈值宣称可安全长测。

这一阶段不启动真实浏览器复现、不改浏览器支持范围、断言、跳过、重试或超时，也不将失败记为验收。取得可审查的观测和执行方案后，再决定小范围真实验证及完整门禁的恢复方式；需要隔离执行环境或改变门禁组织方式时单独说明，不能直接用 Chrome 替代 WebKit 或以未来 CI 豁免本机失败。

按 `CLAUDE.md` 对“意料之外的高风险发现”要求，先保存当前工作并说明建议，等待用户决定后实施以上新保护。P5 的 S6、原完整容器、最终同 SHA CI、合并与关闭仍待完成，P6 尚未开始。

## 原件索引与复核

所有外部证据均在主目录 `.codex/handoffs/m5-p5-20261101/s6/`，仅本机留档：

- `host-incident-20261102/evidence-index01.json`：最初取证文件的 SHA-256/长度；摘要 `46fe07205fdefb7c612296214eef4f9ef7bfcf3efe718a70437bfe45356b0088`。
- `host-incident-20261102/diagnostic-relocation01.json`：七份原始系统诊断从取证目录移入下述受管 bulk 的路径映射和字节等价证明；摘要 `daded5a96905eef9d40d902f54b2912cd866d3acc3b851e35c9cc377eb550bb5`。索引中的原路径是采集时位置，实际读取用该映射。
- `host-incident-20261102/prior-crash-comparison01.json`：用户旧附件摘要、时间/系统版本/同栈对照，摘要 `c6dcac350d35995bc3f2b50400d3d4487838aa615eb02766e2e98fa7ac71bba9`。
- `host-incident-20261102/incident-verification01.json`：事件摘录、归档后逐文件核对、原包装记录未变、启动记录和当时空间；摘要 `06bf847b63c289b6dad9d8b9d03c5c0ea1b0d8c8262d442e320c362fd12e03d8`。
- 同目录的 `workspace-and-resources01.json`、`gate-recovery01.json`、`test-failure-summary01.json`、`playwright-crash-index01.json` 和 `host-observations-original01.jsonl`：源码/资源、恢复、实际失败与故障前采样。
- `s6-gates/full05-20261101T202108181615Z/`：原运行记录、命令日志、报告和 `incident-output-source-index.json`；原始系统诊断现位于 `output/host-incident-20261102/`。原包装记录摘要仍为 `44e1c1215858eb13d96fb4aec23c5357e5b32a48b7f6b9d7aefbed323d8c493e`。

本次只读复核已确认原件摘要、逐文件迁移完整性、两个 Git 工作区及源码/SDK、生产者和临时目录状态。文档提交不需要重跑大型测试；复核结果不扩张为 P5 验收或宿主根因已修复。

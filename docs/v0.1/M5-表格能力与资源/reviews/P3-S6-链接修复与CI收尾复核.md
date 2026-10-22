# P3-S6 链接修复与 CI 收尾复核

日期：2026-10-22。承接已提交的 `ab65be50` 调查与用户批准，在唯一 P3 分支实施。局部修复和当前输入 full05/container03 的完整门禁、原件审计已经完成；新合并 SHA 的六项 CI/十份产物、冻结和清理仍待完成，P3 未关闭、P4 未开始。

## 产品修复

旧 viewing 链接菜单在进入单元格正文编辑后仍可操作已提交的单元格，普通取消会覆盖未提交前文。固定 Univer 1.0.1 的桌面/移动控制器现按实际编辑状态及文档、工作表、行、列管理弹层：进入正文编辑撤销旧 viewing 菜单；迟到的工作表回调不能显示旧菜单或关闭新 editing 菜单；编辑 owner 改变时退役旧表单，保留原范围选择器的 keepVisible 语义。ES/CJS 对称，正文命令、保存协议与撤销栈不变，登记为 UR-041。

真实发布包控制器的反例先有效失败，现有焦点回归与新增生命周期回归合计 **45/45** 通过。独立初审发现的 owner 残留、重开仅观察服务器两项均已修正；最终 SDK 复审为 **0 Critical / 0 Important / 0 Minor**。

当前补丁下，Chromium、Chrome、WebKit 各执行原 rich 故事与两条“旧菜单 → 输入未提交前后文 → update/cancel”故事，**9/9 首次通过，零重试/跳过**。断言覆盖精确 rich 命令、文字及范围、撤销/重做、保存和重开后的客户端整格快照。Linux/ARM64 官方 Playwright 镜像另以原 spec/fixtures 跑三条故事，**3/3 首次通过**；其 API 仍在 Mac，不能视作 Linux API 全链或 CI amd64 通过。

## CI 收尾

E2E 分片直接监督原 Playwright CLI，为正常执行保留 90 分钟、报告/夹具退出另留 15 分钟，必要的强制清理最多 1 分钟。外层步骤 115 分钟、job 140 分钟；单例时限、原重试、首次结果要求、项目矩阵和覆盖率门槛保持。

运行以独占目录、随机非秘密 UUID、PID/UID/内核启动 tick 记录归属。CI 专用 API preload 仅在两处白名单 fork 中补此 UUID，不向生产子进程扩散父环境或凭据，也不修改生产模块。独立 settle 步骤必须确认监督器和本轮写入者实际退出，并连续两次扫描为空，才允许归档、比较和上传。正常静默收尾不生成停止记录；可选停止记录的正常缺席不记为损坏。恢复/强杀不产生通过结论。无法确认静止时只上传独立静态诊断快照。

Linux 真实进程反例覆盖快速父退后的孤儿、重复信号、被终止监督器及 PID 归属；最终 **12/12** 通过，零跳过/重试。本机定向单元 **36/36**、定向 lint、tools/e2e 类型检查通过。CI 实现和两处后续语义修正分别独立复审，最终均无遗留 Critical/Important/Minor。当前 full05 全仓覆盖率为行 93.99%、语句 93.92%、函数 94.53%、分支 90.47%，原门槛未变。

真实 Linux WebKit 中断对照把整体预算临时设为 20 秒，原故事及断言不改：一条通过、一条实际中断、一条未开始。原 CLI 退出 1；监督器记录 stopped=true、forced=false、quiescent=true；停止时存在实际浏览器，之后两次独立检查均无浏览器进程。JSON 与 HTML 的案例、结果、六份附件字节一致，trace ZIP 完整；归档中的 **110** 个文件/链接（含 **22** 个硬链接）逐项读回与原摘要一致。Mac 服务正常退出、独占库与诊断容器消失。本轮是预期中断验证，不能计入完整用例通过数量。

## 保留的失败与边界

- 外置 `.ts` 诊断配置首次因 CommonJS/ESM 混用在加载阶段失败，未跑任何浏览器用例；改为明确的 `.mts` 后目录列出三项、三项正式运行通过。未修改正式配置。
- 首轮中断的 Linux 退出/报告/归档已成立，但宿主追踪器在收尾记了异常，整体退出 1。原 catch 只保留布尔值，具体根因无法补证；该轮保持失败。第二轮仅增加错误原因记录，所有失败守卫不变，整体退出 0 且 trackingErrors 为空；不声称已修复首轮未知异常。
- 这些对照只验证 Linux/ARM64 浏览器和正式 CI 监督器；API 在 Mac。完整范围与本机/容器原件已按同一输入核对；GitHub 六项 jobs、十份 artifacts 仍须在新合并 SHA 实际收齐并审计。M4 和原生环境既有挂账不变。

## 原件索引

外部目录 `.codex/handoffs/m5-p3-20261020/s6/` 保留全部中间失败及当前原件：

| 内容 | 原件 |
| --- | --- |
| SDK 反例、45 项回归、三浏览器 9 故事 | `popup-fix-local-evidence01.json`、`popup-lifecycle-independent-review02.md` |
| Linux 正常三故事及 HTML/清理核对 | `linux-link-normal02/`、`linux-link-normal02-audit.json` |
| CI 实现、后续红绿及独立复审 | `ci-shutdown-implementation01/`、`ci-snapshot-contract-followup01/`、`ci-shutdown-independent-review02.md` |
| 真实中断与全部附件/归档读回 | `linux-link-interrupt02/`、`linux-link-interrupt02-audit.json`、`linux-interrupt-audit01/` |
| 宿主追踪异常原轮 | `linux-link-interrupt01/`、`linux-link-interrupt01-run/` |
| 中断驱动审查及修正 | `linux-link-interrupt-review01.md`、`linux-link-interrupt-review02.md` |
| 类型检查 | `ci-types01/` |

补丁 SHA-256：`ffb1af05a7720cfd8d7054034f41ff305095cdf902f3f29d87e967113315b26e`。正常 Linux 原件审计 SHA-256：`fe678255863d50874c703fbc65eb0156663b2ccb68111d6881011eafc6804e02`；中断原件审计 SHA-256：`7797d0e95a1e7ec3a9338a207bfed043c6fbaa4741c694894449bd96ea859a9a`。

## 当前输入完整验收

full05 默认十阶段全部通过：670 文件/16,149 单元与集成，2,394 E2E 首次通过、16 项原身份及原因跳过；其中原富文本和两条未提交正文故事在三浏览器内全部首次通过。container03 默认生产镜像 330/330 首次通过，包含 319 普通场景、4 崩溃恢复与 7 后端重启。两轮全部 4,414 文件及 16 包/30 文件的 SDK 输入相同，各自前后未变；JSON/HTML、首次结果、原跳过、原件摘要、168+4 轮崩溃、933 份 OPFS 归档及容器配置/清理均通过严格审计。完整数据与原件摘要见 [能力报告](P3-能力验收报告.md)。

独立局部准备复核 `s6/final-local-readiness-review01.md` 未发现新增代码问题（0 Critical / 0 Important / 0 Minor），只核对当时已完成的 full05 及代码，不提前接受尚在运行的 container03。容器结束后由主流程完成上述原件审计；结果文档另作精确差异复核。交付 v2 的六份收集/审计/源码等价/关闭脚本经独立准备审查无遗留发现，仅代表准备就绪，不代表实际 CI 已验收。

# P6-S5 WebKit 整批窗口调整复核

2026-11-03。用户已批准 [1a08fe9f 的具体方案](P6-S5-云端首轮结果与WebKit总时限建议.md)，授权记录为主目录 `central-acceptance/webkit-budget-adjustment/user-approval01.json`。本篇只记录这次有限调整，不代表 P6 全 Phase 审查或 M5 验收。

## 实现

- `e2e-cli.ts prepare` 仅在创建 owner 前，将 `E2E_BROWSERS` 交给固定选择函数；精确 `webkit` 为 120 分钟，默认和其他输入保持 90 分钟。返回独立对象，避免一次调用的修改影响其他轮次。
- `prepareRun` 将预算随原独占 owner 写入；已有目录仍拒绝覆盖。`runOwnedCommand` 与 `settleRun` 的计时、原身份、信号、收尾逻辑没有修改，继续读取已登记 owner，不在运行中从环境重新选择预算。
- 原 `ci.yml` 只对 WebKit 使用 step 145 / job 170 分钟；其他浏览器 115/140、verify 与容器 45、退出核验步骤 17 分钟保持。原六项、事件、并发、单例时限、重试判失败、数据规模与资源策略不改。
- job/step 的 timeout 支持 `matrix` 上下文，见 [GitHub 官方上下文规则](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)。工作流测试读取真实 YAML，限定条件表达式，不另造一套表达式执行器。
- 新 `ci03-monitor.py` 只读观察上限为 190 分钟，覆盖 170 分钟 job 及状态同步余量；测试实际预算仍为上面的固定值。新收集器沿用原 GET-only、5 GiB 总量、12 GiB 磁盘余量、独占原件和身份核对，仅更换独立 ci03 文件/归档命名。旧 ci02 脚本和原件不变。

## 小型验证与实际清理

| 轮次 | 结果 | 资源 runId |
|---|---|---|
| 映射/工作流 RED | 预期 3 失败、31 通过 | `5a8a1e7d-ff44-4e29-becd-02e4bbd36dd7` |
| 相关回归 GREEN | 85 通过 | `8ee50808-fb0a-427a-ab16-7a5cf04b0492` |
| 真实 CLI 文件契约 RED | 恢复旧 prepare 接线后，WebKit owner 仍为 90 分钟，预期 1 失败 | `4530e589-a209-48a0-b85a-47cffaf9849e` |
| 最终相关回归/静态 | 7 文件 86 通过，lint 与根类型检查通过 | `d70b0dc1-bf02-421b-9300-5f08227bcdf3` |
| 新收集器边界 | 7 项通过，无网络 | `790ea91b-830d-443d-a699-e3c89ac59d51` |

CLI 文件用例实际启动 Node、创建 owner，核对各分片预算及换环境后重复创建拒绝、原字节保持。macOS 中只为这个文件契约在子进程模拟 Linux 平台入口，**不查询 `/proc`、不发送信号、不启动浏览器**；原非 Linux 拒绝测试仍保持。本机结果不冒称真实 Linux 进程契约通过。

执行裁定：原 Linux 秒级真实进程用例及运行/停止实现不变，本轮原 verify CI 会再次执行它们，包括单次软停、独立收尾、恢复停止和无关进程保护；本机先验证新预算映射、创建前持久化与工作流合同，不为本次几行预算调整另建 Docker 测试环境。若 Linux 真实契约失败，整轮仍失败，不以本机文件模拟放行。

每轮均经 `tools/test-resources/run.py unit`，producerQuiescent=true、cleanupStage=complete、无 cleanupError，scratch/短目录/holds 实际不存在。必要日志仍在各轮受管 reports，索引及摘要为 `webkit-budget-adjustment/verification-result.json`。相关套件的两行“缺少资源检查脚本”来自原故意缺脚本的拒绝样例，断言成功；不将它们隐去或宣称输出没有错误样例。

## 审查与接续

本轮限定独立代码/事实审查已完成，C/I/M=0/0/0；14 件冻结摘要、五轮原验证与实际清理均核对成立，报告为 `webkit-budget-adjustment/independent-review.md`（SHA-256 `bfe1190a44e4929422eff5eeef516b95cb1ba89b365d91cf4ff6eb2d8117db44`）。独审接受上述 Mac 文件契约与下一轮 Linux 实进程验证的分工，未预签真实 CI 成功。

正常提交后仍须经原 pre-push hooks，新 SHA 仅调度一次原六项 CI；原接口 403 不重复盲调，沿已登录网页完成。收集后核对每个分片实际 owner 的固定预算，CSV 完整故事、对照最终附件、最后一条 WebKit 与依赖项目均须真实成立。

本机浏览器长测保持暂停；原失败、Mac 验收、S6 全 Phase 审查/交付、最终 main 同 SHA CI、P6 合并和 M5 完整关闭均未由这次局部调整自动完成。

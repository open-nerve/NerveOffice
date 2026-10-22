# P3-S6 最终 CI 与关闭复核

> 2026-10-22｜已完成｜在 P4 初始分支同步已经发生的 P3 收尾事实。

最终 main 为 `3f498f7bf3e9be3f310820527989c5052909991f`，P3 tip 为 `f74d474818a2a4eaf2794751f285545477bcdfc2`，tree 均为 `0a65d0d3b6ad5dd7adbab935cd8490fecc775de6`。正常中文提交、hooks、`--no-ff` 合并与 pre-push 已执行，只推送 main。2026-10-22 09:58:16 UTC（北京时间 17:58），实际关闭回执四项条件均为 true；随后才建立唯一 P4 分支。

## 受测输入与本机证据

SDK 链接菜单生命周期修复由 full05 默认完整十阶段验证：670 文件、16,149 单元/集成、2,394 E2E 首次通过、16 个原身份与原因的平台跳过。container03 为 330/330 首次通过、零跳过。保存正文、撤销与保存重开均保留回归，没有为 CI 增加重试、扩大跳过或延长预算。

最终提交相对 full05 有七份精确 CI 基础设施增量、十三份结果文档差异，其余 4,394 项输入相同，全部 4,414 路径、Git 类型与模式逐项核对，SDK 字节不变。两份工作流上下文与五份进程 owner 命名空间修正各有红绿、局部验证和独立审查；最终 CI 包含新增的一项配置边界单元测试。因此最终 SHA 未冒称重新跑过本机 full05，完整基线和增量的适用范围分别记录。

## 同 SHA 六项 CI

[CI 39741385675](https://github.com/open-nerve/NerveOffice/actions/runs/39741385675) 为上述 main 的 push、attempt 1；六项全部成功。

| 范围 | 首次通过 | 原平台跳过 |
|---|---:|---:|
| 单元/集成 | 16,150（670 文件） | 0 |
| Chromium | 804 | 4 |
| Chrome | 797 | 4 |
| WebKit | 793 | 8 |
| Edge | 797 | 4 |
| 生产容器 | 330 | 0 |

四浏览器共 3,191 通过、20 个原跳过；无失败、重试、flaky、未运行或全局错误。JSON/HTML 案例、624 份附件及 34 份图片字节材料已核对。四份进程监督快照退出成功、静止、无残余归属进程；219 轮浏览器崩溃与四轮容器崩溃通过。20 份链接故事的外部请求数组为空。覆盖率行 93.96%、函数 94.41%、分支 90.45%，原静态、构建、依赖、许可、产物及预算门禁保持。

六份日志和十份官方 ZIP 共 376,791,965 B，官方摘要一致。四份持久资料通过原 v4 审计逐条验证，独立收尾审查另外绑定压缩包、原审计器、实际执行日志与清单；未宣称独立审查重复解压全部约 12 GB。

## 历史失败与下载接续

之前的 WebKit 用例失败、工作流解析失败、`NERVE_CI_E2E_OWNER` 被正式配置拒绝等原件仍在。最终标记改为已有 `NERVE_TEST_` 命名域，生产配置拒绝未知键的规则未放宽。

末轮 CI 本身成功；大 ZIP 下载中断后，原 watcher 的失败回执仍保留。经独立审查的精确分段下载器于 09:34–09:40 UTC 收齐材料，官方摘要和 ZIP 校验通过；原收集器、原 v4 审计器随后原样执行成功。未重新推送、重跑 CI 或修改旧失败状态。正常推送工具的旧成功文案匹配错误也保留原件，实际远端 SHA、正常 pre-push 和日志由独立审查确认。

## 冻结、清理与实际关闭

证据根为主目录 `.codex/handoffs/m5-p3-20261020/s6/`。

| 证据 | SHA-256 |
|---|---|
| `source-equivalence-3f498f7bf3e9/receipt.json` | `dc71b17c32d0e2878351e5faf83d912cb729e6a211587e21425cf365e28564cf` |
| `ci-39741385675-audit.json` | `de86665d35d58d38b4622fa5b8f44e810ac73cc40e66e9521ed1d9b2845c6054` |
| `ci-39741385675-closing-independent-review01.md` | `0878dcb87530a94755b2e0c5367b07fcdddad389d4db0b00dcb126826ae57949` |
| `p3-final/freeze-receipt.json` | `99dd99bdcda6ed1905646952dc39ff953262aab701a1ea11f7438a6938f6a5c2` |
| `p3-final/raw-manifest.json` | `b67601f3887b70e4e9ccb08c228f15691996dac163b93087f0014c32a7e8c27b` |
| `p3-completion.json` | `038324287406c23a32c36d56f436b60717354c546984ea65ce871bbc8a4faa53` |

独立审查 0 Critical / 0 Important / 0 Minor。冻结 288,181 项后，正常 `git worktree remove` 与 `git branch -d` 完成；主目录始终 main，其他旧分支/worktree 未改。原关闭器重新核对原件与远端 main 后，写出 `phaseClosed`、`ciAccepted`、`evidenceFrozen`、`cleanupComplete` 全 true 的实际回执。

## 关闭后的容量处理

full05 持久资料经独立审查、源摘要复验、压缩与独立解码核对全部 114,815 条目（内容、链接、权限、时间与扩展属性）后无损归档。包位于 `.codex/handoffs/m5-p3-closed-full05-archive-20261022/closed-p3-full05-profiles/persistent-profiles.tar.zst`，268,302,161 B，SHA-256 `7e84ca199b01ae3de7ee35bb83cd7d7d2e8773828e95b9b1f3b2bcc403463cc1`。原位置保留 JSON 与 `ARCHIVED-P3.json`。旧冻结清单与关闭回执未改写；按原展开清单再次审计前须按归档库存恢复。

container03 的固定 11 项可重建 Docker 缓存经逐步快照核对后精确清理，保留所有报告、镜像、卷、容器及旧停止原件。此时 Docker 内部释放空间未立即转化为宿主机同等空间；不以缓存估算替代实际磁盘测量。

P3 工程关闭不代表 M5 里程碑完成。Excel 桌面来源、Safari 原生输入、剩余 Finder 矩阵继续按环境登记挂账；DEF-057 未证明的 formula 旁支、M4 DEF-073/UR-035、完整验收与标签保持。DEF-019/052/056 的本项目实现按实际交付关闭，上游草稿仍未外发；US-M5-14 整项留 P6。

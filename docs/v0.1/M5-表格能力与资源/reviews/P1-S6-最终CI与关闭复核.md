# P1-S6 最终 CI 与关闭复核

> 日期：2026-10-19｜状态：已完成｜本记录在 P2 初始分支同步已经发生的 P1 收尾事实。

P1 最终主分支为 `1f7f7d61edb72081755cb96dd0db6a3df26fdb0c`，唯一 Phase 分支 tip 为 `5f980692fa511825d6e11f09935d2e3fde85a57c`。第二次正常 `--no-ff` 合并保留首次 main `1b89dcfb` 与该 tip 两个父提交，合并树等于 tip 树；正常 pre-push 门禁通过后只推送 main。

## 同一 SHA 的最终结果

[CI 39158571929](https://github.com/open-nerve/NerveOffice/actions/runs/39158571929)的六个 job 均为 attempt 1、success，实际测试、持久资料归档与上传步骤全部成功。六份日志及六份原始报告完整保存，下载摘要与 GitHub artifact digest 相符；独立复核无新增阻断项。

| 范围 | 通过 | 既有平台跳过 | 失败 / 重试 / 未运行 |
|---|---:|---:|---|
| 单元与集成 | 15,235（624 文件） | 0 | 0 / 0 / 0 |
| Chromium | 711 | 4 | 0 / 0 / 0 |
| Chrome | 705 | 4 | 0 / 0 / 0 |
| WebKit | 701 | 8 | 0 / 0 / 0 |
| Edge | 705 | 4 | 0 / 0 / 0 |
| 生产容器 | 283 | 0 | 0 / 0 / 0 |

四浏览器合计 2,822 通过、20 个与本机基线身份及原因一致的平台跳过，无新增跳过、flaky 或全局错误。JSON/HTML 逐例结果一致；79 份崩溃附件、219 轮、1,529 个实际终止的归属进程及 ACK 边界均核对。1,080 个持久 profile、134,848 条归档清单包含 Linux 原生 OPFS；全部常规文件正文已流式读取并记录摘要，保留链接类型，不把本机 macOS 的 OPFS 导出数量套到 Linux。

CI 覆盖率为 lines 94.60%、statements 94.53%、functions 94.79%、branches 91.01%；lint、类型、静态、构建、许可、产物、原预算及生产依赖高危门槛均通过。全依赖统计仍为 low 1、moderate 2、high 1、critical 2，与原基线一致，不表述为零漏洞。既有非生产 fixture/辅助 mjs 覆盖率统计建议仍为非阻断项，下一次调整测试配置时处理。

## 原生 x64 与材料构建

Linux x64 正式镜像核对 Sharp 0.35.5、sharp-libvips 1.3.4、libvips 8.18.7，以及 398 份来源 / 201,994,917 B / 402 份分发文件。44 图片样本为 20 接受、24 拒绝；并发准入 5 成功、5 繁忙，失败后恢复及实际容器强制重建成立。最长上传阶段 1,612.14 ms；整容器 cgroup 峰值 704,372,736 B，4 GiB 限额、OOM=0。这些不是单图片内存或硬预算的替代值。

新 hosted runner 从空 Git 检出最终 SHA，原生材料 Docker 构建层实际执行（12.9 秒，非 CACHED），构建与运行离线复核均通过。15 份仓库固定原件与 383 份外部来源的分工保持；“383 份冷下载”由环境、日志和已审收集器路径共同支持，未作逐 URL 抓包，也不宣称 pnpm 缓存未恢复。

首次 CI 39156360790 的容器因 `native/tiff HTTP 406` 失败，六份日志和报告完整保留。两份既有来源原件固定之后才产生本轮成功，没有改版本、摘要、浏览器范围、重试或质量门槛；详见[冷缓存来源修复](P1-S6-冷缓存来源修复.md)。

## 源码与实际收尾

旧完整本机 verify 保留 `e82d516c` / 4,217 输入的身份，新完整本机容器保留 `629f2ee9` / 4,223 输入的身份。最终 main 的精确对照证明只有四项材料输入及十二份结果文档差异：其余 4,207 输入不变，4,211 非文档输入与新容器受测树相同；旧本机套件没有冒记为最终 main SHA 重跑。最终 SHA 的六项 CI 已真实执行。

主目录证据根为 `.codex/handoffs/m5-p1-20261018/s6/`，依次保存：`ci-39158571929-audit.json`、`task5-ci-final-review.md`、`task5-ci-ready-02.json`、`p1-final-20261019/freeze-receipt.json`、`task5-cleanup-ready.json` 和 `p1-completion.json`。原件清单 51,231 条，134 份 ignored 执行记录/实验原件另作逐字节持久副本；S6 Task 1–5 完成 ledger 已保存。

2026-10-19 05:11（Asia/Shanghai），正常 `git worktree remove`、`git branch -d` 和实际 task-done 完成后，最终回执确认 `phaseClosed`、`ciAccepted`、`evidenceFrozen`、`cleanupComplete` 全部为 true。P1 worktree/分支已不存在；其他 worktree/分支未变，主目录保持 main，未创建 M4/M5 标签。

P1 关闭仅覆盖资源底座。P2 的真实 Finder 拖放、真实 Excel 来源、授权 Chrome 右键粘贴，以及 SDK 主动重读与旧图清理条件继续有效；DEF-004 未关闭。M4 的 DEF-073/UR-035、完整验收和标签仍单独挂账。

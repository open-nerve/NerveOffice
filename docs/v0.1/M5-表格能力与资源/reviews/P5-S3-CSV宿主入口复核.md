# P5-S3 CSV 正式宿主入口复核

2026-11-01，基于 S2 `bd7ac04d8a8c860daf505005c0f4f071b89d6e04` 完成 S3。独立审查 C/I/M = 0/0/0，接受本 Step 并继续 S4；P5 整体尚未完成。

## 实现

- 正式页头开放导入/导出；中文按钮选择文件，预览总行列及最多 8×8 格、每格 80 字符。完整矩阵仅在本轮控制器内存，取消和失效立即释放；不进入 React 状态、URL、日志或额外存储。
- 原 SDK 实例、模式、租约、writeEpoch 与页面会话均绑定到同一操作。普通同身份确认可保留预览；失权、换人、令牌变化、隐藏或销毁使旧操作作废。每个异步阶段和最终写入前都复核，重复点击不会插第二张表。
- 确认前不提交旧输入；确认后沿原输入、面板、公式准备流程再一次插表。后续 CSV 拒绝保留已正常提交的原文字。导入仅修改正常模型，原本地/云端保存通道负责落盘。
- 只读或离线可导出当前身份下的稳定显示内容；选表、公式保护及安全文件名在下载前明确。Blob URL 与临时 anchor 在成功和异常路径释放。
- CSV Dialog 的 portal 在页头范围内，既有交互屏障和输入观察器仍适用；默认 Dialog 行为不变。无可操作目标时不添加无用页头按钮，全部旧页头断言保留。

## 验证

最终输入为主目录 `.codex/handoffs/m5-p5-20261101/s3-source-input03.json` 的 17 个源码/测试文件，SHA-256 `20c3b679a479aa458caeb79c7e1abaacb000c2f780b518b2bc859e6ddbc50f3f`。

- 定向 lint 与全仓 typecheck 退出 0，日志为 `s3-lint07.log`、`s3-typecheck05.log`。
- 受管全仓单元 run `53bac9c3-c3e5-4fc9-9a10-9cc1ba19e797`：586 文件、11,847 项通过，零失败/待执行，151.98 秒；4 workers 控制负载，范围、断言、超时保持。JSON SHA-256 `d66d9813b8a21b29cb7da3d6fff23eace0054f971f4ed7e2fd98f15a0d8338a1`，索引 `s3-unit-full01.json`。
- 正式 `pnpm test:e2e specs/editor/csv.spec.ts --project=chromium --workers=1`，run `26683a6a-e339-4f93-8bc7-315741893a5b`：3 项首过、零跳过/flaky/失败，14.9 秒。覆盖实际中文按钮 filechooser、解析失败/取消不变、旧输入保留、一次撤销/重做、正常保存重开，以及只读离线选表下载真实 BOM/引号/TAB/负数字节、无新保存或编辑权请求、服务器正文和修订不变。JSON SHA-256 `b2c593a2cd565209a21b3d0c4174a14c1fecff7b3e425a0d5aa8e894ba9aaab4`，索引 `s3-e2e02.json`。
- 两轮 `passed / exitCode=0 / producerQuiescent=true / cleanupStage=complete`，scratch 与短目录实际不存在；E2E 本轮后端和测试库已退出/删除。未创建 VM，未保留完整 profile。磁盘约 95 GiB 可用，重型验证串行。
- 独审直接核对源码、原始 JSON/摘要/清理目录并查看实际预览截图，接受 C/I/M=0/0/0。报告 `s3-independent-review01.md`，SHA-256 `73475c1f7ed2f65a5f6b98c97cfb4e44917a5461d94d5069f05da5604ed42fc2`。

旧输入的通过与 RED/首轮失败保持历史事实，不替代 input03 最终接受。普通测试报告沿 14 天/5 GiB 策略保留，不逐轮 pin；摘要、计划、审查与索引保留，最终 Phase 必要证据在 S6 审查后 pin。正常中文提交回执另存 `s3-commit01.json`。

## 后续边界

S4 新建文档/幂等创建/同页内存交接，S5 三浏览器完整故事、真实 SEQUENCE 在 Worker/主线程计算后导出及容器，S6 全 Phase 独审、原完整门禁和同最终 SHA CI 均未验收。Excel 等原生环境缺口与 M4 欠账继续保持；本 Step 不构成提前合并 P5 的依据。

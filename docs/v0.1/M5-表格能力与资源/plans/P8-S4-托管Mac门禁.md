# P8-S4 托管 Mac 门禁：实施计划

> 日期：2026-11-07｜所属：M5-P8 S4｜依据：[P8 设计](../08-P8-M5完整收官.md) §3.4、[P6 Mac 平台待验交接](../handoffs/P6-Mac平台待验交接.md)、S3 探测（run `42252502692`，原件在主目录 `.codex/handoffs/m5-p8-20261106/s3/`）

## 1. 探测结论

| 项目 | Intel 版 `macos-26-intel` | Apple 芯片版 `macos-26` |
|---|---|---|
| 机型 | i7-8700B，4 核，14 GB 内存，macOS 26.6.1 | M1（虚拟），3 核，7 GB 内存，macOS 26.6.2 |
| 可用磁盘 | 136 GiB（结束时 130 GiB） | 96 GiB（结束时 92 GiB） |
| 图形会话、钥匙串、sudo | 有 Aqua 会话，登录钥匙串已解锁，sudo 可用 | 同左 |
| lsof（普通权限与 sudo 各 3 次） | 全部退出码 0、stderr 为空 | 同左 |
| PostgreSQL 18.6（Homebrew） | 安装、建库、启停正常 | 同左 |
| Docker | colima 约 4 分钟起好；`ci.yml` 同一摘要的 `postgres:18.6-alpine` 能拉取并运行 | 起不来（不支持嵌套虚拟化） |
| Playwright 三个浏览器 | Chromium、Chrome、WebKit 都能启动 | 同左 |
| Safari 与 safaridriver | 26.6，可启用 | 26.6.2，可启用 |

选 Intel 版作为验收环境：只有它能起 Docker（`pnpm db:up` 与生产容器组合都要用），内存也够 ESLint 单独要的 6 GiB。Apple 芯片版装不下原范围，不用。验收结论只覆盖 Intel 版托管 Mac 的这份输入，与开发机的芯片架构不同；这一点写进交接。

## 2. 方式：照开发机的样子跑本机门禁

托管 Mac 按开发机的方式运行，不走 Linux CI 的托管 VM 路径：

- **不设 `CI`**：步骤环境里把 `CI` 置空。Playwright 配置因此与开发机相同：不重试；浏览器默认 Chromium、Chrome、WebKit；darwin 上 WebKit 单 worker；没有 GitHub 报告器。
- **资源工具用默认的严格本机模式**：不设 `NERVE_TEST_RESOURCE_POLICY`。删除前核验、真实删除与回收核对都照本机执行，比托管 VM 的“待宿主回收”更严；也不需要为托管 Mac 另立合同，`hosted.py` 不变。
- **lsof** 用默认的普通权限命令（探测中全部退出码 0）；Q-10 收紧后，任何退出码 1 都会判为不完整。
- **数据库**：在 colima 起的 Docker 上执行 `pnpm db:up`，与本机相同的开发库编排和镜像摘要。
- **会话保护**：`run.py` 的 darwin 会话保护照常生效，会话变化即停。

## 3. 分片

本机完整门禁串行跑完约需 4 小时以上，接近托管 job 的 6 小时上限，所以照 CI 的做法分片并行：

- `verify`：`pnpm verify --keep-going --scope=no-e2e`
- `e2e`：按 Chromium、Chrome、WebKit 各一个 job，`E2E_BROWSERS=<浏览器> pnpm verify --keep-going --scope=e2e`。崩溃项目随浏览器走，重启项目只在 Chromium 那一片。
- `container`：`pnpm test:e2e:container`（默认 Chromium）

这需要让本机模式也能分片：

- `--scope` 原先只许与 `--ci` 一起给。原因是本机完整门禁先有一步 `pnpm db:up`，而分片都不含它，本机直接分片会连不上库。
- 改为本机模式的两个分片都先执行 `db:up`：`no-e2e` 的内容是 lint、typecheck、静态门禁、`db:up`、`test:verify`、clean、build、产物门禁；`e2e` 的内容是 `db:up`、clean、build、测试构建、E2E。
- `plan.test.ts` 补本机模式的核对：两个分片合起来（去掉重复的 `db:up`、clean、build）恰好等于本机完整门禁。CI 模式不变。

## 4. 工作流

`mac.yml` 的探测 job 换成上述五个门禁 job，都跑在 `macos-26-intel` 上，`fail-fast: false`。每个 job 依次：

1. 检出代码；verify 取完整历史，迁移门禁要用。
2. 记环境事实：`ci_mac_probe.py system`。
3. 安装 Node 与 pnpm，安装依赖。
4. 安装 colima、docker 与 docker-compose，把 compose 插件链接到 `~/.docker/cli-plugins/`，然后启动 colima。verify 与 e2e 用 2 核、3 GB；container 用 3 核、8 GB，生产镜像的构建在里面完成。
5. 仅 e2e：安装本片的 Playwright 浏览器。
6. 运行门禁，`CI` 置空；verify 的 `GATE_MIGRATIONS_BASE` 与 `ci.yml` 相同。
7. 记结束时的环境：`ci_mac_probe.py final`；上传报告（`if: always()`）。上传内容为 E2E 的 JSON/HTML 与结果目录（不含持久资料目录）、覆盖率报告，以及本轮台账 `run.json`。

**时限**：job 用托管平台上限以内的固定值（verify 120 分钟，e2e 330 分钟，container 150 分钟）。用例、断言、重试与 Playwright 自身的时限都不改。

**触发**：仍只由推送本分支触发，合并后可手动触发。

## 5. 接受与失败处理

- **接受**：五个 job 全部成功；verify 的步骤汇总注解全部通过；E2E 报告零失败、零 flaky、只有原平台跳过；容器 E2E 首过；台账全部 `cleanupStage: complete`。原件下载后核对与源码的对应，经独立接受后，才关闭 DEF-074 的 Mac 门禁部分。
- **产品或测试失败**：按根因修复，以新 SHA 接续，不重跑失败的 SHA。
- **托管环境本身的问题**：例如 colima 起不来、磁盘不足、job 超时，属于环境问题。停下汇报，不改断言、时限或范围求通过。
- **未知的资源、身份或会话异常**：停止。

## 6. 文档

- P8 设计 §3.4 与 ADR-026 的 P8 附录，由“另立托管 Mac 合同”改为“照本机严格模式运行”，并写明理由。
- `test-resource-lifecycle.md` 补托管 Mac 的运行方式。
- 实施记录写 S4 的实现与验证。

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

~~选 Intel 版作为验收环境~~（初版的选择，已由下面的修订取代）：当时的理由是只有它能起 Docker（`pnpm db:up` 与生产容器组合都要用），内存也够 ESLint 单独要的 6 GiB。

**修订（2026-11-07，需求方决定）：只管 Apple 芯片，Intel 版不在范围内。** 现在的 Mac 都是 Apple 芯片；原生图片也只核对了 darwin-arm64（ADR-021），Intel 版本来就不是交付平台（S4 独立审查 C-1 因此不再成立）。第 2 轮在 Intel 版上的实测也表明它太慢（no-e2e 超过 100 分钟）。验收环境改为 Apple 芯片版 `macos-26`：

- 数据库不用 Docker，改由工作流用 Homebrew 装同一版本的 PostgreSQL，按开发库的设置起库（S3 已证实 Homebrew 的 PostgreSQL 18.6 可装、可建库、可启停）；
- 生产容器 E2E 在这里跑不了，由 Linux CI 照旧覆盖，Mac 上的这部分列入 M5 收官前的裁决；
- 内存只有 7 GB，ESLint 单独要 6 GiB 的旧生代上限，装不装得下要实测；装不下就停下汇报，不改 lint 的规则、范围或上限。

## 2. 方式：照开发机的样子跑本机门禁

托管 Mac 按开发机的方式运行，不走 Linux CI 的托管 VM 路径：

- **不设 `CI`**：步骤环境里把 `CI` 置空。Playwright 配置因此与开发机相同：不重试；浏览器默认 Chromium、Chrome、WebKit；darwin 上 WebKit 单 worker；没有 GitHub 报告器。
- **资源工具用默认的严格本机模式**：不设 `NERVE_TEST_RESOURCE_POLICY`。删除前核验、真实删除与回收核对都照本机执行，比托管 VM 的“待宿主回收”更严；也不需要为托管 Mac 另立合同，`hosted.py` 不变。
- **lsof** 用默认的普通权限命令（探测中全部退出码 0）；Q-10 收紧后，任何退出码 1 都会判为不完整。
- **数据库**（修订）：工作流在门禁之前用 Homebrew 的 PostgreSQL 起库，版本、账号、库名、初始化参数与端口取自 `deploy/dev/compose.yaml`，认证照开发库的镜像（本机套接字免密、TCP 要密码），测试连库的地址与开发机相同。`pnpm verify` 新增 `--external-db`：本机模式下数据库由外部提供，不执行 `pnpm db:up`；与 `--ci`、`--fast` 同给时拒绝（那两种模式本来就不启动数据库，给了会被悄悄忽略）。
- **会话保护**：`run.py` 的 darwin 会话保护照常生效，会话变化即停。读进程表的时限由 2 秒放宽到 10 秒（需求方 2026-11-07 批准，超时仍按失败关闭），台账记读取次数与最慢一次的耗时。

## 3. 分片

本机完整门禁串行跑完约需 4 小时以上，接近托管 job 的 6 小时上限，所以照 CI 的做法分片并行：

- `verify`：`pnpm verify --keep-going --scope=no-e2e --external-db`
- `e2e`：按 Chromium、Chrome、WebKit 各一个 job，`E2E_BROWSERS=<浏览器> pnpm verify --keep-going --scope=e2e --external-db`。崩溃项目随浏览器走，重启项目只在 Chromium 那一片。
- ~~`container`：`pnpm test:e2e:container`（默认 Chromium）~~（修订：Apple 芯片版起不了 Docker，去掉）

这需要让本机模式也能分片：

- `--scope` 原先只许与 `--ci` 一起给。原因是本机完整门禁先有一步 `pnpm db:up`，而分片都不含它，本机直接分片会连不上库。
- 改为本机模式的两个分片都先执行 `db:up`：`no-e2e` 的内容是 lint、typecheck、静态门禁、`db:up`、`test:verify`、clean、build、产物门禁；`e2e` 的内容是 `db:up`、clean、build、测试构建、E2E。
- `plan.test.ts` 补本机模式的核对：两个分片合起来（去掉重复的 `db:up`、clean、build）恰好等于本机完整门禁。CI 模式不变。
- 修订：带 `--external-db` 时，完整门禁与两个分片都只少 `db:up` 一步，两片合起来等于开发机的完整门禁去掉 `db:up`（`plan.test.ts`、`mac-workflow.test.ts`）。

## 4. 工作流

修订后 `mac.yml` 有四个门禁 job（verify 与 e2e 的三个浏览器），都跑在 `macos-26` 上，`fail-fast: false`。每个 job 依次：

1. 检出代码；verify 取完整历史，迁移门禁要用。
2. 把 `python3` 换成 macOS 自带的 `/usr/bin/python3`，与开发机相同。托管镜像默认的 python3 是 3.15，测试资源工具的回归在那里与开发机分叉（第 3 轮，见实施记录）。Node 与 pnpm 的版本由仓库固定，Python 没有固定，开发机用的是系统自带的那个。
3. 记环境事实：`ci_mac_probe.py system`。
4. 安装 Node 与 pnpm，安装依赖；仅 e2e：安装本片的 Playwright 浏览器。
5. 起数据库：`brew install postgresql@18`，`initdb`（开发库的初始化参数，本机套接字免密、TCP 用 scram-sha-256，时区 UTC），`pg_ctl` 在 127.0.0.1:54318 启动，建 `nerve_office`，核对版本与开发库相同。两类 job 的这一步完全相同。
6. 运行门禁，`CI` 置空；verify 的 `GATE_MIGRATIONS_BASE` 与 `ci.yml` 相同。
7. 记结束时的环境：`ci_mac_probe.py final`；上传报告（`if: always()`）。上传内容为 E2E 的 JSON/HTML 与结果目录（不含持久资料目录）、覆盖率报告，以及本轮台账 `run.json`。

初版的第 4 步（装 colima、docker 与 compose、buildx 两个插件并起 Docker）随 Intel 版一起去掉；第 2 轮 run `42256375539` 的容器 job 因缺 buildx 失败、补上之后未再在 Intel 版上运行。

**时限**：job 用托管平台上限以内的固定值，两类 job 都是 330 分钟、门禁步骤 300 分钟（初版 verify 的 100 分钟在 Intel 版上不够）。用例、断言、重试与 Playwright 自身的时限都不改。

**触发**：仍只由推送本分支触发，合并后可手动触发。

## 5. 接受与失败处理

- **接受**：四个 job 全部成功；verify 的步骤汇总注解全部通过；E2E 报告零失败、零 flaky、只有原平台跳过；台账全部 `cleanupStage: complete`。原件下载后核对与源码的对应，经独立接受后，才关闭 DEF-074 的 Mac 门禁部分（生产容器 E2E 的 Mac 部分除外，交需求方裁决）。
- **产品或测试失败**：按根因修复，以新 SHA 接续，不重跑失败的 SHA。
- **托管环境本身的问题**：例如 PostgreSQL 装不上或版本不同、内存不够 ESLint、磁盘不足、job 超时，属于环境问题。停下汇报，不改断言、时限或范围求通过。
- **未知的资源、身份或会话异常**：停止。

## 6. 文档

- P8 设计 §3.4 与 ADR-026 的 P8 附录，由“另立托管 Mac 合同”改为“照本机严格模式运行”，并写明理由。
- `test-resource-lifecycle.md` 补托管 Mac 的运行方式。
- 实施记录写 S4 的实现与验证。

# P6-S4 Linux 隔离运行器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans。按任务执行并记录实际结果，不另开 Phase 分支。

**Goal:** 在原生 Linux arm64 中依次运行 1 条请求观察校准和 13 条 US-M5-14 故事，同时证明源码、SDK 字节及资源闭合。

**Architecture:** 外层继续使用 `run.py container` 和 `ContainerRunResources` 的 UUID、标签、生产者及严格清理协议。容器只挂本轮 scratch；固定浏览器基础镜像、独立 PostgreSQL、只读 Node 工具链和提交源码副本。内层 E2E 仍经既有 `run.py e2e`，结束后外层先闭合容器，再核验、提取有界报告。

**Tech Stack:** Node 24.21.0、pnpm 12.6.0、Playwright 1.63.0、Ubuntu 24.04、Docker Linux arm64；Python 标准库用于源码与证据处理。

**Spec:** [已批准恢复建议](../reviews/P6-S4-浏览器长测恢复建议.md)。2026-11-02 用户批准 Linux 隔离准备与小范围校准；原本机长测和全量 Gate 仍暂停。

## Global Constraints

- 主目录保持 main，所有变更留在 `codex/m5-p6-closeout`；中文提交，原钩子照常执行。
- 不修改产品断言、timeout、retry、trace、截图和浏览器支持范围；不安装 Chrome/Edge 或启用 amd64 模拟。
- 只运行 Chromium、一个 worker；校准失败不进入故事，任一失败不自动重试。
- runner 4 GiB / 3 CPU，数据库 512 MiB / 1 CPU；Docker Desktop 现有 8 GiB 分配不自行调整。用户愿协助调资源，先提供实测依据。
- 每 2 秒尝试采样本轮 scratch、容器可写层、数据库卷与本轮新增镜像；16 GiB 是停止阈值，允许采样/停止等待超调；宿主 12 GiB 可用空间独立检查。
- 不挂 Docker socket、用户浏览器目录或原源码目录；不使用 privileged、宿主 IPC/PID/network 或 sudo。
- 既有 Node/PostgreSQL 镜像只读借用，缺少时停止；新 Playwright 镜像在拉取前单独登记，固定 digest，单项 5 GiB 上限。
- 新镜像结束后仅在 daemon、digest/ID、引用及容器使用情况可核实且未共享时非强制删除该 digest 引用。若被共享则保留并记录；未知或拉取未闭合则阻止新拉取，最长 14 天/5 GiB，到期不能无界追加。绝不全局 prune。
- 成功、失败、中断均先确认 Docker 生产者和容器闭合；不确定则保留并阻止重试。已退出容器的报告只提取 JSON/HTML、trace/截图、日志、源码与 SDK 证明，最多 5 GiB；不复制 node_modules、数据库或 profile。

## Review Focus

1. 中途信号或 Docker 客户端退出，容器仍可能继续写：先严格删除本轮容器，再提取报告。
2. 镜像已存在、其他容器正在使用、daemon/引用变化：不删除共享或未知对象，不根据名字认领。
3. 源码副本混入未提交改动、路径链接或 SDK 安装与补丁不同：拒绝执行或拒绝通过。
4. 只有部分用例运行、跳过/重试或报告带环境凭据：不能计为 14 条通过，保留失败原因并停止。
5. 磁盘阈值、采样失败、超限和重启遗留：停止创建，记录实际清理状态；重复清理不得误删其他轮。

## Task 1：固定执行计划、源码及证据边界

**Files:** `tools/src/deploy/linux-browser.ts`、对应单元；`tools/test-resources/linux_browser_evidence.py`、对应 Python 单元。

**Interfaces:** `browserPlan(project, scratch, labels)` 生成固定 Docker 参数；`budgetProblem(sample)` 返回停止原因；Python CLI `snapshot/verify/patches/collect` 对源码与报告执行有界核验。

- [x] RED：用 KiB 样例覆盖未提交/越界链接源码拒绝（仓内受跟踪的许可证相对链接保留并证明）、源码漂移、补丁字节错误、报告环境泄露/不完整结果及边界预算。
- [x] GREEN：实现源码副本与清单、16 组 SDK 补丁证明、报告校验；不导入 P5 硬编码脚本。
- [x] 验证：经 `run.py unit` 运行新增 Python 与 Vitest 用例；预期全部通过，资源实际清理。

## Task 2：编排与中断清理

**Files:** `linux-browser-cli.ts`、`linux-browser-cache.ts` 及单元；`tools/test-resources/linux_browser_guest.py`；根 `package.json`。

**Interfaces:** 复用 `ContainerRunResources.reserve/producerIntent/producerStarted/producerStopped/cleanup`；镜像独立台账与父 run 同目录，保留至核验终态；guest 仅接受固定计划。

- [x] RED：模拟成功/失败/中断、共享镜像、daemon 改变、重复释放；断言危险条件下无删除、后续组不启动。
- [x] GREEN：创建前登记网络/卷/容器及镜像意图；异步串行长命令、受限查询和 2 秒预算监测；失败也走同一清理路径。
- [x] guest 固定安装与构建后先校准、再故事；保留各组原始报告、内层回执、版本与字节证明。
- [x] 验证新增用例及既有容器归属/生产者协议回归、lint、tools 类型检查；不创建真实浏览器/大型环境。

## Task 3：持久规则、独审和真实校准

**Files:** `AGENTS.md`、`docs/testing/test-resource-lifecycle.md`、P6 当前状态/复核记录。

- [x] 写入 `pnpm test:e2e:linux` 的固定范围、资源上限和回收规则；保存批准与实际环境事实。
- [x] 独立审查上述实现，修复并定向复验；中文提交，源码 clean 后才用于真实校准。
- [x] 经新入口执行 1+13 条；任一失败停止，记录版本/用例数/原始报告/资源与磁盘结果。pilot05 固定 67dc1949 全部首过，旧 pilot01–04 失败保留；内外层临时环境均实际清理。
- [x] 审阅实际证据，再提出 S5/最终集中验收清单；本步骤不隐式恢复全量或本机浏览器。pilot05 独立证据复审 0/0/0 已接受，必要归档已 pin；下一段 29 条清单见[结果与后续清单](../reviews/P6-S4-Linux校准结果与后续清单.md)，待用户确认。

## 自审与执行记录

三任务共享父资源协议；源码/SDK 校验先于浏览器启动，外层容器闭合先于证据提取。镜像是单独登记的有界缓存，不能把旧共享镜像或 Docker VM 全局占用算成本轮释放。父/子报告不伪造为同一个测试 run。

2026-11-02：自审通过，按已有自主推进授权直接实施；不重复请求批准。Docker 已恢复，daemon 为 `dea60ff1-9840-4bd2-8668-dcac4523a95a`，Linux aarch64、约 7.75 GiB RAM；没有拉取镜像或启动测试容器。实施证据落 `.codex/handoffs/m5-p6-20261102/s4/`，不覆盖旧原件。

审查修正：统一 env 专用子目录并用真实父协议验收；受跟踪仓内许可证相对链接保留且与目标字节共同证明；新增持久 evidence hold，未知/拒绝原件阻止父清理和下一轮；成功要求 guest 正常退出及所有前后证明，镜像台账使用原始字节指纹拒绝替换。

## Task 4：首轮断点后的内部卷接续（2026-11-02 已批准）

依据 [首轮调整方案](../reviews/P6-S4-Linux首轮预检断点与调整方案.md)，用户批准一次 Docker 重启及内部卷接续。实际重启已恢复原三个服务；旧 scratch 已经严格句柄核验后清理，约 1.1 MB 原失败证据保存，浏览器实际执行数仍为零。以下更新替代上文宿主 scratch 挂载与先删卷后导出的顺序。

- 本轮 `_assets` 内部卷承载源码、依赖和浏览器临时文件。Node 镜像在同轮准备容器中把工具链复制到内部卷子目录，runner 只读挂载该子目录；源码与清单通过 Docker cp 传入，禁止宿主 bind mount。Docker 官方 [卷子目录规则](https://docs.docker.com/engine/storage/volumes/#mount-a-volume-subdirectory) 要求先创建子目录，再创建 runner。
- bootstrap 安装容器内 tini，不使用 Docker 注入 init。guest 在安装依赖前和 pnpm 就绪后执行既有完整 lsof 格式/映射预检；错误不被忽略。
- 收尾改为“本轮生产者退出 → 核验并停止所有本轮容器 → 有界流式导出证据 → 复核 → 实际删除容器/卷”。[Docker cp](https://docs.docker.com/reference/cli/docker/container/cp/) 支持停止的容器；归属或导出不明则保留卷与 hold，并阻止同类重试。
- 导出仅接收证据、内层原始 run.json 与必要日志；拒绝越界、链接、特殊文件、重复项及超限，不把数据库、依赖或完整 profile 写到宿主。传输与证据字节上限均明确，临时文件属于父 scratch。
- 整轮采样包含内部卷和导出副本；固定镜像保持 5 GiB 保守预留，并核对 Docker 显示容量上界。仅与固定 digest 完全一致的 tag 可视为本轮别名，其他引用仍保留。
- 先以 KiB 夹具验证卷参数、顺序、失败保留、流式边界及镜像策略，再独审、正常提交，最后继续原定 1+13。原验收要求不变。

Task 4 局部修正：pilot02 安装前预检通过，pnpm exec 提前触发自动安装/prepare。先完成原 frozen/ignore-scripts 安装，再运行 pnpm 存活时的完整句柄预检；用真实 pnpm 的无外部依赖小样例验证，不修改镜像、资源协议、验收或超时。原失败和实际清理证明保留。

Task 4 资源根修正：pilot03 的安装/两次预检/构建通过，原 Store 拒绝准备命令提前创建的无 owner 目录。移除这处手工创建，guest 用原 Store 初始化；未知目录仍拒绝。真实准备命令与 Store 的微型集成反例先 RED 后 GREEN，实际 14 条仍待接续。

Task 3 实测接续：pilot04 进入浏览器，原 14 条中 12 通过、2 条命中 S3 新增的原始 data IMAGE 输入与通用快照哨兵冲突。按[局部复核](../reviews/P6-S4-图片来源夹具与快照断言复核.md)精确核对并扣除已知输入的断言视图，其他字段继续全量拒绝额外地址；原真实失败保留，局部回归与独审后再运行同一范围，不扩展平台或门禁。

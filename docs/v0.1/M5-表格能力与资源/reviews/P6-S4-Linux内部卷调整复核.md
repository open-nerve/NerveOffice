# P6-S4 Linux 内部卷调整复核

2026-11-02。用户已批准 [首轮调整方案](P6-S4-Linux首轮预检断点与调整方案.md)，本次在同一 P6 分支实施，不重新申请已经批准的维护步骤。**本文仅确认准备与局部回归；新一轮 14 条真实校准尚未执行，M5 未验收。**

## 维护与旧原件

受控 Docker Desktop 重启只执行一次，原三个服务恢复，PostgreSQL/Redis 重新 healthy，原停止容器仍停止；未修改资源设置。旧虚拟机退出后，完整句柄核验通过，pilot01 的 scratch 和短目录已实际清理。必要原件 1,101,171 字节经稳定字节核对后归档，原内层失败台账没有改写；浏览器执行数仍为零。主目录 `s4/docker-restart-result01.json`、`pilot01-cleanup-after-restart01.json` 与 `pilot01-failure-archive/archive-index.json` 位于 `.codex/handoffs/m5-p6-20261102/`。

清理步骤前后可用空间分别为 92,237,393,920 与 94,184,898,560 字节，净增约 1.81 GiB；该数是同一时间窗口的实际文件系统变化，不等同于目录逻辑大小。Playwright 固定镜像仍有界保留供接续，不计为本次已释放。

## 实现及审查修正

- 源码、依赖和浏览器临时文件改到本轮登记的 `_assets` Linux 卷；Node 工具链由固定镜像准备，只读挂载子目录。宿主不再 bind 工作目录。容器内 tini 替代 Docker 注入 init，安装前与 pnpm 存活时使用原完整 lsof 预检，不忽略未知映射。
- 收尾顺序为全部本轮生产者退出、精确容器 ID 集合核验并停止、有界流式导出、实际删除容器和卷。导出保留原 run.json、实际 reports/command.log 和必要清单；未知残留、空/仅锁的 UUID 目录都继续阻止清理。
- tar 接收拒绝越界、链接、特殊文件、重复路径、GNU sparse、过大扩展头和超限。两流总 payload 5 GiB；每流元数据 64 MiB/10 万项，整轮最多 128 MiB/20 万项。完整 profile、依赖和数据库不写到宿主；原台账/日志每件 4 MiB、合计 16 MiB。报告总量包含索引和内层原件，并为父日志等保留 64 MiB。
- 停止任一 writer 失败仍尝试其余已核验的完整 ID，随后保留失败与卷；计量器始终尝试停止。全停后冻结卷及可写层快照，导出期间继续每 2 秒尝试计量宿主新增副本，在导出前后及删除前重新核对 Docker 身份/停止状态。
- 这避免了导出流与容器 inspect 争用锁的风险：官方 [archive 实现](https://github.com/moby/moby/blob/master/daemon/archive_unix.go) 在流结束才解锁，[inspect 实现](https://github.com/moby/moby/blob/master/daemon/inspect.go) 也取得同一容器锁；这是源码推导，未宣称实测复现长流阻塞。
- 固定 digest 的同名 tag 不再误判为其他共享引用；其他引用仍保留。整轮维持 5 GiB 镜像预留并核对显示容量上界，不用压缩 inspect Size 降低预算。

增量独审发现的原件发布遗漏、残留存在性丢失、停止链提前退出及导出锁竞争已逐项修正；对应边界有 KiB 级回归，最终限定复核 C/I/M=0/0/0。当前接续文档已同步实际维护状态，历史失败不覆盖。

## 验证与接续

- TypeScript Linux 与既有容器归属/进程编排共 5 文件、109 项通过；lint、tools 类型检查通过。
- 首轮 418 项资源回归中一项既有用例因宿主 PID 31582 的不完整 lsof 格式失败。后续只读核对该进程为系统 duetexpertd，完整查询已正常；保留原失败，未排除该 PID 或修改规则。补齐上述边界后的完整资源复验 425 项通过。
- 本次 20 轮受管记录已核对，临时目录均实际清理，无 cleanup-pending。源码指纹、运行 UUID 和失败观察分别见 `s4/volume-preparation-verification01.json` 与 `volume-unit-full01-observation.json`。

接下来正常中文提交，工作区 clean 后使用 `pnpm test:e2e:linux` 继续已批准的固定 1+13 条校准；任一失败停止，不自动重试。现有 Docker 资源分配保持，本机浏览器、完整 Gate、生产容器全量与最终 CI 仍未恢复或签署。

## pilot02：依赖安装顺序修正

固定提交 `8ac7d976` 的第二轮 UUID 为 `1e9e0de3-3ce7-431a-8fea-9979763a6bbc`。内部卷上的安装前完整 lsof 预检通过；新增的 `pnpm exec` 在显式依赖安装之前运行，pnpm 12.6.0 自动安装依赖并触发根 `prepare`。源码副本没有 `.git`，因此 `lefthook install` 失败；浏览器实际执行数仍为零。原件索引见 `s4/pilot02-result.json`。

这是入口顺序错误。修正为先完成原 `--frozen-lockfile --ignore-scripts --store-dir /owned/pnpm-store` 安装，成功后再以存活 pnpm 执行原完整句柄预检；失败立即停止。未改变宿主提交钩子、依赖版本、供应链配置、产品断言或浏览器时限。

使用无外部依赖、无 Git 的微型 package 和真实固定 pnpm 复现：旧顺序会执行带标记的 prepare 并失败，修正后 prepare 不执行、锁文件字节不变、预检执行。另一个反例验证安装失败不进入预检。两项 RED 已观察；guest/evidence/transport 共 34 项 GREEN，运行 UUID `85721575-c3f2-4cdc-b111-f2bff517dc92`。三轮小样例的 scratch 与短目录均已实际清理。

pilot02 的父状态保持 failed；本轮容器、网络、两卷已闭合，scratch 和短目录不存在。报告沿普通 14 天/5 GiB 策略保留，不 pin 每轮失败。原三个服务正常运行；本次未再次重启 Docker，未调整配额。限定复审后正常提交，以新固定 SHA 再接续原 14 条；尚不构成 S4 或 M5 验收。

安装顺序增量已完成独立只读复审，C/I/M=0/0/0；复核了两个 RED 原日志、34 项 GREEN 与源码摘要及临时资源归属。下一轮真实校准结果须另行保存，不以本次局部通过替代。

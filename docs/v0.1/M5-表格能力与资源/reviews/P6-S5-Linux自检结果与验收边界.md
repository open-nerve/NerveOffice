# P6-S5 Linux 自检结果与验收边界

2026-11-02。用户批准以 `6a493b4e7c20b09e8de5af307674afc4aa4ee197` 进行一轮取证接续。**selftest02 的 Linux arm64 Chromium 29 条全部首过，零失败、flaky、跳过和重试，内外层退出 0、临时资源实际清理。** 本记录只覆盖这份固定自检清单，M5 完整验收尚未完成。

## 真实输入及结果

- 外层 UUID `8a92c336-b086-4aaa-ac90-828ae459171f`，内层 UUID `1a8a33d5-1971-4baf-82aa-acfa51242e45`；两层均 passed/cleanup complete，外层 publication complete。没有追加第二轮。
- 固定执行 `editor/selftest.spec.ts`、`editor/selftest-next.spec.ts`，Chromium、单 worker、默认自动保存、`--max-failures=1`；原断言、等待、重试、trace 和截图保持。JSON 实际统计 expected=29、unexpected/flaky/skipped=0，逐项无 retry；浏览器时长 628,200.685 ms，约 10.5 分钟。
- Ubuntu 24.04 arm64、Node 24.21.0、pnpm 12.6.0、Playwright 1.63.0 随附 Chromium；依赖安装、后端/前端构建及测试命令的执行证明均为 0，安装前与 pnpm 就绪后的完整句柄预检通过。
- 4,773 项源码与固定受测提交相符，宿主/guest/前后证明一致；16 个 SDK 补丁包实际字节一致。报告收集、归属与发布检查成立，原 JSON/HTML 和内层台账保留。
- 实际覆盖结果交回地址边界、只读/编辑、公式两种时序、自动行高、复制/组合输入、捕获/存储/密钥、Worker/outbox、配额、隐藏保存、接管/刷新保存和请求编辑；最后两条保留原租约有效期及空闲两分钟的真实等待。

## 资源、清理和旧故障边界

本轮维持 runner 4 GiB/3 CPU、数据库 512 MiB/1 CPU、私有 1 GiB shm、16 GiB 停止阈值和 12 GiB 空间保留。162 次采样中，受管计量峰值 7,597,436,928 字节（包含固定 5 GiB 镜像预留），最低可用空间 92,841,676,800 字节；runner 内存采样峰值约 1.586 GiB。没有 OOM、未知采样或桌面身份变化，`measurementFailureSaved=false`，无需增加 Docker 配额。

全部本轮生产者退出后有界导出，再实际删除 4 个容器、1 个网络和 2 个卷；以相同 daemon 的完整 ID 清单再次核对不存在。scratch、短目录和 evidence hold 均实际不存在。原三个项目服务同 ID 正常，PostgreSQL/Redis healthy；WindowServer/loginwindow 身份与启动基线一致。未再次重启 Docker，未运行本机浏览器。

本轮前后可用空间为 95,187,849,216 / 95,079,817,216 字节，时间窗净变化 -108,032,000 字节，约 -103.03 MiB。必要归档约 2.55 MB；Docker/APFS 回收及其他进程活动会影响整盘变化，不能把它当作本轮未清理字节或独占释放量。临时对象删除以身份/实际存在核验为准。固定借用 Playwright 镜像仍按 5 GiB/14 天策略保留，未称已删除完整镜像缓存。

旧 selftest01 的安装期采样失败没有在本轮复现，**确切失败命令与根因仍未知**，不能因这次通过追认旧失败为通过或声称诊断补充修好了底层问题。旧 24 件失败证据继续保留，见[调查与接续记录](P6-S5-Linux采样失败调查与接续.md)。宿主 WindowServer 首次崩溃根因亦未解决。

## 证据位置和审查

主目录 `.codex/handoffs/m5-p6-20261102/s5/`：

- `selftest02-input.json`、`selftest02-launch.json`：单轮授权、固定源码和启动基线。
- `selftest02-result.json`、`selftest02-closeout01.json`：统计、源码/SDK、实际资源删除、原服务/桌面与前后空间。
- `selftest-evidence/selftest02/index.json`：39 件必要报告/日志/台账，payload 2,547,530 字节，逐件摘要核对；索引 SHA-256 `6926a8c2da18f50c9fd649cd881a7385119efe7fbb474216f9e4cc1435699acc`。

最终独立证据审查 C/I/M=0/0/0 已接受，逐件核实原字节、29 首过、固定源码/SDK、JSON/HTML 安全扫描及实际清理。持 retention/bundle 锁重新核对后已实际 pin，接受回执为 `selftest02-acceptance01.json`。原索引的待审字段保留历史值，最终状态以接受回执和 pin 台账为准。普通重复报告仍按既有保留上限管理，没有保留完整测试环境。

## 后续验收清单

| 范围 | 当前事实 | 后续要求 |
|---|---|---|
| Linux arm64 Chromium 的 S3 请求观察/图片链接及 S2 自检 | 原 pilot05 1+13 首过；本轮 selftest02 29 首过 | 两份固定输入分别留档，不相加冒充全量验收 |
| S3 其他浏览器及 M5 原完整自动化矩阵 | 尚未完成当前 P6 输入的全量验证 | 先明确集中验收的执行清单与平台，保留原断言/预算/范围 |
| 原默认完整 Gate、生产容器、最终同 SHA 六项 CI | 全部仍欠当前最终输入的实际结果 | 不能以这 29 条、P5 旧结果或单元检查替代 |
| Chrome/Edge 的 Linux 执行环境 | 当前本机原生 arm64 路径不能提供原生 x64 Chrome/Edge 证明 | 需确定可核验的原生 x64 执行位置；不自行改成模拟架构或省略浏览器 |
| 本机长测、真实 Safari/Excel/Finder 和 M4 欠账 | 本机长测暂停；原生/依赖问题维持既有登记 | 不将 Linux Chromium 结果当作 Safari/Mac 兼容性或已修图形问题 |

下一段先提交完整集中验收的执行方案，明确原生 x64 路径、本机平台差异、资源生命周期和停止条件，再决定扩大负载；本轮授权不自动涵盖全量 Gate、远端 Phase 推送或本机长测。当前仍为唯一 `codex/m5-p6-closeout`，主目录 `main@82c3c266` 未变化，未合并/推送或打 M5 标签。

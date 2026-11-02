# P6-S5 Linux 自检固定清单

2026-11-02。用户已批准 [S4 后续清单](../reviews/P6-S4-Linux校准结果与后续清单.md) 的 29 条既有 selftest。只在现有 P6 分支实施；主目录保持 main，不自动恢复本机浏览器、全量 Gate 或合并推送。

## 范围与设计

新增 `pnpm test:e2e:linux:selftest`，仍经 `run.py container`。命名配置只有原 `calibration` 和新 `selftest`；一个受跟踪 JSON 定义固定组名、实际数量和 Playwright 参数，宿主计划、guest 执行及报告收集共用。原无参数入口继续运行 1+13；不开放任意命令、文件、浏览器或参数透传。

selftest 固定为 `editor/selftest.spec.ts`、`editor/selftest-next.spec.ts`，Chromium、一个 worker、默认自动保存、`--max-failures=1`。原 29 条断言、时间、重试、trace、截图和容量预算不改。执行证明绑定配置名与实际完整命令；收集时拒绝数量不足、重试、跳过、错配置及未预期组。失败仍可安全导出必要原件后清理，不能把失败写成通过。

沿用已通过校准的镜像、内部卷、16 SDK/源码对应、两次完整句柄预检、4 GiB/3 CPU runner、512 MiB/1 CPU 数据库、16 GiB 停止阈值和 12 GiB 磁盘保留。重型测试串行；失败、未知计量、桌面身份变化或清理不闭合即停止，不自动重跑。

## Task 1：固定配置、执行与验收

涉及 `tools/src/deploy/linux-browser*.ts`、`tools/test-resources/linux_browser_{guest,evidence,transport}.py`、bootstrap、新共享 JSON 及对应单元；更新 package/AGENTS/测试规范。

1. 先写行为测试：原默认 1+13 不变；新入口只能选 selftest；实际 guest 命令精确为两文件/Chromium/单 worker/首错停止；29 首过且内层清理完成才成功；失败报告仍保留；错配置/命令、数量不足、额外组不能验收；传输只扩展已知组，仍过滤完整 profile。
2. 受管执行新增测试，记录 RED；最小实现后运行 Linux runner Python/TS 定向与既有容器归属回归。预期全部通过，所有小型资源实际清理。
3. tools 类型检查和变更范围 lint；独立审查本增量与授权范围，修复阻断项，正常中文提交并核对 clean。预期 C/I/M 无阻断，主目录 main 未动。

## Task 2：真实自检、归档与交接

1. 核对磁盘、Docker/桌面身份、无活动本轮测试和既有服务；保存固定 SHA/批准/基线后运行唯一一次 `pnpm test:e2e:linux:selftest`。预期 29 首过、0 flaky/skip/retry，源码/16 SDK 同源。
2. 等待入口实际闭合后核对原 ID 不存在、scratch/短目录清理、既有服务恢复原状态。保存资源采样、可用磁盘前后与真实退出码；失败则保留事实、定位后另行决定，不循环整轮。
3. 只封存必要最终报告、台账、源码/SDK/资源证明和索引，经独立证据审查后显式 pin。更新 P6 状态与后续平台清单；本机图形故障与完整验收欠账保持。

## 验证入口

- `python3 -B tools/test-resources/run.py unit -- python3 -B -m unittest discover -s tools/test-resources -p 'test_linux_browser*.py'`
- `python3 -B tools/test-resources/run.py unit -- pnpm exec vitest run tools/src/deploy/linux-browser.test.ts tools/src/deploy/linux-browser-cache.test.ts tools/src/deploy/container-e2e-resources.test.ts tools/src/deploy/container-e2e-process.test.ts tools/src/deploy/container-e2e.test.ts`
- `pnpm --filter @nerve-office/tools typecheck` 与变更范围 ESLint。
- 真实入口只运行一次；完成标记使用原报告只读核对，不为任务台账重复重型实测。

## Review Focus

- 宿主选择、容器实际命令、收集数量/清理回执是否绑定同一固定配置；旧 14 条是否可能冒充 29 条。
- 失败、未执行、重复组或未知报告能否被忽略并释放唯一证据。
- 是否透传任意参数/宿主环境、改变原自动保存/重试/超时，或扩大到其他浏览器。
- 是否完整复用已有归属、预算、句柄、hold、传输及清理路径，没有引入无界缓存或全局 Docker 操作。

## 2026-11-02 实测后的局部接续

Task 1 已提交 `9c7e845a`；Task 2 的唯一一次 selftest01 在依赖安装期间遇到未知采样错误，实际 0/29，已停止、提取必要证据并实际清理。原结果不能作为通过；详见[调查与接续](../reviews/P6-S5-Linux采样失败调查与接续.md)。

原记录无法区分具体失败命令，先补同一运行器的阶段与白名单错误元数据；小型 RED/GREEN、相关回归、类型/lint 和独立审查后正常提交。该修改不改变预算、停止/清理和测试条件，也不自动重跑。下一轮取证建议与边界写入上述具体清单，等待决定；完整 Gate 和本机浏览器仍暂停。

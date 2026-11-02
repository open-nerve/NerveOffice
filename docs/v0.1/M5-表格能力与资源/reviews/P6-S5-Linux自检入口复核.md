# P6-S5 Linux 自检入口复核

2026-11-02。用户已批准固定 29 条 selftest；本记录覆盖入口实现及小型检查，真实 29 条尚未执行。依据 [实施计划](../plans/P6-S5-Linux自检固定清单.md)，不恢复本机浏览器或完整 Gate。

## 实现

新增 `pnpm test:e2e:linux:selftest`，复用原受管 container 入口。单一受跟踪 JSON 定义 calibration 1+13 与 selftest 29；宿主、guest、传输和报告验收绑定同一命名配置，不接受额外命令行参数。原两个 selftest 文件、Chromium、单 worker、默认自动保存，新增首错停止参数；原断言、重试、trace、截图、容量和超时未改。

执行证明核对配置名、安装/构建与实际测试完整命令；29 条全部首过且内层清理完成才验收。失败和不足数量保留原始诊断、passed=false；未知分组不能被丢弃后释放。原资源台账、内部卷、预算、句柄、evidence hold 和有界导出继续生效，没有修改 Docker 配额或全局清扫。

## 独立审查与修复

本增量独立审查初始 C/I/M=0/1/0。I-01 指出传输层接受所有已知配置的组名，而空目录或只含被过滤完整 profile 的额外组不会落地；收集端无法看见这类额外组。

先用空目录和只有 `Default/History` 的微型 tar 复现，两类反例均观察到 RED。修复为宿主显式传入 suite，传输在任何目录/profile 过滤之前，只允许该配置的组名；传输回执也绑定 suite，收集端再次核对。最终用例覆盖 calibration/selftest 双向错组、空目录、过滤项及缺失/错误回执，全部 GREEN。按执行流程一次修复并回归关闭 I-01；未将原始审查结果改写为零发现。

## 验证事实

- Python Linux 入口/证据/传输 **42 项通过**，run `ed06bd94-5cdf-464b-b2b1-3035d38cff28`。
- TypeScript 入口、镜像缓存、既有容器归属/进程协议 **112 项通过**，run `d4dfaa17-eeeb-46f4-8b28-cf42fa5dee39`。
- tools 类型检查、三个变更 TS 文件 ESLint、diff 空白检查通过。
- 新入口前的 RED 覆盖旧 14 条选择、未知组遗漏、错配置/错命令证明和 selftest 传输缺口；I-01 RED 为 `d76d7b39-bdfd-40a2-89ea-465186d5d798`。失败历史与原日志保持，未伪造成通过。
- 各受管小型测试 run 均 cleanup complete，scratch 与登记短目录实测不存在；未启动浏览器或创建 Docker 测试环境。

主目录仍为 `main@82c3c266`，P6 唯一 worktree 不变。正常中文提交并核对 clean 后，按批准范围启动一次真实 29 条，串行监测、结束及时清理。结果另行记录，不能凭本次小型检查关闭 S5/M5。

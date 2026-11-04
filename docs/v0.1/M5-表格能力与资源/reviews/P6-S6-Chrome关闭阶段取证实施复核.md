# P6-S6 Chrome 关闭阶段取证实施复核

2026-11-05。用户批准 `b0e303d2` 后，本次按原方案完成固定 Chrome 用例的有界记录器、正式默认 context 夹具接线、Chrome-only CI 开关及持久测试规范。**本机小型验证成立，真实新 CI 尚未启动；未证明 CI95 关闭超时的内部根因已解决。** 原单轮接续和工程收尾授权保持，不恢复本机浏览器长测，不启动 M6。

## 实现与证据边界

- `context-close-diagnostic.ts` 只选择原 `catalog-boundaries.spec.ts` 的换人故事、project `chrome`、retry 0/1；其余用例/浏览器不开启。只观察公开 close/request.dispose/tracing.stopChunk 与关闭/断连事件，没有修改产品、原故事、断言、时限或重试判失败。
- 同步包装以原 this/参数调用并返回原 Promise，同步异常原样抛出。不增加关闭、等待或重试；项目 `provide` 返回后底层默认 fixture 的真正关闭仍受观察。
- 每 attempt 先独占创建、登记一个 0600 报告，再记录事件；每份 32 KiB/64 条、原两次合计至多 64 KiB。只保存固定阶段、单调时间、关联和有限归属字段，不保存参数、错误正文或环境对象。
- 写入前以非阻塞打开和普通文件/dev/inode/nlink/大小核验拒绝替换；描述符同次关闭。初始、挂起、写入/身份/上限异常均不冒充完整。实际接受必须同时检查原附件和不完整注解；不完整或损坏原件保留，不能把诊断失败改成产品通过。

## 实际验证

最终受管 run `a7a76a69-786e-4a24-89b2-4bb9f9b324a9`：四文件 **62/62**，包括新记录器 17 项、既有登录 popup 8 项、工作流 19 项及计划 18 项。执行入口：

```sh
python3 -B tools/test-resources/run.py unit -- pnpm exec vitest run --project unit tests/e2e/support/context-close-diagnostic.test.ts tests/e2e/support/login-popup-diagnostic.test.ts tools/src/verify/ci-workflow.test.ts tools/src/verify/plan.test.ts
```

真实 Playwright Node 调度器模型只替换 browser 边界，默认 context fixture 和正式项目 wrapper 实际执行；没有启动浏览器。成功模型完整记录公开阶段；挂起模型保留原 `timedOut`/exit 1，记录 request.dispose 开始而没有完成。模型不代表真实 trace 内部、浏览器协议或 GitHub 报告搬迁已经验证。

完整 `pnpm lint` 与 `pnpm typecheck` 已通过；局部审查修正后，改动文件 ESLint 及 E2E 工作区类型检查也通过，`git diff --check` 通过。开发中曾出现模型缺少锁定版本所需 connection.headers、测试环境对象类型推断错误，均按实际原因修正；原失败不改写。ESLint 自动增加 async 的行为也被三个透传反例捕获，恢复同步包装并给出精确规则说明后 GREEN，没有放宽断言。

新一轮 monitor/collector 仅从既有入口改 `ci04`→`ci05` 文件前缀，保留原身份、下载预算、禁止覆盖和凭据重定向边界；11 项 KiB 离线校验通过，尚未创建实际新 run binding 或触发 CI。

## 独立审查与修正

原独审记录为主目录 `central-acceptance/engineering-closeout/chrome-close-code-review.md`，SHA-256 `b941599dddef5e5625031e63c33f899900b18d796661715e5275c9276f5a868a`，**C/I/M=0/1/0**。唯一 I-01：已登记文件被替换为无 reader 的 FIFO 时，阻塞式 open 会在身份核验之前卡住原调用。

作者以独立、只含本轮 Node 的 1.5 秒有界样例取得 RED：run `d3657ef5-5a09-4ba6-b307-eb8410d6efd1` 的原进程返回 signal SIGKILL，原调用尚未执行。补 `O_NONBLOCK` 后，同一反例与完整相关组 GREEN：样例 exit 0、signal null，保留 FIFO，原关闭实际执行，仅留下固定不完整注解。前述全部临时根及受管生产者已由原机制闭合。

因此本次待处理 Critical/Important 为 0；这是作者 RED→GREEN 修正，**不是另一轮独立 0/0/0 审查**。原审查输入与报告不改写。审查未裁定的真实 Chrome、原故障根因、最终 main 六项、Mac/M5 完整验收、VM 实际删除与阶段退役仍须各自的实际证据，不能从本报告推断。

## 接续与留档

正常提交、`--no-ff` main 合并、原 pre-push 门禁和推送后，唯一新 SHA 原六项 CI 统一核对本诊断与已完成三阶段磁盘观察。未知故障再次出现即停止，不重跑 CI95、不追加第二轮，不改变原 12/16/5 GiB 阈值或质量标准。

实际授权、冻结输入、RED/GREEN、小型资源、提交和后续 run 回执保存在主目录 `.codex/handoffs/m5-p6-20261102/s5/central-acceptance/engineering-closeout/` 及 `ci05-*` 索引；更新中的断点以 `central-acceptance/progress.json` 为准。必要 CI95 失败原件已经 pin，重复下载已清理。源码/索引/独审材料保全；Mac DEF-074 和 M5 完整验收/标签继续开放，工程收尾后等待用户安排。

# P6-S2 selftest 生命周期实施计划

> 执行：superpowers:executing-plans；当前 Agent 顺序实施，先 RED 再 GREEN。

**目标：** 关闭 P5-S4 M-01：准备期离开/显式销毁后不再安装晚到 hook 或加载旧页，正常页的保存/租约 pagehide 语义保持。

**设计：** [P6 收尾设计](../06-P6-M5收尾.md) §3；仅调整同一宿主的测试挂接生命周期，不改变 SDK、正文、服务或独立探针。

**架构与技术：** `start.tsx` 的准备期 pagehide 责任在调用正式 `page.load()` 时同步移交；selftest 使用本挂载 AbortSignal。测试挂接用本地清理栈归还订阅、计时器和所拥有的全局包装，异步准备返回的控制器若已取消则立即 dispose；已启动的场景内部操作不在此任务承诺为可抢占。真实浏览器长测仍暂停，Vitest/jsdom 验证调度契约。

## Task 1：挂载入口的两个等待窗口

**文件：** `apps/web/src/features/sheet-editor/start.tsx`、既有 `start.test.tsx`（复用原挂载夹具，不另建重复测试文件）。

**接口：** `startSheetEditorPage` 的公开签名/返回值不变；内部 prepare/assemble 接收 `onLoadStarted: () => void`，仅在实际 load 前移交；动态 hook 接收可选本挂载 AbortSignal。

- [x] 受控动态导入先挂起；分别在 dispose/pagehide 后完成导入，断言零 hook、零 load、宿主释放且只释放一次；跑旧源码观察真实 RED。
- [x] 正常 hook 成功/失败的 load 行为，以及 hook 已开始但 Promise 未完成时 pagehide 的取消；正式 pagehide 不被普通 dispose 抢先。
- [x] 最小修复并 GREEN；所有旧启动/CSV 创建用例保持。

## Task 2：挂接自身的异步准备与清理

**文件：** `selftest-hook.ts`、`selftest-hook.test.ts`。

**接口：** `watchForSelftest(page, elements, reloadDiagnostics?, signal?)` 兼容旧调用；清理仅撤销自己仍拥有的 console/fetch/BroadcastChannel 包装，按逆序执行已登记 disposer。LocalPause/LocalSave 使用现有 dispose，不改其协议或预算。

- [x] 取消前后用真实订阅集合、页面事件/计时器和原包装身份证明无晚到工作；覆盖控制模块晚到、控制器异步返回、准备拒绝和正常路径。
- [x] 所有资源创建后立即登记；取消时清除等待稳态的订阅/超时，迟到控制器立即释放，不启动场景。真实挂接回归 RED/GREEN。
- [x] 受管串行跑相关单元，定向 lint、类型检查；其后按实际修改范围决定单元扩展，不启动真实浏览器。记录失败与清理结果。
- [x] 独立审查局部修复，修复必需发现，中文提交；明确真实浏览器自检回归仍在 P6 集中验收。

2026-11-02 执行结果：定向 4 文件/46 项、全单元 595 文件/11,959 项、定向零告警 lint 与全仓类型检查通过。独审唯一 Minor 的实际资源释放断言已补齐；17 轮已结束运行的进程组/句柄重新核对成立，scratch 与短路径均不存在。详见[复核](../reviews/P6-S2-selftest生命周期复核.md)及主目录 `.codex/handoffs/m5-p6-20261102/s2/final-verification01.json`。

新 worktree 只离线安装依赖后，直接执行全单元前还须 `pnpm --filter @nerve-office/contracts build`；报告环境测试有意用隔离环境启动 Playwright 只读列举，需要 contracts 的构建产物。首次缺少该产物的四项失败保留，未修改测试或配置来绕过前置。

## 审查重点

不能吞掉正常加载失败；pagehide 只在正式 load 前普通 dispose；正常加载后仍由正式页保护在途保存。取消不等于取消所有已经启动的异步场景；准备函数既有 10 秒请求仍可能在返回前持有其自有临时观察器，返回/失败按原 dispose 路径清理。不能用取消状态把未执行自检算通过。

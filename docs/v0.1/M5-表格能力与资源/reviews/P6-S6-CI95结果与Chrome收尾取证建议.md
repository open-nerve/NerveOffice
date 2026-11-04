# P6-S6 CI95 结果与 Chrome 收尾取证建议

2026-11-05。**M5 工程收尾仍未完成。** 已批准的磁盘诊断增量正常提交为 `a69d436699c59f70b96c37fd397d6630ca839993`；79 项 Python、36 项 workflow/分片回归及 lint/typecheck 通过，独审的一项路径遗漏已 RED→GREEN 修正，11 轮小型资源实际闭合。主目录和远端仍为 main `46b5e8f4`，两个工作区干净时开始本调查；尚未合并/推送新的 SHA 或启动下一轮 CI。

## 本轮实际结果

CI95 `41852824657` / attempt 1 / main push 已 completed/failure，原六项如下。不能用 CI94 的通过替代这次最终 main 验收。

| job | 原结果 |
|---|---|
| verify | failure；lint、类型和静态门禁通过，主覆盖率测试启动前触及原 12 GiB 余量保护，主单元/集成实际 0 项 |
| Chromium | success；833 passed、4 原 skip，零 retry |
| Chrome | failure；825 passed、4 原 skip、1 flaky（首次 timedOut、retry 1 passed），不能写成 826 首过 |
| WebKit | success；822 passed、8 原 skip，零 retry |
| Edge | success；826 passed、4 原 skip，零 retry |
| 生产容器 | success；354 passed，零 retry |

固定原件六日志/九 ZIP 共 41,532,192 bytes（约 39.61 MiB）；verify 的 `reports-41852824657` 未产生，收集器按实际缺件返回 2，未放宽完整性标准。五组 JSON/HTML 的用例身份、状态/重试和原选择范围相符，序列化环境边界检查通过。该只读初核不是全绿 CI 接受；托管 VM 实际销毁没有被观察，原 `cleanupComplete=false` 保持。

主目录 `central-acceptance/ci04-collection-result.json`、`ci04-initial-survey.json` 与 `ci-evidence/ci04-41852824657/` 是完整的实际可得原件索引；没有调用要求成功 CI 的严格接受工具来伪造通过。

## Chrome 已定位到哪里

用例为 `tests/e2e/specs/local-drafts/catalog-boundaries.spec.ts:231` 的“另一页换人后旧草稿页重新聚焦，不再显示原账户已完成副本的标题和链接”。它通过本次业务检查，卡在默认 context 的关闭阶段，尚未定位到其中具体的异步等待点。

- 原 JSON：首轮 `timedOut`、242,325 ms，错误是 context teardown 超过原 240,000 ms；重试 4,045 ms 通过。原拒绝 flaky 生效，job/命令失败不改写。
- 失败 trace 内 `test.trace` 有 69 个 begin、68 个 end；末尾两条标题/链接消失断言均有完成且无 error。第二页 `Close page` 实际完成，用时约 8.383 ms；CSP/pageerror 收尾也已完成。
- 唯一没有完成事件的是 `pw:api@88` 的 `Close context`。默认 context fixture 约等待 240,099 ms 后超时；随后 worker 的浏览器清理约 92.710 ms 完成。
- 41,588 bytes 的原 trace ZIP SHA-256 为 `dd36f5a4493865490cd98bf11f5bc736d8dd511f54e1c2853463427759a060e8`，只含测试步骤流、源码和错误上下文，没有 browser/API `.trace` 或 `.network`。因此无法由现存原件区分 request dispose、trace 导出、截图/快照或协议关闭中的具体阻塞点；不能因缺少 browser trace 就认定 trace 导出是根因。
- 锁定 Playwright 1.63.0 的默认关闭依次等待 `context.request.dispose`、关闭前 instrumentation、HAR 导出、channel close 和关闭事件。关闭前 instrumentation 调用公开的 `context.tracing.stopChunk` 后，还会处理截图/页面快照。当前 Chrome 使用默认 context；未进入项目的 WebKit 持久目录分支，不能把该分支的行为套到本例。
- Chrome 最终日志中的可用空间约 81.67 GiB，与 verify 是独立 VM；这不是失败瞬间测量，也不能将 verify 的低空间事实套到 Chrome。本轮没有本机崩溃证据，也没有证明 Chrome 内核、产品代码或某个夹具是根因。

原 trace/JSON/HTML 不改写；派生取证只输出固定操作、时点、状态与摘要，不展开动态 expect 标题、网络参数或测试认证数据。`engineering-closeout/ci04-chrome-trace-facts.json` 保存上述时间及原件对应，`ci04-chrome-preliminary-review.md` 保存先前日志/源码独审，完整原件复核另行留档。

## 有界接续建议（尚待批准）

建议在**已经批准但尚未执行的唯一下轮原六项 CI**中补足该用例的关闭阶段记录，不另加一轮长测、不盲改产品或夹具。另一可行选择是保留当前现场、继续暂停 CI；它不增加运行，但也不能消除最终验收阻塞。建议前者，因为现有 trace 的缺口已具体落在默认关闭调用内部，只再跑原流程仍可能留下相同缺口。

1. 在现有 P6 分支增加测试专用的 `tests/e2e/support/context-close-diagnostic.ts` 和相应小型单元测试，接入 `fixtures.ts`；参照现有 login-popup 诊断的按平台开关方式，workflow 仅在 Chrome job 开启。只对上面的固定 file/title、原 Chrome context、原 attempt 0/1 记录；其他用例/浏览器不启用。
2. 只观察公开 `context.close`、`context.request.dispose`、`context.tracing.stopChunk` 的开始/完成/拒绝，以及 context close、browser disconnect 事件。原方法的 this、参数、同步异常与返回 Promise 原样透传；不调用额外 close、不增加 await/sleep/重试，不调整原时限、不关闭 trace 或截图，不代理私有协议 API。阶段记录只能进一步缩小等待范围，不能预先保证解决或复现此次故障。
3. 每个 attempt 一个已归属本轮 `testInfo.outputPath` 的小型记录文件，独占创建、不接管旧文件，先登记再记录。每例最多 32 KiB、最多 64 条，原两次 attempt 合计不超过 64 KiB；只写固定阶段、序号、时间、结果和有限 run/SHA/项目身份，不写参数、错误正文、Cookie、存储内容或整个环境。沿现有报告收集与 14 天/5 GiB 策略保存，不创建 profile、VM 或数据库副本。写入/身份/上限异常显式留下不完整状态；不能把缺证据视作诊断成功。
4. 用 KiB 样例验证透明调用、同步/异步失败保留、并发/挂起原 Promise 不被改变、精确平台/用例选择、边界与无秘密输出。结合既有相关门禁独审后正常中文提交；未获批准前不实现这一新增诊断，不启动本机浏览器。
5. 完成原件接受和小型审查后，复用已批准的唯一一次新 SHA 正常 hooks、`--no-ff` main 合并/推送及原六项 CI。原 12/16/5 GiB 门槛、断言、范围、skip、重试判失败与时间窗口保持，不 rerun CI95、不并叠或追加第二轮。三阶段磁盘观察与新增关闭记录都须按实际结果核对；缺失/不完整仍不接受。
6. 再次出现未知资源/关闭故障时保留实际结果并停止，不试调超时或追加重跑。若原标准全通过，才回到已批准的最终原件接受、必要 pin、资源/分支退役与工程交接；CI95 历史故障仍如实保留，不声称其确切根因已修。Mac/原生/M4 欠账及 M5 完整验收/标签边界保持，工程收尾后停止，不启动 M6。

本次需要确认的是新增 Chrome 关闭阶段取证范围。磁盘诊断与原工程收尾授权继续有效，不重新申请相同事项。原[集中方案第 7 项](P6-S5-Linux集中预验收与环境方案.md)要求未知资源问题停止说明；现在多出了此前磁盘方案未覆盖的浏览器收尾故障，不能把“磁盘诊断已批准”解释为任意恢复试验的授权。

# P4-S6 WebKit 登录导航诊断

> 2026-10-29：有界诊断、CI 接线、局部测试及代码审查完成；macOS 原故事已实际首次通过，但导航附件明确 incomplete。原 Linux 故障仍未解决，下一次真实 Linux CI 继续按原标准验证。P4 未关闭，P5 未开始。

## 原始失败与证据边界

[最终 CI 40787715273](https://github.com/open-nerve/NerveOffice/actions/runs/40787715273) 绑定 main `323b957b5302208de965e76e6590052cc60a84e2`。WebKit job `123164989476` 结果为 failure：801 expected、8 skipped、0 unexpected、1 flaky。唯一 flaky 是 `tests/e2e/specs/editor/autosave.spec.ts:471` 的401暂停、本人在新标签页登录后恢复自动上传故事。

- 首次尝试于2026-10-28T23:37:12.369Z开始，12,199 ms后失败；502行登录表单可见断言在原5,000 ms内未成立，调用记录为等待 `/login` 导航完成。
- retry 1于23:37:26.007Z开始，8,322 ms后通过；没有成功重试的trace，不能比较其内部阶段耗时。既有 `failOnFlakyTests` 正确使整个job失败，不能因重试通过或既有环境债而豁免。
- 失败trace确认原页clock.resume已返回、真实新标签页链接点击成功、popup归属正确，且出现GET `/login`。随后观察窗口内没有响应、DOM snapshot或后续资源。因此当前只定位到**新页初始文档导航未完成**，尚不能判定服务端静态响应、浏览器导航/协议或clock bootstrap之间的具体原因。
- 当时服务日志为info，成功静态请求只记debug。缺少 `/login` 日志不能证明请求没有到服务端；trace中的未记录响应也不是服务器实际返回负数状态。同窗口其他API正常，不足以排除单个连接或静态响应问题。

本仓Playwright的clock replay对runFor/fastForward只推进ticks，不重放原页定时器回调；没有证据支持“popup回放旧定时器卡住”的结论。本次不改变时钟，也不把此故障与另一job的SQLSTATE 57014合并归因。

证据目录 `I` 为主目录 `.codex/handoffs/m5-p4-20261022/s6/hosted-vm-policy/final-ci-40787715273-investigation`。原件已迁入 `I/evidence-archives/ci40787715273-failure/output/`，保留14天/5GiB策略；`I/final-failure-originals/relocation.json`记录旧路径到新路径及不变摘要，旧索引没有覆盖。

| 原件 | SHA-256 |
| --- | --- |
| `e2e-reports-webkit-40787715273.zip`，15,835,813 B | `87b91d389270e98542a32e0311aaf9a45ebf9c339fe02a4807260c6c549ba0b3` |
| `job-123164989476.log`，472,144 B | `b74cfff8cbd0e92fe3de63e8d77acb98f7fc07e6ce8beb5f8a7de130c90dd8d8` |

详细trace时序、旧源对照和资源字段见 `I/webkit-investigation.md`。该job产品状态仍为failed，资源为host-disposal-pending、cleanupComplete=false；平台VM销毁没有实测，不能写成已清理完成。

## 已实现的补证与保护

客户端诊断只在显式 `E2E_LOGIN_POPUP_DIAGNOSTIC=1`、webkit项目、精确文件后缀与完整故事标题同时匹配时安装。只观察同源GET `/login`导航及对应页的request、response、finished、failed、frame、DCL、load。网络监听先于popup创建；初次看到page已在 `/login` 时记录 `page-observed` 并选中，不补造此前commit/frame。初始request.frame不可用时保留请求事实并标incomplete，不猜测页归属。

附件仅保留类型、UTC/单调时间、页/请求序号、状态及pathname；不读header、body、token或原始失败文字，不保留查询串、fragment和URL凭据。选中页后的后续路径仍可被记录，不能声称完全没有路径标识。整个JSON含元数据不超过128 KiB、最多256事件和16个观察页；超限保留前缀并记录truncated/dropped，采集异常记录incomplete。

结束时先同步stop并封存，再按原路径关闭context，最后安全附加JSON。附件失败使用固定不完整注解，不替换原故事或close异常，也不让附件I/O推迟浏览器关闭。没有新增路由、evaluate、导航等待、重试、HTTP原型包装或启动注入接口。

服务端仅在同一显式开关下把既有 `NERVE_LOG_LEVEL` 从info改为debug，继续使用原HTTP脱敏日志。该级别作用于整个专用测试后端，能补成功静态响应完成/中止摘要及已有debug元数据，**不是逐故事过滤，也没有receive探针**。附件128 KiB限额不等于整个server日志限额；后者仍受既有受管报告策略约束。

CI仅在现有e2e job的env增加 `${{ matrix.browser == 'webkit' && '1' || '' }}`。其他浏览器取得空值，verify/container没有开关；接线测试还禁止全局及step覆盖。原命令、scope、矩阵、5秒断言、240秒用例时限、CI重试一次和failOnFlakyTests都未改，原autosave故事与Playwright配置无差异。

## 实际验证及失败轮次

以下证据目录均在I下，全部经主目录已提交runner串行执行。每轮保留真实start、operation.log、source-before/after和completion；所有轮次源码前后相同，失败原件未覆盖。

| 轮次 | 实际结果与范围 |
| --- | --- |
| `webkit-diagnostic-unit-red01` | exit1、0测试，原因是新helper尚不存在；这是缺实现RED，不是WebKit导航故障复现 |
| `webkit-diagnostic-unit-green01` | 6项通过，随后8处对象换行lint错误，整体exit1；typecheck未继续 |
| `webkit-diagnostic-unit-green02` | 纯格式修正后6项、四文件lint与E2E typecheck通过；这是后续独审接线修正之前的版本 |
| `image401-related01` | 接线修正后的诊断8项全部通过；同轮另有Chrome相关回归，不将其算作WebKit验证 |
| `browser-fixes-static01` | 当前诊断四源lint及全仓typecheck通过；四源hash与交付一致 |
| `webkit-popup-local01` | macOS真实原故事首次通过，1项、0retry；用例5.803秒、套件9.531秒，exit0；限制见下一节 |
| `webkit-ci-wiring-red01` | workflow16项中仅新开关断言失败，其余15通过；实际为undefined不等于预期表达式 |
| `webkit-ci-wiring-green01` | workflow16项及diagnostic8项共24项通过；随后常量一处style/quotes错误，整体exit1 |
| `webkit-ci-wiring-static02` | 仅改常量外层单引号与内部转义，表达式值不变；文件lint通过。没有在此轮重跑24项 |

当前诊断四源的最终类型证明来自 `browser-fixes-static01`；之后的CI测试新增及字面量排版不回填到此前typecheck证明，仍由后续完整门禁承接。纯函数测试证明范围、字段、容量、当前页识别和封存，不替代真实浏览器事件证明。

各轮completion核对scratch、短目录、alias、owner、childGroup均消失且锁释放，cleanupStage=complete。没有保留完整VM/profile副本，也不声称既有共享PostgreSQL容器已删除。

## macOS 原故事已完成实测

`webkit-popup-local01` 于2026-10-29T01:29:32.821Z至01:29:50.703Z实际执行，保留CI=true、原popup动作/时钟/断言/重试，仅指定原故事、webkit及1worker。JSON为1 expected、0 skipped/unexpected/flaky，global errors为空，retry0 passed。4,598项输入源码前后完全相同。

有界附件 `login-popup-navigation` 为1046 B、9事件，truncated=false、dropped=0，**incomplete=true**。初始request和response无pageId，requestfinished才关联pageId3；这与初始frame不可用一致，但没有原因计数，不能据此宣称它是唯一缺口或把标记改成完整。

客户端UTC 01:29:44.633观察request，44.777收到200，44.780观察到登录页，44.782请求完成，44.818记录frame/DCL，44.839记录load。同一客户端单调时钟request至response约144.332 ms、至load约205.847 ms。服务端44.635记录GET `/login`完成200、durationMs=1；随后登录API及原故事中的恢复上传、服务器读回均通过。服务端完成时间不能倒推出实测receive时间，`page-observed`也不是此前commit的替身。

本机是macOS/1worker，旧CI为Linux/2workers，还有持久WebKit的macOS存储适配差异。**这次通过仅是本机成功对照，不能证明旧Linux问题修复或排除Linux导航/协议及负载交互。** 不再重复相同本机测试来代替Linux证据。

本轮15个必要报告约610KB，封存于 `I/evidence-archives/webkit-popup-local01/output/`，未pin、phaseAccepted=false。独立只读结果为 `I/webkit-popup-local01/independent-findings.md`，SHA `4ba4db18e1c0aed6738e7be8179ef1bc62b91174193741fc94e273006a36c413`。JSON SHA `4ec4924b706745e386c9cc96a02c7c3690bbe2b6087ed758a167d287a4741c08`；附件SHA `f733502e40f96c5a378cca593f399976d14a6f8043b91f2e70cdf71ac5a20b27`。桌面守护退出0、WindowServer始终989；本轮内外受管资源实际回收，未生成LinuxVM或环境副本。

## 独立审查与交付版本

早期 `I/webkit-diagnostic-code-review.md` 指出两个P2诊断接线问题：已经在登录页的popup识别遗漏，以及await附件早于原context关闭。两项已局部修正；最终 `I/webkit-diagnostic-final-review.md` 对当前诊断与CI接线无阻断，SHA `2c5d5bb6869f10e6395f35ad2c1d23dfeb93f61d0d4620177d4dc408194663ef`。它不是产品故障修复或Phase通过签字。

该最终代码复审仍有“真实Playwright接线尚待原故事补证”的陈旧表述，原件保持不改。实际macOS原故事已运行且有上节独立结果；这里只把**下一次真实Linux补证**列为待验，不重复声称本机未跑。

| 路径 | 交付SHA-256 |
| --- | --- |
| `tests/e2e/support/login-popup-diagnostic.ts` | `99fc19064a8c31e92867186df116e77505edae0f51d9949340e969ba2195782f` |
| `tests/e2e/support/login-popup-diagnostic.test.ts` | `cc788d57fdec8e795c96ece618bd2aa636241503c4a93c7d6969b3a748d7d976` |
| `tests/e2e/support/fixtures.ts` | `4267e31fa1ffcc0f2a2267d4e98ec0e96da3c9aa6c7a7f2efda09bd05f4f0a02` |
| `tests/e2e/support/serve.ts` | `6e909bd4c65f652b7c4ba8f81e8c3e027940054867a2752da75e6d84bcf810a1` |
| `.github/workflows/ci.yml` | `113b38f8ea3bbd329dc7d5caed09f1ac51ab5569f306d37ef4989015bfc2e655` |
| `tools/src/verify/ci-workflow.test.ts` | `b763a0a06d6bf0b1e73ecb21154743bf25a4a6184206d16cc21e9b292f8b6e8c` |

外部完整交付说明为 `I/webkit-diagnostic-delivery-notes.md`，SHA `cc3a06b68fb33d2006216cdc03bff85ece4e1d82fe9db58ada2e03a6d1d55694`，保留每轮实际时间和证据索引。

## 下一步与接受条件

下一次同源真实Linux CI沿用既有命令和门槛，携带当前诊断；先核对原JSON/HTML的首次、重试结果及附件存在性、incomplete/truncated/dropped，再对齐服务端完成200、客户端response和frame/DCL/load。缺receive证据的分支继续明确未知。

若再次failed/flaky，继续阻断并保留每次尝试；若首次通过，也仅说明该轮实绩，不能回填为旧根因已解明。不增大5秒断言、不用直接goto/reload绕过popup、不关闭failOnFlakyTests，不将此问题归入DEF-073或Excel/Safari/Finder环境债。Chrome问题及资产引用批量修复按各自证据独立处理，本诊断文档不接受它们，也不替代新完整本机/容器门禁、最终同SHA CI和P4关闭。

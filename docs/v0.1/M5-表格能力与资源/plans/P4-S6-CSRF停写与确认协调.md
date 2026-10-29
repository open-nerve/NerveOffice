# P4 S6 CSRF 停写与确认协调实施计划

> 执行方式：按测试先行完成局部实现，相关代码已提交为 `000022ae`；负责人串行运行完整门禁并安排独立结果审查。

日期：2026-10-29。用户已明确批准调查报告推荐的跨模块方案，原断言、预算和验收标准不变。

**目标**：相关请求失败先登记本机失效处理，后续会话查询在取票前等待该处理；真实新许可已覆盖的停写事件不再制造多余确认。

**架构**：请求层同步登记、异步执行副作用，仍立即抛原错误。会话跟踪只协调当前来源的已登记失效；本机资格仍完全由既有 ticket/fence 规则授予。页面分别保存普通复核需求与本机 stopped 需求，不用一个布尔值相互覆盖。

**技术**：TypeScript、现有请求层/会话资格、Vitest 受控交错、原 Playwright 故事。规范为 [调查与批准方案](../reviews/P4-S6-CSRF确认与停写顺序调查.md)。

**独审接续**：初版独审发现 I1（在途新登记事实）与 I2（真实 IDB decide 前）两处窗口；fix round 1 已逐项 RED→GREEN、独立复审接受。1,005 项关联单元、原构建预算、三浏览器真实存储 39 项和原交接/图片 60 项均通过；完整 P4 门禁仍待。见[协调复核](../reviews/P4-S6-CSRF停写与确认协调复核.md)。

## 全局约束

- 主目录保持 main，唯一 P4 worktree `codex/m5-p4-history-gc`。本次基线 `b12b7636`，不改 E2E 原断言与时钟、请求时限、重试或 bundle 预算。
- 原认证错误不等待本机副作用、不变成别的错误、不重发失败请求；取消仍抛调用方原 reason。
- 不持同源锁等待失效，不让旧响应换取新票据。Promise settled 不是持久停写成功的证明。
- 初始 unavailable/disabled 的合法内存模式保持；受影响原代次不能通过超时或副作用失败重新关联本机许可。
- 所有测试通过受管运行器；本次只跑小型单元和定向静态检查，重型检查由负责人串行安排，每轮核验清理。

## 任务 1：请求失败与查询取票的协调

涉及 `shared/api/client.ts`、`session-tracking.ts`、`session-association.ts`，及按需 `shared/local-drafts/session-activation.ts`、`session-failure-coordination.ts`、`session-failure.ts` 与对应测试。保持现有 `reportRequestSessionFailure(error, permit): Promise<void>`、`requestWithLocalSession(kind, request, signal?)` 和 `trackSessionRequest` 调用面。

- [x] 先用真实 client、activation 与 fence 规则，替换仅存储/网络边界，复现“403 已返回、失效处理未完成，随后 query 已提前发出”的 RED。
- [x] `client` 直接调用登记入口后照常 throw；去掉登记前的额外 Promise 延迟。登记只接受原请求固定来源和已校验失败事实；同步登记抛错也不替换原错误。
- [x] 协调记录最多保留一个当前来源；普通失效与确证停用分别登记，相同来源/事实的在途副作用共享。采用无许可的同人同 CSRF 响应不退休旧代次否决；明确清除会话、采用不同用户/CSRF 或真实不同许可才退休，旧来源不借当前身份登记。
- [x] 查询先按需装入 activation，再在取票前等待当前来源记录，最多 3,000 ms。等待不持锁；取消只结束本查询等待。每事实只有一个完成处理链，查询使用可解除订阅；timeout/abort 的 finally 同时移除 timer、abort 监听和完成订阅，没有遗留 Promise.all 观察循环。新相关事实不重置截止时间。
- [x] 等待后只执行一次原 query。普通失效尚未真正换代时剥除原 generation 的关联。**已经登记但未落实的同源 account_disabled 必须在 activation 真正 accept 前否决，不能先从暂停 S2 激活到 G3 再剥除关联**；只在实际持久转移和通知完成后接受 `stopped` 证明，swallowed exception/settled 不算。真正不同用户/CSRF 和 mutation 新登录仍使用原 fence。下一次真实 query 可有界重试未落实的本机事实，不重发原网络请求。
- [x] 控制失败在途/已完成、超时、存储异常、取消、旧来源迟到、新登录、普通失效与停用交错；先行 RED→GREEN 已记录。更广回归与独审见负责人记录，不把局部通过当完整验收。

### 已依据实际检查收敛的边界

`lint01` 证实 API 区不得静态引用 outbox（包括 type）；因此完整协调器留在按需 local-drafts。activation 真正发出许可对象时，在轻量 session-association 的 WeakMap 绑定该原许可的同步登记端口；普通请求只调用原对象的端口，不能从当前会话给旧对象补签。未绑定端口的来源仍走旧动态严格核验。协调器动态派发 browser-session-failure，不静态装入 browser-cleanup；初始平台首屏仍不含完整资格/等待实现。原层级规则和 bundle 预算保持，体积由负责人后续原构建实测。

## 任务 2：页面补核只消除已覆盖的 stopped

涉及 `features/sheet-editor/editor-page.ts` 和现有页面测试。

- [x] 为本机 stopped 设独立待核标记；普通 `checkAgain` 与 `staleAfter` 不被清除。
- [x] 一轮真实确认（包括 `resumeLease`）结束后，只有当前真实许可已处于同一用户的新 generation，才认为该 stopped 已覆盖；若确认在途失去资格，仍补一次真实查询。查询开始前就存在的 stopped 只要求该轮确认，不造成无限循环。
- [x] 保留“仅用于识别迟到 stopped”的上次许可来源：同用户同 CSRF 的无许可响应后可继续识别迟到通知，但绝不作为 writer、reader 或恢复许可；新真实许可/换人/退出/不同 CSRF 使其失效。无本机许可不等于无真实服务器认证，内存模式与图片服务器权限按原规则。
- [x] 保留现有 during-confirm/after-confirm 图片反例、VB1/UB3、自动 grant、编辑/接管及 beginRestore 点击时锁存。新增 resumeLease 期间新停写控制、已覆盖 stopped 不多发确认及无许可响应后迟到通知的 RED→GREEN。

## 审查重点

1. 多个旧请求、普通失效与停用乱序：不得覆盖较新来源，也不得吞掉紧邻暂停后的确证停用。
2. 等待超时或副作用被吞掉的存储失败：不得把 settled 当成功，原 generation 不得重新关联；下一次真实查询仍有恢复机会。
3. 查询取消和请求模块加载失败：原请求次数、原认证结果/错误及实际失效处理保持。
4. 查询响应与随后 resumeLease 的不同异步边界：较晚 stopped 不能被较早响应消掉，通用新鲜度复核保持。
5. 只用于匹配迟到通知的旧来源：不会流入持久写入/读取、自动 grant 或恢复来源选择。

## 验证与交付

### Fix round 1：补齐在途登记与真实持久决定边界

- [x] I1 使用真实 client/activation/fence 补 3 条 RED：查询在途之后 preserve 存储失败仍关联 G1；query rejection 先暂停后，下一次在途查询碰到 pending/failed disabled 先激活新代次并吞掉停用。
- [x] I2 在原生 IDB `get` 成功事件中、生产 `decide` 之前同步登记 disabled；负责人完成真实 Chromium RED：前置 S2/strict/登记成立，响应许可、active 写入、未提交清理等 5 项断言准确失败。原件独立归档，不使用 fake-indexeddb。
- [x] 查询接受与关联边界每次核对相关且未退休的当前失败，不缓存查询起点的 undefined。等待仍只发生在取原票之前，时限仍为 3 秒。
- [x] 给 SessionStore 的接受转移增加可选同步否决端口，在真实 strict 事务读到状态后、fence 决定及 put 前执行。端口只可否决，不能换票或修改 fence；取消也在此边界重新核对。
- [x] 保持不同用户/CSRF、真实 mutation 新登录、取消/退休和合法内存模式；原 998 项覆盖集加 7 个新增控制共 1,005 项通过，web/E2E 类型与 19 文件零告警 lint 通过。
- [x] 负责人在同一最终源码运行真实浏览器 GREEN：新反例与原 session-fence 三浏览器 39/39；原交接/图片 60/60，均首次通过。生产构建及原预算通过；独审规格/质量 PASS、I1/I2 均 ADDRESSED。原件和实际清理已核对，P4 完整验收仍不预支。

I2 探针遵循实际层级约束：请求、采用响应、报告原失败由 `start.tsx` 的既有 e2e 专用分支注入真实端口，探针只持契约类型和回调，不引用 shared/api 或 zod。原生 IDB 与生产锁、仓库和协调器保持；仅添加事件监听和写入记录，不用替代存储模拟时序。准备阶段 lint 失败原件保留，不充作行为 RED。

小型测试命令统一为主目录 `tools/test-resources/run.py --repo <外部唯一轮次> check -- pnpm exec vitest run --project=unit-web <文件> --maxWorkers=2`，预期先精确断言失败、实现后全部通过。运行记录、源码 SHA 与真实清理核验在外部 `csrf-coordination-20261029/progress.md`。

局部实现、关联回归、独审和原三浏览器组合已完成并提交 `000022ae`，也是本轮完整门禁受测提交。full16 经 r07 精确补登接受，原 outer/审计失败保留；container05 与同源双门禁已独立接受。真实 capture 保持 r06，后续结果文档/最终来源/正常合并推送/同 SHA CI/关闭统一见[最终验收记录](../reviews/P4-S6-最终CI与关闭复核.md)，不预签 P4 关闭或 P5 开始。

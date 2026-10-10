# M4-P1 Codex 独立复核报告

- 日期：2026-10-10。
- 复核者：当前 Codex 会话继承模型，未参与本轮生产代码实现；本报告不推测精确模型型号。
- 基线：`795e4e4c`；被审对象为派发时完整未提交快照，以及复核反馈后实施者补充的两个测试文件。
- 独立工作树：`/Users/xiaoruan/project/nerve-office/.codex/worktress/codex/m4-p1-rerecheck`，分支 `codex/m4-p1-rerecheck`。
- 按 P1 设计 S8、`requesting-code-review` 与 `verification-before-completion` 核对。未提交、未修改主实施工作树；主项目目录检查结果仍为 `main`。
- 下文代码位置均相对本工作树根目录。日志与脚本目录：`/tmp/nerve-p1-codex-independent-20261010/`。

## 1. 结论

**本轮独立复核通过。没有发现尚未解决的 P1/P2 实现缺陷。** C1、C2、C4、C5、C6 的修复与短期互斥、主线程默认恢复符合当前 P1 设计。

独立变异最初发现两个新格式保护分支的测试缺口，已反馈给实施者补充测试，再由本复核者亲自撤回验证：各有一条目标断言失败，恢复后 410 条回归全部通过。生产代码未因这两项反馈改动。

此结论覆盖本报告列出的代码审查、单元回归、变异和 Chromium 真实 IndexedDB 复验；不替代 Phase 的完整门禁。完整 `pnpm verify`、全部浏览器、崩溃与 Linux 容器验收由主会话执行，不能把本报告的通过写成这些工作已经通过。

## 2. 根因与修复核对

| 检查项 | 代码位置 | 核对结果与依据 |
|---|---|---|
| C1：登记前恢复未完成不得登记 | `apps/web/src/shared/outbox/draft-recovery.ts:123`、`:184`、`:198`；`draft-writer.ts:479` | 写回失败、读主库失败和镜像读取失败进入 `unfinishedOf`；`registerWriter` 在该判断之后。三种错误的变异分别触发目标断言，旧写入者及镜像均被保留，重试继承第 11 份。 |
| C1：库中是候选写入者的旧草稿 | `writer-fence.ts:245`、`:253`；`draft-store.ts:646` | 先判高水位，再判代次；仅候选自己的更旧草稿可按 `keep` 写回，当前写入者与高水位保持不变。真实 IndexedDB 的 `absent`、`older` 两路均核对恢复内容、写入者和 `restored` 提示。 |
| C1：不能覆盖的未见候选 | `writer-fence.ts:255`；`draft-store.ts:637`；`draft-recovery.ts:210` | `unseen` 留下一次 `lost`，重复遇到同一状态不刷新现存 `lost` 时刻。非持句柄读者保留双方；`foreign` 同样不截断。相应变异触发两条用例失败。 |
| C2：新格式全链路保护 | `draft-recovery.ts:65`、`:177`；`draft-mirror.ts:207`、`:309`、`:320`、`:325`；`outbox-protocol.ts:93` | 任一槽位新格式使整份镜像不可恢复，也不能作为读库失败时的旧版退路；不留 `lost`，不补写、不截断、不覆盖。登记、写入和协议传递均支持 `not-mirrored/newer-format`。已登记状态与未登记的临时清空两条路径均验证。 |
| C4：文档、注释与覆盖率口径 | `docs/v0.1/M4-本地优先与离线恢复/00-M4-总设计.md:169`、`:386`；`01-P1-本机发件箱.md:560`；`apps/web/src/features/sheet-editor/outbox/outbox.worker.ts:4`；`vitest.config.ts:70` | 空定时器依据已区分 M0 与本轮数据；三个浏览器采用 Worker 的结论及主线程退路已说明；Worker 入口不再被排除于单元覆盖率。真实浏览器报告的旧体积行明确标注对应版本，本轮重新量出的体积见下一节。 |
| C5：清理主库和镜像完整串行 | `draft-writer.ts:256`；`local-cleanup.ts:89`、`:146`、`:169`、`:192` | 写入和三种清理共用同一来源的同一把锁。清理不能插入主库已提交、镜像尚未写入的间隙。删除镜像失败时保留墓碑；后续旧写入被拒绝并放开句柄，重试后清空。移除 Writer 或清理锁均触发竞态回归失败。 |
| C5：`retireUser` 三仓库并集 | `draft-store.ts:483` | `drafts`、`notices`、`writers` 在同一 strict 读写事务内取文档并集，既有写入者更新，剩余键新建墓碑；草稿与提示保留，其他用户不变。真实 IndexedDB 撤回 notice-only 分支后，目标墓碑为 `null`，用例失败。 |
| C6：先前存活的保留期与恢复分支 | `local-cleanup.test.ts:250`、`:288`；`draft-recovery.test.ts:121`；`tests/e2e/specs/outbox/mirror.spec.ts:396`、`:419` | 读不出槽位仍保留墓碑、时钟回拨超过保留期、`foreign` 不截断、主库高水位胜过代次、`keep` 恢复提示都有能杀死对应变异的测试。 |
| 平台只读恢复 | `draft-recovery.ts:233`、`:292`；`draft-store.ts:627` | 平台通过 `getFile` 读取，`clear`、`backfill` 不写镜像；`noteLost: false` 传入存储，`unseen` 也不留下 `lost`。把平台开关改为 true 后两条测试失败。 |
| 主线程默认恢复 | `draft-writer.ts:235`；`tests/e2e/specs/outbox/mirror.spec.ts:158` | 未注入 recovery 时由工厂组成 `pageMirror(opfsMirrorDirectory())`。浏览器用例直接使用该默认工厂，删掉 IndexedDB 后登记恢复镜像第 11 份，高水位为 11；撤回默认恢复后实际变为 0，用例失败。 |

### 2.1 短期互斥为什么覆盖两个已知交错

临时读者场景：主库停在 W1 第 10 份，镜像有第 11 份。读者先获得短期锁，临时拿到槽位句柄后暂停；新登记只能等待。读者恢复草稿、写入者高水位以及提示并完成任务后，登记才进入，继承 11。`draft-recovery-regression.test.ts:114` 用可控暂停制造该顺序；撤回 `enqueue` 的锁后，实际登记继承 10，断言失败。

写入与清理场景：写入先获得短期锁，IndexedDB 已提交但尚未写镜像时暂停。清理必须等待镜像阶段结束；写入结束后，Worker 的长期句柄仍可能让删除目录得到 pending，但墓碑会挡住后续写入。释放句柄、重试清理之后，主库与镜像都不再恢复旧草稿。`draft-recovery-regression.test.ts:219` 精确覆盖该间隙；分别撤回 Writer 与清理的锁均失败。

**busy 可继续登记有明确前提。** 所有参与本协议的文档任务、平台单份恢复与清理均经过该锁，内部 store、mirror、recovery 不重复申请。因此登记拿到短期锁时，其他任务的临时读及恢复已结束；剩下的 busy 可以来自空闲 Worker 保存的长期句柄。长期句柄不持短期锁，旧 Worker 的镜像只包含已提交主库的数据，接管可以继承主库高水位并继续写主库。真实 Chromium 的“高水位先于代次”用例实际走过旧 Worker 持句柄、新 Worker 登记与写入得到 busy 的路径。

### 2.2 锁失败、取消与释放

`outbox-lock.ts:11` 在 Web Locks 缺失时抛出 `NotSupportedError`，调用方转换成失败结果，未执行存储操作；没有无锁退化。锁请求传入 AbortSignal，等待最多 10 秒。回调开始时清掉等待定时器，返回并等待完整任务；没有用 `Promise.race` 提前释放锁。异常经 finally 收尾，后续任务仍可执行。

`outbox-lock.test.ts:14` 的可控持锁任务超过等待时限，取消的等待者没有执行，随后排队者在真正释放前也没有执行；移除取消动作后该用例超时失败。异常释放与所有公开恢复、清理入口在无锁条件下的失败均有单元覆盖。

## 3. 亲自执行的验证

| 验证 | 结果 |
|---|---|
| 派发快照，`pnpm exec vitest run --project unit-web apps/web/src/shared/outbox apps/web/src/features/sheet-editor/outbox` | 22 文件、408 条通过 |
| 首轮 18 处独立单元变异，每处恢复后完整重跑上述两目录 | 首轮杀死 14 处；每次恢复后 408 条通过 |
| 复制实施者补充的 `draft-mirror.test.ts`、`draft-recovery.test.ts`，重跑两目录 | 22 文件、410 条通过 |
| 补测试后再次做 U06、U07 | 各一条目标断言失败；每次恢复后 410 条通过 |
| 后端依赖构建与 `web build:e2e` | 通过；所有浏览器变异前后分别重新构建 |
| Chromium 基线：“清理前立墓碑”“主线程退路”“高水位先于代次”“保留现有写入者” | 5 条通过，0 跳过 |
| Chromium 的 4 处生产代码撤回 | 全部被目标断言杀死；恢复后对应用例分别 1、2、1、1 条通过 |
| 源码恢复校验 | 变异涉及的 7 个生产文件 SHA-256 均与各自变异前一致 |
| `git diff --check` | 通过 |
| 当前测试构建的生产发件箱 Worker | `outbox.worker-Ci-vgZ-n.js`：45,710 字节；gzip -9 为 13,537 字节（约 13.22 KiB） |

浏览器仅使用 Chromium，一个工作进程；自己的 PostgreSQL 容器 `nerve-p1-codex-independent-20261010`，随机映射 `127.0.0.1:50527`，`NERVE_TEST_DATABASE_URL` 指向其 maintenance 库。镜像使用本机现有固定摘要且 `--pull never`。测试服务的来源端口每次自动分配。结束后自己的容器及匿名卷已删除。没有运行 WebKit、崩溃、真实 Safari 或访问共享开发库。

环境副作用如实记录：第一次直接运行 `pnpm exec` 时，pnpm 自动补装缺少的依赖（971 包，输出 downloaded 0），并自动运行了 `prepare` 中的 `lefthook install`。这不是预期的 `--ignore-scripts` 安装方式，已立即告知主会话；没有另行修改 Git 钩子或主目录 HEAD。后续测试直接使用已安装的工具。

## 4. 单元变异明细

每次仅修改表列分支；读取实际失败日志之后恢复原始字节，再重跑两目录回归。数字是失败用例数，非构建失败数。首轮日志为 `Uxx-mutant.log` 与 `Uxx-restored.log`；补测在 `followup/`。

| 编号 | 变异 | 首轮结果 | 最终核对 |
|---|---|---|---|
| U01 | 登记忽略 `unfinishedOf` | 3 失败 | 写回、主库读取、镜像读取三种失败均阻止登记 |
| U02 | 读主库失败不带 `unread` | 1 失败 | 不会用不完整比对的高水位登记 |
| U03 | 镜像 failed 不算未完成 | 1 失败 | 镜像读取错误不能被静默忽略 |
| U04 | 恢复跳过整个镜像的新格式检查 | 1 失败 | 新格式与 torn 并存不能留 lost |
| U05 | attach 忽略新格式 | 2 失败 | 两种混合槽位均拒绝写镜像 |
| U06 | 临时 clear 不检查新格式 | 存活 | 反馈补测后 1 失败，已恢复并通过 410 条 |
| U07 | `mirroredRecords` 接纳混合新格式中的旧记录 | 存活 | 反馈补测后 1 失败，已恢复并通过 410 条 |
| U08 | 平台恢复 `noteLost` 改为 true | 2 失败 | torn 与 unseen 均遵守平台不留 lost |
| U09 | `foreign`、`unseen` 也截断 | 2 失败 | 两类候选均保留 |
| U10 | 读不出槽位时不加入 remaining | 1 失败 | 不能提前删除墓碑 |
| U11 | 过期判定使用墙上时间差绝对值 | 1 失败 | 向未来超过 14 天仍不算过期 |
| U12 | Writer 的文档任务不持短期锁 | 3 失败 | 恢复/登记、提交/清理、无锁环境三路认出 |
| U13 | 清理不持短期锁 | 2 失败 | 提交后镜像前清理及无锁环境认出 |
| U14 | 没有 Web Locks 仍执行任务 | 1 失败 | 存储不动的断言认出 |
| U15 | 等待定时器不取消请求 | 1 失败 | 5000 ms 测试超时；表明缺失有界取消后等待不会结束，未计作普通目标断言失败 |
| U16 | 已开始回调不清除等待定时器 | 存活 | 等价：原生 Web Locks 以及测试替身在回调开始后均不以该 signal 取消已获得的锁，finally 仍清定时器；没有提前释放或取消正在运行任务 |
| U17 | 默认主线程恢复改为空实现 | 存活 | 单元未构造浏览器 OPFS；下节 B04 的真实浏览器用例杀死，属于分层覆盖 |
| U18 | 平台单份恢复不持短期锁 | 1 失败 | 无锁环境必须失败的用例认出 |

补测后的 18 个单元变异中，16 个已被单元测试杀死；U17 在浏览器层杀死；U16 按语义等价保留记录，不虚报为杀死。

## 5. 真实 IndexedDB 撤回明细

全部由本复核者在独立工作树完成，使用真实 `draft-store.ts`，并非假存储。构建日志、测试 stdout、Playwright 结果 JSON 和服务日志均保存在证据目录，分别以 `Bxx-mutant`、`Bxx-restored` 开头。

| 编号 | 撤回位置与确定场景 | 实际失败 | 恢复后 |
|---|---|---|---|
| B01 | `writer-fence.ts:249` 的较大代次分支移到高水位之前；旧 W5 镜像第 10 份仍被旧 Worker 持有，新 W3 force 接管并在主库写第 11 份 | `mirror.spec.ts:413` 预期 `[3,11,"eleven"]`，实际 `[5,10,"ten"]`；1 条失败 | 1 条通过 |
| B02 | `draft-store.ts:650` 的 restored 提示在 `keep` 分支省略；分别构造库里没有草稿、库里只有候选自己的旧草稿 | `mirror.spec.ts:437` 预期 restored 对象，实际 `null`；2 条失败 | 2 条通过 |
| B03 | `draft-store.ts:500` 的 notice-only 文档不加入 retireUser 并集 | `cleanup.spec.ts:38` 预期对应墓碑，实际 `null`；1 条失败 | 1 条通过 |
| B04 | `draft-writer.ts:235` 默认 recovery 变为空实现；Worker 写第 11 份、退出，删除 IndexedDB，再使用主线程默认工厂登记 | `mirror.spec.ts:169` 预期高水位 11 与已有草稿，实际高水位 0、existing undefined；1 条失败 | 1 条通过 |

## 6. 两项反馈及闭环

1. **临时句柄清空的新格式保护缺少测试。** 原有回归先调用 `register`，镜像已进入 `newer` 状态，随后 `remove` 走 `draft-mirror.ts:320`，无法验证 `:325` 中未 attach 时临时打开槽位的检查。实施者补充 `draft-mirror.test.ts:200`：直接 `clear(KEY)`，断言状态和两个文件逐字节保留。本次复验撤回 `:325` 后实际返回 mirrored，目标用例失败。
2. **主库读失败时的新格式旧版退路缺少测试。** 原有恢复回归在主库 absent 状态下运行，`versionsToOpen` 不选择镜像，无法验证 `draft-recovery.ts:65` 的保护。实施者补充 `draft-recovery.test.ts:92`：主库 failed、槽位为 newer-format 加 valid-old，要求空候选集。本次复验撤回 `:65` 后实际交回旧记录，目标用例失败。

两处都是承重保护分支的测试缺口，当前生产保护实现原本正确。补测及独立撤回闭环完成后，本轮没有剩余修复请求。

## 7. 本报告未作验收结论的范围

- 编辑器保存管道、用户提示、恢复选择与本机草稿页面的完整用户故事：按 P1 范围属于 P2–P4，当前复核只确认供这些 Phase 使用的接口及底座行为。
- 真实 Safari、WebKit、崩溃、Linux 容器和完整 verify：由派发明确交给主会话；本报告不复用历史报告数字冒充本次亲跑结果。
- `unseen` 在服务端代次倒退且主库又丢登记与写入时，不能自动判断候选更新：这是当前设计及 ADR 明示的限制；本轮确认保留镜像并如实留提示，没有扩大恢复判断的范围。
- 清除站点数据、整个浏览器存储桶回收、未遵守本协议的旧版本写入者：不由同源短期 Web Lock 或同桶镜像保证，未据此把当前修复判为失败。

## 8. 可复核证据

- `unit_mutations.py`、`unit-results.json`、`unit-summaries.json`：首轮 18 处变异与恢复结果。
- `followup-baseline.log`、`followup_mutations.py`、`followup/unit-results.json`：补测试后的 410 条基线与 U06/U07 复验。
- `browser_mutations.py`、`browser-baseline.log`、`browser-results.json`、`B01-*` 至 `B04-*`：真实 IndexedDB 撤回、构建与恢复结果。
- 对应源码恢复 SHA-256 写在各结果 JSON 中；全部被变异的生产文件已经恢复。独立工作树仅保留派发快照、从实施者取回的两个补充测试以及本报告，没有保留变异代码。

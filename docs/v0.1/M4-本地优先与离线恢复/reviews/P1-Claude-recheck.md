claude-opus-5-5

# M4-P1 审查之后的独立复验（A1–A19、B1–B14 的修复）

- 复验者：claude-opus-5-5（Opus 5.5），没有参与实现与审查；只复验、不修复、不提交。
- 范围：`afae6422..c1492765`（合并提交：丁 `373aecda`、丙 `4ca3f7e3`、甲 `90d65724`、乙 `62ca7a99`（含 A2 订正 `6e3ae782`）；主会话文档 `8e5fe9ac`、`40f20423`、`2359a00d`、`c1492765`）。
- 副本：`scratchpad/m4-p1-recheck`（`git clone` 主仓库，本地分支 `m4-p1-recheck` 停在 `c1492765`）。结束时 `git status` 干净：撤回与变异都已还原，测试构建按干净的源码重建过；探针文件 `apps/web/src/shared/outbox/zz-recheck-probes.test.ts` 留在副本里，经 `.git/info/exclude` 排除（不进 git status，不提交）。
- 环境：自己的临时 PostgreSQL（`nerve-recheck-p1-pg`，自己的网络 `nerve-recheck-p1-net`，127.0.0.1:55493）与 Linux 容器用的卷 `nerve-recheck-p1-work`，跑完都已删除；没碰共用的开发库与别人的容器、网络、卷；丁的卷 `nerve-office-s7-crash-linux` 只读挂载（锁文件与各 package.json 的 sha256 与我的副本一致之后拷它的 node_modules，`--offline` 装不了：供应链策略要元数据）。没访问网络、没拉镜像、没碰真实 Safari。crash-webkit 与 webkit 的撤回复跑都在主会话确认机器上没有别的 Playwright WebKit 之后跑的，跑完已告知交还。
- 工具与日志：脚本 `scratchpad/recheck-p1-tools/`（`harness.py`、`reverts_unit.py`、`reverts_browser.py`、`lint_a7.py`、`mutations.py`、`mutation_v01_browser.py`）；日志 `scratchpad/recheck-p1-logs/`；Linux 容器 `scratchpad/recheck-p1-linux/`（`run.sh`、`inside.sh`、`out/`）。

## 〇、跑过的

| 跑了什么 | 结果 | 耗时 |
|---|---|---|
| `pnpm lint` | 通过 | 80 s |
| `pnpm typecheck` | 通过 | 7.5 s |
| `pnpm test` | 361 个文件、7278 条全过（发件箱两个目录 20 个文件 389 条） | 68 s |
| 测试构建之后 `specs/outbox`，chromium、chrome、webkit | 144 过、3 跳过（WebKit 上没有 CDP 的写满两条与授予持久保存一条，按设计） | 48 s |
| `crash-chromium`、`crash-chrome`（`--no-deps`） | 22 过、8 跳过（按设计） | 64 s |
| `crash-webkit`（`--no-deps`，主会话确认之后） | 10 过、5 跳过（只在 Chromium 系的几条） | 1.7 min |
| 压力：`specs/outbox` chromium、chrome，`--repeat-each=3 --workers=12` | 294 过，0 不稳定 | 1.5 min |
| **Linux 容器**（本机已有的 `mcr.microsoft.com/playwright:v1.63.0-noble`，arm64）：`specs/outbox` 与校准 `selftest.spec.ts:340`（storage-quota，起持久上下文的那一步），chromium、webkit | 97 过、3 跳过 | 28 s |
| Linux 容器：`crash-chromium`、`crash-webkit`（`--no-deps`） | 21 过、9 跳过 | 56 s |
| Linux 容器：B1 撤回（容器里那份 `profileDirFor` 改回 `testInfo.outputPath`），webkit 的 `mirror.spec.ts` 与 storage-quota | **17 条全部失败**，错误都是 `Cannot parse arguments: Invalid byte sequence in conversion input` | 8 s |
| 亲自撤回：单元 16 处、浏览器层 8 处、lint 规则 3 条与三类违规样例 | 见第二节 | — |
| 自己的变异 17 处（单元 14、浏览器层 3）+ 其中一处补跑浏览器层 | 认出 10、存活 7，见第四节 | — |
| 测试构建的 `outbox.worker-*.js` | 43,137 字节、gzip -9 12,875 字节（与乙的报告一致）；没有 zod、`new Function`、`window`/`document`/`localStorage`/`sessionStorage` | — |
| 我的探针 `zz-recheck-probes.test.ts` | 8 条，断言写成"问题存在"，全部通过（即问题都在）；lint（`--no-ignore`）与 web 的类型检查通过 | 0.6 s |

## 一、结论

**修复后通过。** 审查 A、B 的各条都已按主会话的决定从根因修了，亲自撤回的每一处都有用例失败（A2 有一处只在单元层认得出，见 C6）；三个浏览器、两个 Chromium 系的压力、本机与 Linux 的崩溃项目都全过，B1 在 Linux 上撤回即红、修复后全过。

要在合并之前改的只有一条文档（C3：P1 设计 §3.4.6 与 M4 总设计 §6.4 仍写着"版本不小于当前的 → 已损坏、都删除"，与 A3 的"stale-key 绝不删除"相反，P3/P4 照它实现就会误删）。C1 建议本 Phase 一并处理（A2 订正之后的规则本身在"登记之前比对做完"的前提下没有漏洞，但前提破了时会悄悄丢掉镜像里没写回的那一份，修法很小）。其余记录。

## 二、逐条核对

"撤回"一列是我亲自撤回那一处修复之后失败的用例数（每次只撤一处，跑完即还原）；没写的是只核对代码与文档。

| 编号 | 修复的提交 | 亲自撤回的结果（失败的用例数） | 结论 |
|---|---|---|---|
| A1 | `d2519b7f`（存储 `removeUserData` 的 retire 分支、`local-cleanup.ts` 交 retire） | 浏览器层：存储里 retire 分支改回"写入者照留"（不换墓碑、不立墓碑）→ `mirror.spec.ts:400` chromium、webkit **2** 条失败（`cleanup.spec.ts:14` 不带 retire，照过） | 通过 |
| A2 | `d2519b7f` + 订正 `6e3ae782` | 单元：`decideRestore` 回到 afae6422 的代次优先 **7**；只撤订正（不同写入者一律 foreign）**9**；镜像里最新的按 `compareDrafts` 取 **1**；补写不看是不是同一个写入者 **1**。浏览器层：只撤订正 → `mirror.spec.ts:322` chromium、webkit **2**；**只撤 `decideRestore` → 0**（`:295` 被"按代号取最新"掩盖，见 C6） | 通过（规则的前提见 C1，测试缺口见 C6） |
| A3 | `d2519b7f` | 单元：不分 stale-key **5**；最新的解不开时退回更旧的版本 **3**。浏览器层：`records.spec.ts` chromium **1** | 代码通过；**文档没跟上（C3）** |
| A4 | `d2519b7f` | 单元：槽位不核对键 **3** | 通过 |
| A5 | `d2519b7f` | 单元：镜像那一段出错时整个交回 failed **1** | 通过 |
| A6 | `d2519b7f` | 单元：放弃不换墓碑 **2**、保留期删写入者而不是换墓碑 **2**。浏览器层：放弃 chromium、webkit **2**；保留期 chromium **2**（`cleanup.spec.ts:41`、`mirror.spec.ts:428`） | 通过 |
| A7 | `bad1ef52` | lint 自测（本机发件箱那一组 11 条）：撤回"只在主线程用的模块"那一条 **2**、"区域之外"那一条 **3**、只在页面里有的全局 **3**。三类违规样例放进源码树跑 eslint：直接（Worker 一侧引用 `local-key.ts`、`local-cleanup.ts`）2 处、间接/区域之外（`*.worker.ts` 引用 zod、请求层、`outbox-worker-client.ts`、`../edit-mode.ts`）4 处、DOM（`document`、`window`、`localStorage`、`globalThis.sessionStorage`、`persist`、动态 `import()`）6 处，规则在时全报；撤回对应的那一条之后那几处不再报 | 通过（C9 记录） |
| A8 | `d2519b7f` | 单元：更新格式的槽位也算写一半 **1** | 通过（残留见 C2） |
| A9 | `d2519b7f` | 单元 **1**；浏览器层 `mirror.spec.ts:428` chromium **1** | 通过 |
| A10 | `d2519b7f` | 单元：槽位里更新的记录格式读成 mismatch **2** | 通过（残留见 C2） |
| A11 | `c1492765` | ADR-020"读与恢复"、P1 设计 §3.8：槽位之间按代号认最新写的，库与镜像不按代次比、按库里的写入者判；`compareDrafts` 只比同一个写入者 | 通过 |
| A12 | — | 还没写进任何文档（应进交接单、P4） | 待交接单（C7） |
| A13 | `d2519b7f` | 单元：一份出错就停下 **1**；协议改成 `mirrored-documents` + `reconcile {draft}`，每份一个请求 | 通过 |
| A14、A15、A16 | — | 还没写进任何文档（都是给 P2 的，应进交接单） | 待交接单（C7） |
| A17 | `c1492765` | ADR-020"保留期"一条写了按墙上时间的限制 | 通过 |
| A18 | `d2519b7f` | 浏览器层：平台页面里读不到镜像（`readSlots` 一律 absent）→ `mirror.spec.ts:351` **1** | 通过（C8 记录） |
| A19 | `d2519b7f` | `draft-recovery.ts` 拆出（`reconcileAction`、`versionsToOpen`、`createDraftRecovery`、`pageMirror`、`reconcileAll`），经 `options.recovery` 注入，Worker 里的处理配同一个镜像与存储 | 通过 |
| B1 | `2a7e0767`、`40f20423` | Linux 容器：`profileDirFor` 改回 `testInfo.outputPath` → webkit **17** 条全部失败（`Cannot parse arguments`）；修复后 Linux 的 webkit `specs/outbox`、storage-quota、crash-webkit 全过 | 通过 |
| B2 | `2a7e0767` | 读码：三个崩溃用例按被测来源取那一条日志（`indexedDbLogOf`），前提不在时说明以"UR-034 的前提不在了"开头、到时的处理写在文件开头；本机与 Linux 的崩溃项目全过 | 通过 |
| B3 | `d2519b7f` | 单元：入口改成一次性的 `setTimeout` **1** | 通过 |
| B4 | `d2519b7f` | 单元：拿到一个、另一个拿不到时不放开 **2**；覆盖率排除里去掉了 `mirror-directory.ts` | 通过 |
| B5 | `cfece2ea` | 复核报告第 12 项、F5、F9、DEF-072、计划书 r22 §12.2 按冷热对照改写（缓存照常，Worker 6/12 对主线程 0/12） | 通过 |
| B6 | `cfece2ea`、`2359a00d` | ADR-020 与复核报告按数据说（1/75 对 0/130，p ≈ 0.37，保留靠 M0）；**M4 总设计 §6.1、§7 仍写"实测有效""空定时器有效"** | 部分（C4） |
| B7 | `8e5fe9ac`、`40f20423`、`c1492765` | P1 设计的三个仓库、提示进库、§3.1 模块清单、§3.4.7、§3.7 的资料目录、变更记录都对齐了；**§3.4.6 解不开的归类没改** | 部分（C3） |
| B8 | `8e5fe9ac` | UR-034 与设计 §3.8：5 + 9 + 1 = 15，与"15 次前兆对 15 次删库"一致 | 通过 |
| B9 | `8e5fe9ac`、`cfece2ea` | CLAUDE.md 列了 `--timeout`、`--runs`，崩溃项目之间并行，measure:probe 约 9 分钟 | 通过 |
| B10 | `bad1ef52`、`2359a00d` | lint 规则与设计 §3.1、架构总览的说法一致；覆盖率排除清单与 ADR-020 一致 | 通过 |
| B11 | `8e5fe9ac` | 总设计 §2.2、§6.1、§6.3、§7 被取代的说法就地改了 | 通过（B6 的残留见 C4） |
| B12 | `cfece2ea` | 复核报告第 10 项写明两档都按异步段 ≤ 10 ms 判，与 `probe-verdicts.ts` 一致 | 通过 |
| B13 | `cfece2ea` | 复核报告加了体积表（6b1f9c75 之后 39,719 / 11,999）；修复之后实测 43,137 / 12,875，ADR-020 的影响一节已是 12.6 KiB | 通过（报告的表可补修复之后的数，C4） |
| B14 | `d2519b7f`、`bad1ef52`、`2a7e0767` | `waitForRelease`、`fullyParallel` 的说明、探针注释挪正、`canSealDrafts` 抽成纯函数并有单元测试、"冻在提交之前 n / 10"的注解 | 通过 |

### 新机制逐个接口核对

**墓碑**（`writerId = 'retired'`）：
- 读写入者的每一处：登记（`decideRegistration` 按代次与 force 照常，同一代不同 writerId → superseded，存储拒绝用 `retired` 登记）、写入 / 重封 / 确认与改基准（`isCurrentWriter` 排除墓碑，伪造 writerId 也一样 not-writer）、放弃（不核对写入者，按设计）、按用户清理（无 retire 时连墓碑一起删；有 retire 时已有的墓碑幂等）、保留期（`writerRetention` 对墓碑 keep）、比对与写回（`decideRestore` → retired，`draft-recovery` 截断镜像）、补写（墓碑下写入被拦、Worker 随之 detach，不再补写；本页重新登记时先比对、遇墓碑先截断再换掉墓碑）、`recordLost`（墓碑算"还有写入者"，不留 lost）、列出（`listDrafts`、`draftDocumentIds` 只读草稿仓库，与墓碑无关）、合一的清理（放弃成功时 `dropTombstones`，保留期按"镜像目录不在"删，`dropTombstones` 只删仍是墓碑的那条）——都对。
- 墓碑不会永远留下：按用户清理再调（这个人仍是退出的）连墓碑删；放弃时镜像目录删得掉就删；其余由保留期在镜像目录过期回收之后删（没有 OPFS 时同一次全删）。唯一的例外是读不出槽位文件的目录（V01，测试缺口，见第四节）。

**镜像胜过库的口径**：读与登记都先 `reconcile`（写回与否在存储的事务里按 `decideRestore`），`versionsToOpen` 只交回最新的那一个版本（库与镜像里同一版本互为备份）；登记之后的补写（`mirror.backfill`：镜像里最新的是同一个写入者、不比库旧时不写，否则写库里那一份）与 `decideRestore` 的结论一致（写回了的就是库里那份；没写回的库胜出）；lost 只在两个槽位都不合格（更新的格式不算）且库里草稿与写入者都没有时留。代次倒退之后 force 登记、接手、写、读、再删库读的整条路径由 `mirror.spec.ts:295` 在三个浏览器上走通。例外与前提见 C1、C2。

**stale-key**：`unsealFailureOf` 三分；`openVersions` 按要交回的那个版本归类；协议 `readOpenedRecord` 认它（V08 撤掉即红）；客户端与处理只是透传；`setKey`/重封用管道记着的内容，不解封；本页自己的记录解不开时（`remember`）交回 `failed`/`DraftUnreadable`，消息里带原因、不删除——安全，只是调用方分不出是 stale-key（记录）。比对只看元数据，不解封。

## 三、新发现

### C1【建议】登记之前的比对没做完时，登记照样成功，之后本页的写入把镜像里没写回的那一份盖掉；A2 订正之后的规则在这种"分叉"的状态下判错

- **位置**：`draft-writer.ts:466-486`（`register`：`reconcileOf` 的 `problem` 只用来跳过补写，登记照常；镜像读不出（busy、failed）时连 problem 都没有）；`draft-mirror.ts:244-274`（`write` 第一次拿到句柄时直接写"不是最新的那个"槽位，不比对）；`writer-fence.ts:244-246`（规则 4：库里有草稿就 foreign）。
- **问题**：A2 订正的规则成立的前提是"每一次登记之前，比对都读到了镜像、做完了写回"——这样新登记的写入者继承的高水位一定看过镜像里的那一份，草稿序号是一条线。在 UR-034 一类"库丢了最后提交的写入"之后（库退回到第 10 份、镜像里有第 11 份），只要这一次登记时比对没做完：
  1. 写回时库一时出错（`restoreDraft` 交回 failed）→ `register` 照样登记、高水位 10、交回的现有草稿是旧的第 10 份；
  2. 或者读镜像一时出错 / 被占着 → 比对什么也没做，同上；

  之后本页每次写镜像都写在"不是最新的那个"槽位上，**第二次写入就把第 11 份盖掉**，库与镜像里都没有了，也没有任何提示（设计里"比对没做完时不补写：还不知道镜像里那一份该不该胜出，不拿库里的盖掉它"——补写挡住了，写入没挡住）。而且一旦落进这种状态，之后的比对也救不回：库里的写入者（新的一代、高水位 10、还没写）与草稿（W1 的第 10 份）在，镜像里 W1 的第 11 份按规则 4 是 **foreign**（库里的草稿其实是候选那个写入者自己更早的一份，并不是"库里写入者自己的草稿"）；本页写了自己的第 11 份之后（那次镜像若没写成，镜像里最新的仍是 W1 的第 11 份），W1 的第 11 份又按规则 1 是 **seen**（序号撞上了，其实没看过），不是写入者的页面会把它截断。另有一种连前提都不需要破的：服务端代次倒退之后以 force 登记的那一次（代次更小）连同它的写入被库丢掉，规则 2 认不出（候选的代次比库里的小）→ foreign。
- **复现**：探针 `scratchpad/m4-p1-recheck/apps/web/src/shared/outbox/zz-recheck-probes.test.ts` 的 C1 一组 5 条（对照 1 条：比对做完时第 11 份写回、高水位 11；`restoreDraft` 失败一次 / 拿句柄失败一次时登记成功、两次写入之后槽位只剩 `e4:seq11`、`e4:seq12`；规则 4 与规则 2 的两个纯函数断言）。跑法：在副本里 `npx vitest run --project unit-web apps/web/src/shared/outbox/zz-recheck-probes.test.ts`。
- **发生的条件**：库丢写入（Google Chrome 不注入时 1400 次强制结束 5 次）之后的那一次登记，恰好遇上一次性的出错，概率很低；但后果是悄悄丢掉最后几次修改、没有提示，正是 OPFS 冗余要防的那一类。
- **建议的修法**（都小）：
  1. `register`：写回时库出了问题（`reconciled.problem` 有值）就交回这个问题、不登记（与 `read` 一样，P2 稍后重试）。镜像读不出（busy、failed）时照常登记——busy 多半是上一任写入者还拿着句柄，它要等这一次登记之后被拦下才放开，不能等它，否则互相等死——但本页之后**第一次拿到句柄时（登记时的 `attach` 与 `write` 里懒拿句柄都算），先拿着句柄比对一次再补写或写入**：拿到之后镜像只有本页能动，读到的就是稳定的。
  2. 规则 4：库里的草稿就是候选那个写入者更早的一份（同一个写入者、`compareDrafts` 更旧）时按 keep 写回（换掉那份草稿、不动库里的写入者与高水位）——它不覆盖任何人的修改，活着的那一页下一次带着旧的 `adoptSeq` 写入会得到 foreign-draft，由 P3 重新决定。现有单元用例"库里是更新的一代（还没写过）、草稿是候选那个写入者更早的一份：foreign"随之改。
  3. 规则 2 遇到代次倒退是固有的限制，写进 ADR-020"读与恢复"。

### C2【记录】更新的页面写的槽位与写一半或合格的旧槽位并存时，旧页面仍会毁掉它（A8、A10 的残留）

- **位置**：`draft-recovery.ts:68-70`（`hasTornSlot` 只排除了 newer-format 本身）、`:189-197`（lost 之后截断两个槽位）；`draft-mirror.ts:187-195`（`attach` 只认合格的槽位，`newestSlot` 看不见 newer-format 的那一个，第一次写入就写在它上面）。
- **问题**：A8、A10 修好的是"只有一个更新格式的槽位、另一个空"这一种。部署回滚 + 崩溃 + 删库时：`[newer-format, 写一半]` → 读回 absent、留下 lost、**两个槽位都截断**（更新的页面写的那一份也没了，提示也不对：数据不是丢了，是旧页面读不懂）；`[newer-format, 合格的旧一份]` → 写回旧的一份、留 restored，登记之后写一次就盖掉更新的那个槽位。库这一侧对更新格式的记录是"不动它"，镜像这一侧不一致。
- **复现**：探针同一文件的 C2 两条。
- **建议**：有 newer-format 的槽位时按"认不出"处理——不留 lost、不截断；`attach` 时把 newer-format 的槽位当作最新的那一个（只写另一个），或者干脆不在这份文档上写镜像、结果里如实带上。条件很窄（回滚 + 删库），可以记进 ADR-020 与延期登记，P1 之后再改。

### C3【必须修（文档）】"stale-key 绝不删除"没写进 P1 设计 §3.4.6 与 M4 总设计 §6.4，两处仍是"否则 → 已损坏、都删除"

- **位置**：`docs/v0.1/M4-本地优先与离线恢复/01-P1-本机发件箱.md:405-407`（"记录的密钥版本小于当前版本 → revoked；否则 → corrupted"）；`00-M4-总设计.md:235`（§6.4 的表："否则 → '记录已损坏，无法恢复'。都删除"），以及 `:14` 第 6 条只说"区分已吊销与已损坏"。
- **问题**：A3 的决定是"记录的版本比本页的新 → 本页的密钥过时，取新密钥再试，绝不删除"，代码、ADR-020、P1 设计的变更记录都改了，正文的这两处没改。P3（打开文档时的恢复）、P4（本机草稿页）照总设计 §6.4 的表实现，就会把另一个标签页用新版本密钥写下的、完好的草稿当"已损坏"删掉——正是 A3 要防的。
- **建议**：两处改成三分（revoked 删、stale-key 取新密钥再试不删、corrupted 删），总设计的变更记录补一行。

### C4【记录】文档里几处没跟上

- M4 总设计 §6.1（第 169 行）"真实 Safari 上实测有效"、§7 风险表（第 386 行）"结论：空定时器有效"——与 B6 之后 ADR-020、复核报告的措辞（这一轮分不出，保留靠 M0）不一致。
- `outbox.worker.ts` 文件开头的注释仍是"真实 Safari 上有没有效由 S1、S8 复核；无效时 WebKit 改在主线程放置"；P1 设计 §3.8"放置"仍写"真实 Safari 的复核如果要求 WebKit 改在主线程放置……"、"生产里 Chromium 系一律用 Worker 放置"（定论是三个浏览器都用 Worker）；§3.8"只有用户的数据清理（退出登录、账户停用）与保留期才删目录"漏了放弃。
- 复核报告的 Worker 体积表只有修复之前的 39,719 / 11,999；修复之后是 43,137 / 12,875（ADR-020 已是 12.6 KiB），表里可补一行。
- `vitest.config.ts` 仍把 `outbox.worker.ts` 排除在覆盖率之外（理由"由浏览器层用例覆盖"），B3 之后它已有单元测试，可以去掉这条排除。

### C5【记录】按用户清理先删镜像目录、再清库；两步之间那一页写成并重建了目录时，清理交回"清完了"，这个人的草稿却留在镜像里，下一次比对写回

- **位置**：`local-cleanup.ts:134-151`（`removeUser`：逐份 `removeDocument`，之后 `removeUserData`）。
- **问题**：那一页的发件箱 Worker 这时没拿着句柄（例如上一次被占着、正在退避，或者放开之后又要写）时，它在两步之间的一次写入会经 `attach` 重建目录、写进镜像；之后库被清空（写入者也删了），清理交回 `pending: []`。那一页之后的写入照样被拦（栅栏没问题），但镜像里留着这个人最后一次写的草稿，下一次任何页面比对（同一个人重新登录、P4 的平台页面）按"没有写入者、没有草稿"写回、留 restored。草稿是加密的，别人读不出；只是"退出登录清空"不成立，账户停用之后同样留着到保留期。
- **复现**：探针同一文件的 C5 一条（假存储在 `removeUserData` 开始之前停住，这期间写一次）。
- **建议**：清完库之后再核对一遍镜像目录（还有就再删一次，删不掉的照 pending 处理并立墓碑），或者先在库里立墓碑、再删镜像目录、最后清库。窗口很小，记录即可。

### C6【建议】测试缺口（亲自撤回与变异里存活的）

- A2：只撤回 `decideRestore`（回到代次优先）时浏览器层 `mirror.spec.ts:295`、`:322` 都过——`:295` 的旧一代镜像在"按代号取最新"之下根本不会被交给存储判定。单元层 7 条认得出，所以不是漏测，只是浏览器层没有一条单独钉住"库里写入者的高水位胜过代次"。可补：force 登记之后那一页写第 11 份时镜像被占着（另一个标签页拿着），之后比对，库里那一份胜出。
- V06（登记时比对没做完也补写）存活：`reconciled.problem === undefined` 这条守卫没有用例（与 C1 同一处）。
- V14（本页不是写入者时 foreign 的镜像也截断）存活：没有用例核对"foreign 不截断"。
- V16（存储写回 keep 时不留 restored 提示）浏览器层存活：真实 IndexedDB 存储的 keep 分支没有浏览器层用例（单元层用的是假存储，是另一份代码）。
- V01（保留期里读不出槽位文件的目录不算"还在"，墓碑照删）单元与浏览器层（chromium、webkit）都存活：`remaining` 对"读不出"那一类的保护没有用例；一时出错时墓碑被删、镜像里放弃过的那一份之后可能被写回。
- V02（改动时刻在将来也算过期）存活：用例里"将来"只有 60 秒，钉不住"时钟往回拨超过 14 天"那一种。

### C7【记录】A12、A14、A15、A16 还没写进任何文档

都是给 P2/P4 的提醒（保留期与平台页面的比对读出全部记录的完整值要节流；重封、改基准、换密钥的结果里没有镜像的状态；取用途中收到的新版本不记下；`duplicate` 只认同一写入者同一序号、P2 不得对不同内容重用序号），按审查 A 的结论应进交接单（此时还没写），写交接单时别漏。

### C8【记录】平台页面的比对每次读出、校验全部槽位的完整内容

- `pageMirror.read` 经 `getFile().arrayBuffer()` 读出两个槽位的全部字节、算 SHA-256；ADR-020 写的是"打开平台、本机草稿页列出之前"都比对。草稿多、每份几 MiB 时，平台每次启动都要读、算几十上百 MB（与 A12 同一类）。P4 接入时节流，或者先只读 256 字节的头与库里的元数据比对，要写回时才读整份。

### C9【记录】lint 的"不依赖 DOM"是黑名单

- `OUTBOX_PAGE_ONLY_GLOBALS` 的 22 个名字之外，`DOMParser`、`XMLSerializer`、`Image`、`HTMLElement`、`MutationObserver` 这类专用 Worker 里没有的照样过 lint，tsconfig 带 DOM 的类型库，类型检查也过。现在 Worker 一侧没有用到它们（产物里核对过）。更稳的做法是给 Worker 一侧的文件单独一份只带 `WebWorker` 类型库的 tsconfig，让类型检查兜底；记录即可。

## 四、变异（我自己挑的，不照搬实现者的清单）

每处改坏一处、跑对应的用例、立即还原（`recheck-p1-tools/mutations.py`；日志 `recheck-p1-logs/mutations.log`）。单元层跑发件箱两个目录的 20 个文件 389 条（探针文件当时移出）；浏览器层跑 `mirror.spec.ts` 与 `cleanup.spec.ts`（chromium）。

| 编号 | 位置 | 改坏成 | 结果 |
|---|---|---|---|
| V01 | `local-cleanup.ts` purgeMirror | 读不出槽位文件（被占着、出错）的目录不算"还在"，它的墓碑照删 | **存活**（单元；补跑浏览器层 chromium、webkit 37 过也存活）——测试缺口（C6） |
| V02 | `local-cleanup.ts` isStale | 改动时刻在将来也算过期（`Math.abs`） | **存活**——测试缺口（轻，C6） |
| V03 | `draft-recovery.ts` versionsToOpen | 库里没有、也没写回时拿镜像里最新的顶替 | 认出（1） |
| V04 | `draft-recovery.ts` reconcileAction | 库里有草稿、镜像里没有合格的时不补写 | 认出（2） |
| V05 | `draft-mirror.ts` attach | 拿句柄时忘了哪个槽位是最新写的 | 认出（8） |
| V06 | `draft-writer.ts` register | 比对没做完也补写 | **存活**——测试缺口（C6；与 C1 同一处） |
| V07 | `mirror-slot.ts` parseSlot | A4 只核对文档、不核对用户 | 认出（1） |
| V08 | `outbox-protocol.ts` | 协议读不懂 stale-key | 认出（1） |
| V09 | `writer-fence.ts` decideRestore | 库里还有旧一代的草稿时不换写入者（replace 只在没有草稿时） | 认出（2） |
| V10 | `writer-fence.ts` decideRestore | 库里的写入者已有自己的草稿也按 keep 写回（覆盖它） | 认出（2） |
| V11 | `writer-fence.ts` retiredWriterOf | 墓碑的代次归 1 | 认出（2） |
| V12 | `local-cleanup.ts` abandon | 库里本来就没有、镜像目录删不掉时不换墓碑 | **存活**——安全上等价：这时库里还有活的写入者，它的高水位照样挡住镜像里那一份被写回；差别只是不打断那一页（换墓碑会让正在写的那一页下一次 not-writer）。是否需要在 absent 时也换墓碑，可以再定 |
| V13 | `draft-recovery.ts` pageReconciliation | 比对一份时的意外不折成 failed | 认出（1） |
| V14 | `draft-recovery.ts` reconcile | 本页不是写入者时 foreign 的镜像也截断 | **存活**——测试缺口（C6） |
| V15 | `draft-store.ts` removeUserData（浏览器层） | 没有写入者的那一份立的墓碑，高水位不看留下的草稿 | **存活**——在现有的读法下等价：留下的草稿在，新的登记按 max(墓碑, 草稿) 取高水位；墓碑本身一律挡住写回 |
| V16 | `draft-store.ts` restoreDraft（浏览器层） | keep 写回时不留 restored 提示 | **存活**——测试缺口（真实存储的 keep 分支没有浏览器层用例，C6） |
| V17 | `draft-store.ts` dropTombstones（浏览器层） | 删墓碑时把又登记了的活写入者也删掉 | 认出（1，`mirror.spec.ts:372`） |

合计 17 处：认出 10，存活 7（等价 2：V12、V15；测试缺口 5：V01、V02、V06、V14、V16）。

## 五、证据与路径

- 探针：`scratchpad/m4-p1-recheck/apps/web/src/shared/outbox/zz-recheck-probes.test.ts`（C1 五条、C2 两条、C5 一条；断言写成"问题存在"，修好之后把断言反过来收进仓库）。
- 撤回：`recheck-p1-logs/reverts-unit.log`、`reverts-browser.log`（每处的日志 `revert-browser-*.log`）、`lint-a7.log`；Linux 的 B1 撤回 `recheck-p1-linux/out/b1-revert-webkit.log`。
- 运行：`recheck-p1-logs/lint.log`、`typecheck.log`、`test.log`、`e2e-outbox-3b.log`、`e2e-crash-cc.log`、`e2e-crash-webkit.log`、`e2e-outbox-stress.log`；Linux `recheck-p1-linux/out/outbox-calib.log`、`crash.log`、`run-all.log`。
- 变异：`recheck-p1-logs/mutations.log`、`mutation-V*.log`。

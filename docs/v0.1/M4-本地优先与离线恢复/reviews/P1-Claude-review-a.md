# M4-P1 本机发件箱：独立审查报告（审查者 A，产品代码的正确性与安全）

- 审查者：claude-opus-5-5（Opus 5.5），没有参与实现，只审查、不修复
- 副本：`scratchpad/m4-p1-review-a`（主仓库的 clone，分支 `m4-p1-outbox`，头 `afae6422`；审查结束时工作区干净，探针与临时改动都已移出）
- 范围：`fc4868ff..afae6422` 里 P1 的产品代码——`apps/web/src/shared/outbox/`、`apps/web/src/features/sheet-editor/outbox/`（不含 `testing/`）、`packages/contracts` 的 `local-drafts` 与 `local-key-format`、服务端保留期下限；合并进来的 main `6702e982` 不在范围
- 先读：P1 设计（尤其 §1、§3、§3.8）、ADR-020、M4 总设计 §2.2 与 §6.1–§6.6、计划书 §7.2–§7.8（r22）、ADR-018、ADR-019
- 做法：逐文件读码；跑现有测试；对可疑处写探针（单元 8 条、浏览器 2 条×三个浏览器）证实；单元层 69 个、浏览器层 21 个变异（规范 §10.5）；用 `node:crypto` 独立核对加密的已知答案；查 lint 的区域规则与门禁

## 一、问题清单

### A1 必须修：按用户清理（退出登录、账户停用）时，镜像目录被占着的那份文档连写入者一起留下——写入栅栏对正在编辑的那一页失效

- **位置**：`apps/web/src/shared/outbox/local-cleanup.ts:78`（`removeUserData(userId, { keepDocumentIds })`）；`draft-store.ts:460-486`（keep 分支三个仓库都留，写入者也留）。
- **问题**：ADR-020"存储"一节、P1 设计 §3.4.7、M4 总设计 §6.3（"同一浏览器里退出登录"一行）都把这条当作 A06 的兜底：**按用户清理时草稿与写入者在一个事务里一起删，之后才到的写入因写入者不在而 `not-writer`**。但合一的清理遇到镜像目录删不掉（busy）时，把这份文档在库里的草稿、写入者与提示都留下。镜像目录 busy 的，正是编辑器页的发件箱 Worker 登记之后一直拿着两个槽位句柄的那份文档——也就是还没停写、最需要被栅栏拦住的那一页。所以在有 OPFS 的浏览器上（生产的 Worker 放置，三个浏览器都是），正在编辑的文档在清理之后照样能写进本机、写进镜像。
- **复现**：
  - 单元探针 PA8（`scratchpad/review-a-tools/zz-review-2.test.ts`，假存储 + 内存 OPFS + 真的镜像与管道）：登记、写 seq 1 → `cleanup.removeUser` 交回 `pending: [KEY]`、写入者还在 → 再写 seq 2 交回 `written`（镜像 `mirrored`），库里是 seq 2。
  - 浏览器探针（`scratchpad/review-a-tools/zz-review-a.spec.ts` 的 PA8，生产的发件箱 Worker、持久上下文）：chromium、chrome、webkit 三个都复现（清理交回 pending，之后的写入 `written`、库里是 seq 2）。
  - 现有用例 `mirror.spec.ts:302` 断言了"句柄开着的那一份库里的也留着"，没核对之后的写入；`cleanup.spec.ts:14` 只经存储的 `removeUserData`（不带 keep）测了栅栏。
- **另**：账户停用时，收到 401 原因的往往就是编辑器页自己（它的心跳、保存）；它的 Worker 拿着这份文档的句柄，直接调合一的清理时这一份必然 pending。
- **建议的修法**：keep 的那几份留草稿与提示（防比对写回），但**不留活着的写入者**：把写入者换成一条"已停用"的记录——保留 `lastDraftSeq`（高水位照样挡住镜像里过时的那一份，`decideRestore` 的 seen），`writerId` 换成任何一次登记都不会产生的值，之后的写入、重封、确认都得到 `not-writer`（Worker 随之 `detach`，句柄放开，下一次清理就删得掉）。补用例：busy 时清理之后的写入被拦下（单元与浏览器层）。ADR-020"OPFS 的冗余"一节"按用户清理时库里那几份也留着"的说法随之写清楚留的是什么。

### A2 建议：服务端代次倒退之后（设计 §3.4.2 明列的情形）以 force 登记、接手并写了新的一份，比对镜像时按"代次优先"把旧一代的那份写回库、换掉写入者

- **位置**：`writer-fence.ts:161-163`（`compareDrafts` 先比代次）、`:180-194`（`decideRestore`：只在库里没有草稿时看高水位）；`draft-writer.ts:254-270`（`bestOf` 同样按代次取最新）；`draft-mirror.ts:289-298`（补写同样按它判断，库里那份永远补不进去）。
- **问题**：代次倒退之后新的一代（例如 3）以 force 登记，高水位继承旧一代（例如 5）的 10，接手写下 seq 11（代次 3）。镜像里另一个槽位还是旧一代的 seq 10（代次 5）。下一次 `read`/`register`/`reconcile` 比对时，`compareDrafts` 认为代次 5 的 seq 10 比库里代次 3 的 seq 11"新"→ `restoreDraft` → `decideRestore` 判 `restore`、写入者 `replace`：**库里新的一份被旧的换掉，写入者换回旧一代，留下"已从备份恢复"的提示**；本页之后的写入得到 `not-writer`。页面这时崩溃，接手之后的修改就丢了。`bestOf` 也交回旧的那一份。
- **复现**：单元探针 PA6（`zz-review.test.ts`）；浏览器探针 PA6（生产 Worker，chromium、chrome、webkit 三个都复现：读回 seq 10/代次 5，库里 seq 10/代次 5，写入者代次 5，提示 restored，之后写 seq 12 被 `not-writer` 拦下）。现有的 `writer-fence.spec.ts:117` 只测了倒退之后能 force 登记，没测之后的写与读。
- **建议的修法**：以库里当前写入者的高水位为准：候选的序号不大于当前写入者的 `lastDraftSeq`、而写入者不是它时，不论库里有没有草稿都算过时（seen / not-newer）——登记时高水位取了 max，当前的写入者登记时一定已经看过它；`bestOf` 与补写的取舍同一个口径。补倒退之后接手、再读的用例。

### A3 建议：本页的密钥比记录旧时归为"已损坏"；取最新时静默退回更旧、解得开的一份

- **位置**：`draft-codec.ts:84-86`（`unsealFailureOf`：记录的版本不小于当前的一律 `corrupted`）；`draft-writer.ts:254-270`（`bestOf`：最新的解不开就往下试，交回第一个解得开的）。
- **问题**：
  1. 记录的 `keyVersion` 比本页手里的大，只可能是本页的密钥过时了（ADR-019：版本连续、只增）。按现在的归类它是 `corrupted`，而 M4 总设计 §6.4 定的是"解不开 → 都删除"。同一浏览器里一个早先取了第 1 版的页面（例如开着的本机草稿页，阅读时没有心跳带版本）去读另一个标签页用第 2 版写下的草稿，就会把一份完好的、没同步的草稿当"已损坏"删掉。
  2. 最新的一份解不开时，`bestOf` 不说明还有更新的，直接交回库或镜像里更旧的一份（`kind: 'draft'`）；P3 可能据此恢复旧内容、P4 据此另存为副本。
- **复现**：单元探针 PA1（v2 写下、v1 去读 → `unreadable/corrupted`，`meta.keyVersion` 是 2）；PA2（库里 seq 6 用 v2、镜像里 seq 5 用 v1，用 v1 读 → 交回 seq 5 的内容 `five`）。
- **建议的修法**：归类加一种（记录的版本比当前的新 → 本页的密钥过时，重取密钥再试，绝不删除）；`bestOf` 在最新的那一份解不开时不往下退，交回最新那一份的归类（或者至少带上"还有更新的、解不开"）。P3、P4 删除之前先重取一次密钥（交接单写明）。

### A4 建议：镜像里另一份文档的记录会被当成这份文档的（键与目录不核对）

- **位置**：`draft-writer.ts:173-177`、`:283-315`（`mirroredRecords`、`reconcileKey` 不核对记录的 `userId`/`documentId` 与要读的键一致）；`mirror-slot.ts:190-205`（`parseSlot` 同样不核对）。
- **问题**：AAD 由记录**自己的**元数据生成，所以同一个人另一份文档的槽位文件被挪进这份文档的目录（本机磁盘被改动）时照样解得开。`read(doc1)` 交回 doc2 的内容（P3 会把它恢复进 doc1）；比对还会把它按它自己的键写回 doc2。ADR-020 的说法是"改动任何一个明文字段，解密都失败"——对"挪到别的键下"这一种不成立。
- **复现**：单元探针 PA3（doc2 的记录放进 doc1 的槽位 → `read(doc1)` 交回 `documentId` 为 doc2、内容为 doc2 的草稿；doc2 的库里多了写回的那一份，doc1 的库里没有）。
- **建议的修法**：读槽位时记录的键与目录的键不一致按 `mismatch` 落选（一行判断）；存储的 `readDraft` 可以同样核对（IndexedDB 的值与键本来一致，只防磁盘被改）。

### A5 建议：保留期清理在库里删掉过期的草稿之后，列镜像的目录出错就整个交回 failed，删了哪几份丢了

- **位置**：`local-cleanup.ts:101-112`。
- **问题**：`store.purgeExpired` 已经提交（草稿删了），之后 `listUsers`/`listDocuments` 出错时直接 `return listingFailed(...)`，`purged.drafts` 被丢掉；再调一次也不会再报（已经删了）。US-M4-12 要求"属于本人的，说明删了哪几份"。
- **复现**：单元探针 PA4（`listUsers` 交回 failed → 结果 `failed`，库里那份过期的草稿已删）。
- **建议的修法**：库那一段成了就交回 `purged` 与 `drafts`，镜像这一段的问题并进 `pending`（或另带一项），不吞掉已经做了的事。

### A6 建议：放弃过的草稿可能从镜像复活（写入者被保留期删掉之后）

- **位置**：`local-cleanup.ts:86-99`（放弃时镜像 pending"不必再调"）；`draft-store.ts:523` 与 `writer-fence.ts:153-155`（写入者的保留期只看库里有没有草稿，不看镜像）；`writer-fence.ts:187-188`（`seen` 靠写入者的高水位）。
- **问题**：本机草稿页放弃一份时，编辑器页的 Worker 拿着这份文档的句柄 → 库里删了、镜像目录 pending，靠写入者的高水位挡住复活。写入者登记满 14 天、库里又没有草稿时被保留期删掉（同一次 `purgeExpired` 就会：它先清库）；镜像目录的槽位不空、改动不满 14 天，留着。下一次比对：库里没有草稿、没有写入者 → `create` → **放弃过的草稿被写回来，并留下"已从备份恢复"**。
- **复现**：单元探针 PA5（登记 → 13 天后写 → 放弃交回 `pending: [KEY]` → 页面关掉 → 第 14 天多 1 毫秒清理：写入者被删、镜像目录留着 → 新的管道读回 `abandoned-by-user`，提示 `restored`）。
- **建议的修法**：保留期不删"镜像目录里还有不空的槽位"的那份文档的写入者（合一的清理把这几份的键交给存储），或者放弃的 pending 与按用户清理一样之后再清；P4 在启动时先比对再清理。

### A7 建议：lint 的区域规则只拦直接引用，"不依赖 DOM"没有规则；P1 里门禁兜不住 Worker

- **位置**：`eslint.config.ts:878-881`（`OUTBOX_ZOD_FREE_PATTERNS`）、`:1121-1141`（两块 Worker 文件的规则）。
- **问题**：
  1. Worker 会用到的文件 `import … from './local-key.ts'`（带 zod 的契约与请求层）lint 通过；`outbox.worker.ts` 引用 `../../../shared/outbox/local-key.ts` 同样通过。注释说"转了一手的引用由门禁 artifacts 的 zod 计数兜底"，但门禁只扫生产构建（`tools/src/gates/run.ts:54` 的 `apps/web/dist`），P1 的生产构建里没有这个 Worker——P1 里没有兜底，P2 才有。
  2. P1 设计 §3.1 写的区域规则是"shared/outbox 里给 Worker 用的文件不许引用 zod 与 DOM"：在这些文件里写 `document.title`、`window.localStorage`、`localStorage` lint 都通过（tsconfig 带 DOM 的类型库，类型检查也过）。
- **复现**：在副本里放探针文件跑 eslint（跑完即删）：`shared/outbox/` 里引用 `./local-key.ts`、`features/sheet-editor/outbox/` 下一个 `*.worker.ts` 引用 `shared/outbox/local-key.ts`、`shared/outbox/` 里写 `document.title` 与 `window.localStorage`，都没有报错（同一批探针里直接引用 zod、`localKeySchema`、`shared/api/` 的都被拦下）。现在测试构建的 `outbox.worker-*.js` 里 zod 的探测 0 处、没有 `window`/`document`/`localStorage`（核对过），所以是规则缺口，不是现有的违规。
- **建议的修法**：Worker 文件的 `patterns` 加上同目录的只在主线程用的文件（`local-key.ts`、`storage-status.ts`、`local-cleanup.ts`）；加 `no-restricted-globals`（`window`、`document`、`localStorage`、`sessionStorage`）；lint 自测各补一条。或者在设计里写明 DOM 这一半改由浏览器层用例兜。

### A8 建议（测试缺口）：槽位是更新的格式时不算写一半——这条判断没有测试

- **位置**：`draft-writer.ts:290`（`slot.reason !== 'newer-format'`）。
- **依据**：变异 A53（把 newer-format 也算 torn）存活，326 条单元全过。改坏之后：库里没有、写入者也没有时，旧页面会把更新的页面写的两个槽位截断并留下 lost。
- **建议**：补一条单元用例（一个槽位 newer-format、另一个空、库里什么都没有 → 不留提示、槽位不动）。

### A9 建议：保留期把"两个槽位都空"的镜像目录当没用的删掉——同步过的文档每次再编辑都要重建目录，碰 OPFS 的目录库不再是"次数少"

- **位置**：`local-cleanup.ts:52-55`（`isUseless`：文件不在、大小为 0，或者超过 14 天没动过）与 `:127-133`；登记时的 `draft-mirror.ts` `attach` → `mirror-directory.ts` `openSlots(key, true)`（找不到才建）。
- **问题**：§3.8 的前提是"平时只改写已有的文件，不碰目录库（Chromium 里同样是复用日志的 LevelDB）；只有用户的数据清理与保留期才删目录——次数少"。但确认之后两个槽位都截断为 0，于是只要文档没在编辑器里开着，下一次保留期清理（M4 总设计 §6.6 定的是平台的任何页面启动时）就删掉它的目录；用户下一次进入编辑，登记又建目录与两个文件。结果是几乎每一次编辑会话开头都写一次 OPFS 的目录库，崩溃时目录库出事的窗口随之变多（出事的后果是这个来源的全部镜像一起没了，冗余恰好在最需要的时候不在）。
- **依据**：读码；现有用例 `mirror.spec.ts:327`"回收两个槽位都空的目录"断言的正是这个行为。
- **建议的修法**：保留期只删"两个槽位都超过 14 天没动过（或者文件不在）"的目录，空而新的留着给下一次编辑复用；按用户清理、放弃照旧。若坚持回收空目录，至少在设计与 ADR 里把"目录库在每次编辑会话开头被写一次"写成已接受的风险。

### A10 记录：槽位格式 v1 里装着更新的记录格式（recordVersion 2）时读成 mismatch，同样算写一半

- **位置**：`mirror-slot.ts:99-118`（`decodeRecord` 经 `readDraftMeta`，格式版本不是 1 就 `undefined`）→ `parseSlot` 的 `mismatch`（`:203`）→ `draft-writer.ts:290` 算 torn。
- **问题**：库这一侧"更新的页面写的不动它"，镜像这一侧却当作写坏：部署回滚并且 Chromium 删过库时，旧页面会留 lost、截断更新的页面写的槽位；库被删、镜像里只剩更新格式的那份时 `read` 交回 `absent`，之后旧页面写镜像会覆盖它。条件很窄（回滚 + 删库），记录；修法是 `decodeRecord` 认出记录的格式版本更新时交回 newer-format。

### A11 记录：读时"取最新"的口径，文档与代码不一致

- ADR-020 第 93 行写"（代次，序号，代号）最新"，P1 设计 §3.8 写"（代次，序号）最大"；代码是 `compareDrafts`（代次、序号、`updatedAt`，`writer-fence.ts:161-163`），代号只用来选写哪个槽位（`draft-mirror.ts` 的 `newestSlot`）。管道让同一份文档的 `updatedAt` 只增不减（`rewrittenAt`），行为没问题；文档对齐即可。

### A12 记录：保留期清理每次读出所有草稿的完整值

- `draft-store.ts:492-506` 用 `openCursor()` 走全部草稿，`cursor.value` 带着几 MiB 的密文，只为看 `updatedAt`。M4 总设计 §6.6 定"平台的任何页面启动时"清理，草稿多、大时会在平台页面上有可感的开销。P4 接入时节流（例如一台设备一天一次），或者以后加 `updatedAt` 的索引（只做加法的升级）。

### A13 记录：`reconcile(userId)` 在一个请求、一个看门狗时限里比对全部文档

- `draft-writer.ts:639-656` 逐份读两个槽位、算 SHA-256、可能写回；客户端每个请求一个时限（`outbox-worker-client.ts:161`），到点整个 Worker 判坏。P2/P3 定时限、决定在哪儿调它时要算进去（或者按文档一个请求）。

### A14 记录：重封、改基准、换密钥的结果里没有镜像的状态

- `reseal`（`draft-writer.ts:384-405`）、`confirm` 的 `rebased`（`:558-562`）、`rekey` 写了镜像但不交回写没写成；设计只要求写入的结果带上。镜像没写成时下一次写入或登记的补写会追上，影响小；P2 的页头说明以写入的结果为准即可。

### A15 记录：取用途中收到心跳的新版本时不记下

- `local-key.ts:149-155`：手里没有密钥（取用在途）时 `observeVersion` 直接返回；那次取用拿回的若是吊销之前的一版，页面要到下一次心跳（约 10 秒）才换。之后的 `setKey` 会重封，影响小；P2 接心跳时可以顺手处理。

### A16 记录：`duplicate` 只认"同一写入者、同一序号"

- `writer-fence.ts:60-61` 不核对内容（也核对不了）。P2 必须保证同一个写入者不对不同的内容重用序号（重试只重发同一次捕获），交接单写明。

### A17 记录：保留期按墙上时间

- 设备时钟曾慢 20 天、校正之后刚写下的草稿在下一次清理时立即被删（单元探针 PA7）；时钟快时永远不过期。写入时刻只能取墙上时间，这是固有的限制，建议写进 ADR-020 与已知限制。

### A18 记录：库被删、还没比对时，镜像里的草稿不在列表与清理的结果里

- `listDrafts`、`draftDocumentIds` 只看库；镜像里过期的那份由比对截断、由保留期删目录，都不进 `purgeExpired` 交回的清单（US-M4-12 的说明漏掉它们）。P4 先比对、再列、再清。

### A19 记录：`draft-writer.ts` 把"比对镜像与库"的策略也放在写入管道里

- `draft-writer.ts`（694 行）里，写入管道的编排（排队、去重、封、交给存储、重封、确认、换密钥）之外，还有比对的整套策略（`reconcileKey` 的写回/补写/lost/截断、`bestOf` 的取舍、`mirrorWrite`/`mirrorBackfill`/`mirrorClear`）。A2、A3、A4、A8 都落在这一段；把它抽成一个注入给管道的"镜像比对"模块（输入库的读出与两个槽位，输出要做的动作），判定能像 `writer-fence.ts` 一样写成纯函数、表驱动地测，管道也小一半。不挡合并，P2 动管道之前做更省事。

## 二、结论

**修复后通过**：A1 修复并补测试之后通过；A2–A9 建议在本 Phase 一并处理（都小，A2、A3、A6 关系到"拿不准不覆盖、不误删"，A9 关系到 OPFS 冗余的前提）；A10–A19 记录，相关的进交接单与延期登记。

## 三、核实过、没有问题的要点

1. **写入栅栏与事务**：判定（`writer-fence.ts` 的纯函数）与写入都在 `[drafts, writers]`（或三个仓库）的同一个读写事务里，读写一律 `durability: 'strict'`；`transact` 的 body 与请求回调全是同步的，没有 await 别的异步；`readCurrent` 依赖同一事务里请求按发出的顺序完成，正确。每条路径都 `finish`；回调抛出时中止事务。连接断（`InvalidStateError`、`UnknownError`）只重开一次，中止的事务什么也没写，重试安全。
2. **序号与高水位**：写入要求是登记的写入者、序号大于高水位，成功时同一事务里抬高；登记交回 max(旧写入者的高水位, 现有草稿的序号)；`removeDraft` 不碰写入者（高水位留着）；只删到已确认的序号（`decideConfirm`），改基准用"同一写入者、同一序号"认定库里就是那一份，否则 `needs-rebase`、管道重做（至多 3 次）。
3. **不覆盖别的写入者**：别的写入者的、认不出的草稿一律 `foreign-draft`，`adoptSeq` 只对认得出、序号相等的那份放行；确认不删别人的草稿；重封比较并交换。
4. **在途的序号不大于草稿序号**：写入管道（`InvalidCapture`）、标记在途（库里更旧时 `absent`）、记录的形状核对（`readDraftMeta`，读与写都过）三层；改基准清掉在途。
5. **保留期**：草稿按读得出的 `updatedAt`（不论格式、不论属于谁），写入者按 `registeredAt` 且没有草稿，恰好 14 天不算、时刻在将来不算；`canReplayAsSent` 不满 14 天；契约 14、服务端下限 15 由常量推出（`config.test.ts` 钉住数值）。
6. **newer-format 与 malformed**：库里的不动、不写回、写入与确认按 `foreign-draft`、清理按读得出的时刻、列表里列出键；只有不带 `expectedSeq` 的放弃能删。
7. **加密**：AAD 的字段表在类型上与 `DraftMeta`、`ContentFormat`、`InFlightSave` 一一对应，单元测试核对没有重复、每一项改动都不同；JSON 数组没有拼接歧义；格式标识在第一项。已知答案测试的期望值我另用 `node:crypto` 的 `aes-256-gcm` 独立算出，逐字节一致。每次封（写入、重封、改基准、换密钥）都取新的随机 IV；补写、写回搬的是同一份密文，不是重新加密。解不开只认 `OperationError`。
8. **密钥与令牌不进持久存储**：记录只有约定的元数据、IV 与密文（读写都经形状核对重建，多余的字段带不进去）；写入者只有代次、`writerId`、高水位、登记时刻；提示只有种类与时刻；产品代码里没有 `localStorage`/`sessionStorage`/`exportKey`/租约令牌。导入的 `CryptoKey` 不可导出、用途只有加密与解密，原始字节在 `finally` 里清零（主线程与 Worker 的原始字节交法都是）。
9. **OPFS 的冗余**：只在 Worker 里用同步访问句柄；只在找不到时才带 `create` 建目录与文件，平时只改写与截断；没有 `createWritable`、改名，删目录只在页面一侧的合一的清理里（测试构建的 Worker 产物里同样核对过）。槽位写入顺序是截断 → 内容 → 头 → flush，头带自己的 SHA-256、内容的长度与 SHA-256，读时整个文件都校验，写一半的落选、另一个槽位不动；写的总是"不是最新"的那个槽位，代号取两个合格槽位的最大值。镜像只在库提交之后写；镜像比库新时写回（写入者与 restored 提示同一个 strict 事务），库比镜像新时由拿着句柄的写入者补写；两个都坏、库里也什么都没有才留 lost 并截断；确认删掉、放弃过的按高水位认出、截断（例外见 A6）。句柄独占，拿不到退避（0.5 秒起翻倍、至多 30 秒），失去写入者身份时放开。
10. **Worker 与客户端**：协议带版本与 id，两边都用手写守卫逐项核对、只交回已知字段；看门狗、`error`（就绪前 load-failed、之后 crashed）、`messageerror`、读不懂的回复、Worker 的通知、`dispose` 都让在途的全部以失败结束、之后立即失败、终止 Worker；`postMessage` 抛出只让那一个请求失败。写入的字节与交回的 gzip 都转移，交回的 gzip 不是管道自己留着的那份。交密钥有关口，导入失败丢掉密钥。100 ms 的空定时器生产里停不掉。测试构建的 `outbox.worker` 产物里没有 zod 的探测、没有 `window`/`document`/存储的引用（gzip 约 12 KB）。
11. **跨边界不抛异常**：存储、管道、镜像、清理、密钥保管者、Worker 的客户端与处理，结果都带 `kind`；写满不论出现在 put 上还是提交时都经 `tx.error` 归为 `quota`（去掉这一归类的浏览器层变异 B03 被 Chromium 系经 CDP 的写满用例杀死）；不可用的四种原因（没有 IndexedDB 或 `crypto.subtle`、打不开、`VersionError`、等升级超时）都有。
12. **lint 与首屏**：平台页面对 `shared/outbox/` 的静态引用（含 `import type`、再导出）与按需引用 `draft-index.ts` 之外的文件都被拦下，`import('…/draft-index.ts')` 放行；sheet-editor 里静态引用 `testing/` 被拦下；Worker 文件直接引用 zod、带 zod 的契约名、请求层被拦下（缺口见 A7）。生产构建的门禁 artifacts、budgets 通过，平台页面首屏 175.8 / 180 KiB 不变，生产构建里没有发件箱的产物。
13. **服务端与契约**：`LOCAL_DRAFT_RETENTION_DAYS` 不引用 zod，`local-key-format.ts` 抽出之后 `localKeySchema` 照旧；修订记录保留期下限 = 14 + 1。

## 四、跑过的测试与变异

- `pnpm lint` 通过；`pnpm typecheck` 通过；`pnpm test`：356 个文件 7201 条全过；发件箱两个目录的单元 17 个文件 326 条全过。
- 浏览器层 `specs/outbox`（测试构建，chromium、chrome、webkit）：135 条通过、3 条跳过（WebKit 上没有 CDP：两条写满、一条授予持久保存，用例自己写明由真实 Safari 的复核补），49 秒。
- 门禁：生产构建之后 `pnpm gate artifacts budgets` 通过。
- 探针（不提交，在 `scratchpad/review-a-tools/`）：`zz-review.test.ts`（PA1–PA7）、`zz-review-2.test.ts`（PA8）全部按"问题存在"的断言通过；`zz-review-a.spec.ts`（PA6、PA8）三个浏览器 6 条通过。
- 变异（脚本 `review-a-tools/mutate_unit.py`、`mutate_browser.py`，每个改完即还原，结束时 `git status` 干净；日志 `scratchpad/review-a-mutations-unit.log`、`review-a-mutations-browser.log`）：
  - 单元层 69 个（写入栅栏与写回的判定、记录的核对、编解码的归类、管道的比对/补写/截断/镜像的放开、槽位的格式与选槽、合一的清理、本机密钥、协议、客户端、处理）：杀死 64，存活 5——A31（写一半之后不清槽位的记录）、A41（还有 pending 也删用户目录）、A52（库与镜像相等时也调补写，补写自己会判断）三个等价；A53 是测试缺口（见 A8）；A58（写回被拒的任何原因都截断镜像）只在比对的只读一段与写回事务之间被别的标签页插进来时才不同，记录。
  - 浏览器层 21 个（`draft-store.ts`：不抬高水位、不要求 strict、写满不归类、被取代也写写入者、改基准不核对、放弃不删提示、按用户清理不留 keep、清理写入者不看草稿、写回不留提示、丢失不看写入者、断线不重开、确认/放弃顺带删写入者、列表不按用户、提示的保留期；`database.ts`：不让开 versionchange、列表的标记建库、VersionError 不归类；`draft-index.ts` 不按用户；`mirror-directory.ts` 的 WebKit busy）：全部杀死。
- 实现者报告里已有的变异清单没有照搬重跑；上面的变异挑的是那些清单之外、或者审查中起疑的几处（与它们有少量重叠）。

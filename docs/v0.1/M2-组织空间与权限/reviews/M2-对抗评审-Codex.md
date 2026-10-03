审查者：Codex（GPT-6；会话未提供更细的模型型号，三个审查子代理继承同一模型）｜日期：2026-10-03｜审查范围：`v0.1-m1..3c2863cdf0da6d16929864c3dec504cfa97524a1`｜结论：**不通过**

## 1. 结论摘要

开工与结束前核对的分支均为 `m2-p5-sharing`，HEAD 与指定的 `3c2863cdf0da6d16929864c3dec504cfa97524a1` 一致。实际比较为 147 个提交、733 个文件，新增 101480 行、删除 3097 行；没有因为任务描述中的约数差异改变范围。审查目录仅为 `/Users/xiaoruan/project/nerve-office/.claude/worktrees/m2-p5-sharing`。

本次记录 **7 项问题：阻断 1、重要 2、一般 4、建议 0**。不建议现在合并并打 `v0.1-m2`：

- **CX1（阻断）**：授权检查和实际返回数据不在共同数据库快照里。已用真实 HTTP 与 PostgreSQL 确认：撤销单独分享、移出空间之后才保存的新正文，以及移出之后才新建的文档，会被撤权前开始的读取带出。不是只返回撤权前已经有权读取的旧内容。
- **CX2（重要）**：历史密码哈希参数的初次扫描失败被吞掉后，认证仍继续。不存在账户与旧参数账户执行不同的计算组，ADR-007 的失败登录一致性在这个故障窗口不成立。
- **CX3（重要）**：DEF-039 以 US-M2-10 未提复制为理由延期，但 US-M2-08 明确承诺“能读源文档、目标能新建即可复制”。仅授权用户没有任何产品 UI 路径完成该故事；接口可用不能替代故事验收。
- 另外确认了成功写入后刷新卡住确认框、分享列表刷新失败被旧缓存掩盖、文件夹重试身份依赖可变字段、CI 分片等价性自检漏检真实参数四项问题。

已有改进有实际正向证据：`pnpm verify --fast` 通过（219 文件、3432 项单元/前端单元测试）；专用数据库上的主批集成测试 37 文件、3259 项通过，另有认证 7 文件、118 项通过；选定 M2 E2E **417 项通过**（Chromium、Chrome、WebKit 各 139 项，0 跳过、0 重试后才过）；生产构建与 deps/licenses/artifacts/budgets 门禁通过。新探针的“通过”表示断言了当前缺陷特征，不能并入产品安全验收的通过数。

没有运行完整 `pnpm verify`、全量集成/覆盖率、容器 E2E、远程 CI、Edge 或真实 Safari；没有执行外部依赖审计、洪水、压测、端口扫描。**既有登录锁定夹具的来源头模拟被误纳入一次批跑，见 §3 的执行偏差**。不能把本次描述成完全遵守了“不做来源头模拟”的约束。

## 2. 检查项（逐项对应审查报告模板）

下表的“已检查”表示实施了审查，不表示该项无问题。此任务只评审，不修复；不把修复、修复后的变异验证或回归入库勾为完成。

| 模板检查项 | 本次做了什么及结论 |
|---|---|
| 正确性与边界条件 | 核对账户/令牌、有效权限、分享、空间树、复制/移动/删除/清理、请求标识和前端写后状态；用真实 HTTP/数据库固定并发与故障时序。发现 CX1、CX2、CX4–CX6。 |
| 模块边界、依赖方向与 SOLID | 读 `admin`、`workspace`、`spaces`、`documents`、`auth/users` 的编排关系和公开入口；lint 通过。稳态权限规则集中、系统管理与内容权限分离合理；CX1 表明跨模块查询虽然没有越界联表，却缺少共同读取快照的抽象。不能用模块边界为分时授权辩护。 |
| 测试是否充分：单元、集成、E2E 覆盖本 Phase 的用户故事 | 跑过的数量见 §9。复核矩阵世界、预期独立性、正向前提、响应与 SQL 对照、页面错误夹具。已有测试有价值，但遗漏在途读取/参数发现故障/可变对象重放/写成功后刷新，且 CX3 的 UI 缺口没有故事 E2E；CX7 证实一个前提失效的变异存活。 |
| 安全：鉴权、输入校验、敏感信息 | 核对角色取高后归档降级、仅授权者的结构限制、系统管理员例外、撤权、新请求拒绝、令牌摘要/消费/关联会话撤销、审计不含标题；发现 CX1、CX2。没有给出外部攻击脚本，也没有扩展上游安全细节。 |
| 性能与资源使用 | 核对 Argon2 队列/限流、SQL 有界查询与数组参数、空间树锁顺序、后台清理的不重叠/退避/连接释放、审计明细上限；构建体积门禁通过。没有压测，不能独立认可 DEF-026/029/030 的容量假设。CX2 的两个计时样本仅作观察，不作负载或统计结论。 |
| 文档：架构总览、ADR、交接单已更新 | 阅读 CLAUDE、计划书、工程规范、M2 总设计、P1–P6 设计、ADR-007/013–016、架构总览、延期登记及相关旧审查/交接。文档已更新，但存在 CX3 的跨故事冲突，及 §7 中若干结论范围过宽。 |
| 每条修复都有变异验证（临时改坏 → 跑对应的测试 → 还原），变异里包括“测试的前提失效”一类；存活的变异作为缺口列出 | 本次没有修复，故“每条修复”不适用。对 CI 工作流读取值做内存变异，整份接线自检 7/7 仍过，记为 CX7；未改生产源码。新增缺陷探针不是修复后变异证据，也没有重做历史所有修复的变异。 |
| 修复里引入的全局约定或新机制：逐个接口核对过；新机制另请一位复验者只看这一批 | 本次按认证、权限、树/数据库/工程分三个子片，主审另看前端并合并交叉发现；未引入新机制。历史读取机制和写后刷新规则尚有漏口，不能代替未来修复后的逐入口独立复验。 |
| 复验者写的、能复现问题的用例已移进仓库作为回归用例 | **未完成且本任务不执行**：用户明确要求只写报告。探针副本保留在 `/tmp/codex-m2/`，仓库临时测试已删除；报告给出不依赖临时文件的重建要点，主会话修复时须转为正式回归。 |

## 3. 证据口径与复现环境

### 3.1 证据分级

- **已实测**：明确区分真实 Nest HTTP＋PostgreSQL、真实浏览器＋HTTP＋数据库、React/jsdom 状态机、隔离工具探针。故障或时序由测试控制时说明控制点，不把 mock 响应说成服务端实测。
- **静态确认**：路径均相对上述 worktree，行号对应 HEAD；同根因其他入口未跑探针的单独标明。
- **推测**：本问题表没有仅凭推测计入的条目。自然网络/调度下出现的频率、真实 Safari 的恢复行为、生产规模性能等没有确认，放入覆盖限制。
- “测试通过”与“承诺成立”分开。既有验收的通过是正向证据；专门断言缺陷现象的通过表示问题可复现。没有修复，故没有修复后绿色回归或“修复后通过”的结论。

### 3.2 隔离与配置

所有 shell 命令都以前缀 `PATH=/Users/xiaoruan/.nvm/versions/node/v24.21.0/bin:$PATH` 运行。使用现有依赖、现有本机浏览器和已有 `postgres:18.6-alpine` 镜像，未安装依赖、未访问远程仓库或外部网络。

专用容器 `codex-m2-review-pg`，ID `1e89653266c2da78169e44bb92e4006e24d68c19546eff86164efa6ace5a87e0`，`--pull=never`，映射 `127.0.0.1:62295`；初始数据库 `codex_m2`、用户 `codex`，内置 `C.UTF-8` locale。测试连接：

```text
NERVE_TEST_DATABASE_URL=postgres://codex:codex_m2_only@127.0.0.1:62295/codex_m2
E2E_DATABASE_URL=postgres://codex:codex_m2_only@127.0.0.1:62295/codex_e2e_review
```

此口令仅属于现已销毁的审查容器。没有访问共享开发库 54318。集成测试配置 `/tmp/codex-m2/vitest.config.mts` 导入仓库原配置，只向 integration project 加载前转换：对于 `/tests/integration/` 下 `.ts` 源码，把 `nerve_it_` 替换为 `codex_it_`，使模板与测试库都用审查前缀；其余项目和生命周期原样。没有改仓库的数据库 helper。模板锁、迁移及 invariant sweep 仍由项目工具执行。

E2E 临时配置导入原 `tests/e2e/playwright.config.ts`，只设绝对 testDir、webServer.cwd 与 `/tmp` 输出位置、list/JSON 报告器。三种本机浏览器沿用原配置，worker 数为 3。真实应用自行建库/迁移/起服，E2E 结束收到 SIGTERM 后退出并删除 `codex_e2e_review`。

最终只剩 `codex_m2` 和 `codex_it_tpl_c5b384a74b68` 的容器被 `docker rm -fv codex-m2-review-pg` 整体删除；单独按名称检查容器及匿名卷 `c8f877dd88cbf7d48edc46473db1e4140af42e0ec85a2e783e7698cdb148eba5` 均无结果。未清理别人的容器、卷或库。原始日志和探针副本在 `/tmp/codex-m2/`，它们不是报告成立的唯一依据。

### 3.3 必须披露的执行偏差

认证子片首次批跑前未检查 `tests/integration/src/auth/login-lockout.test.ts` 的来源头夹具。该文件有 17 个 `it`，其中部分用 RFC 5737 测试地址的 `X-Forwarded-For` 向本机临时应用模拟来源，已随 118 项基线执行。用户明确禁止这类演练；这是审查执行失误，不是获得了例外授权。发现后已告知用户并停止这类用例；后续新增安全探针没有模拟来源头。只涉及本机隔离 HTTP 应用与专用数据库，没有访问真实外部来源、共享库或远程服务，也没有洪水/压测。此处如实保留，不能由后续清理抵消。

## 4. 问题清单

“处理”与“复验证据”留给主会话填写。

| 编号 | 等级 | 位置 | 问题 | 证据等级 | 处理 | 复验证据 |
|---|---|---|---|---|---|---|
| CX1 | 阻断 | `apps/api/src/modules/documents/document-content.service.ts:44`；`document-search.service.ts:52` | 授权与读取分属不同快照，在途请求返回撤权后才产生的新正文/文档 | 已实测（真实 HTTP＋PG）；扩展入口静态确认 | | |
| CX2 | 重要 | `apps/api/src/modules/users/users.service.ts:313`；`password-hasher.ts:97` | 初次哈希参数发现失败后继续认证，旧参数账户与不存在账户计算组不同 | 已实测（隔离计算组探针＋真实 HTTP/PG 故障注入） | | |
| CX3 | 重要 | `apps/web/src/features/shared-with-me/shared-page.tsx:22`；`docs/v0.1/02-延期事项登记.md:54` | 仅授权用户无复制/改名 UI；DEF-039 的理由与 US-M2-08 的复制验收冲突 | 静态确认 | | |
| CX4 | 一般 | `apps/web/src/features/sharing/share-dialog.tsx:323`；`features/confirmation/confirm-dialog.tsx:125` | 已收到写成功响应，仍无限期等待刷新才能结束确认；取消/Esc 无效 | 已实测（React＋Query＋Radix/jsdom，响应桩） | | |
| CX5 | 一般 | `apps/web/src/features/sharing/share-dialog.tsx:338` | 有旧缓存时刷新错误不显示，撤销成功后仍展示原授权，且无失败/重试提示 | 已实测（React/jsdom，响应桩） | | |
| CX6 | 一般 | `apps/api/src/modules/documents/folders.service.ts:314` | 文件夹幂等重放比较当前名字/位置，改名后原请求冲突、不同原始载荷反而被当重放 | 已实测（真实 HTTP＋PG） | | |
| CX7 | 一般 | `tools/src/verify/ci-workflow.test.ts:76` | CI 等价性测试丢弃真实 fast 参数；会漏集成/覆盖率及产物门禁的变异仍全绿 | 已实测（隔离工具、内存变异） | | |

## 5. 逐条详情

### CX1：授权事实与输出数据没有共同快照

**现象与影响。** 已有 viewer 在请求中途失去单独授权或空间成员身份，旧请求仍返回撤权后才保存的 revision 2。搜索同样返回移出空间后才创建、而新发直接 GET 已是 404 的文档。权限与新数据从未同时成立；这是无权信息披露，不能以“请求开始时有权”解释为正常旧版本读取。影响 A03、US-M2-06/10/12/14。没有证明自然调度中窗口出现的概率，但真实数据库时序已确认。

**根因及位置。**

- `apps/api/src/modules/documents/document-content.service.ts:44–49` 先取元数据并 `requireAccess`，然后另查正文。`document-contents.repository.ts:57–62` 只按 documentId 取当前正文，保证 snapshot/revision 相互一致，却未保证它们与授权一致。
- `document-search.service.ts:52–67` 先取 `visibleSpaces`，下一条 SQL 把旧空间 ID 集合当作读取范围；`documents.repository.ts:139–144,168–174,197–207` 的空间半边信任该数组。单独授权半边在结果 SQL 中用 EXISTS，这部分较好；随后 `accessViaOf` 再用旧 Set 检查，无法发现撤权。
- 查询是多条 autocommit 语句，不在共同快照中。仓储跨模块分开，不等于必须分开读取快照。

**防御性回归实验，真实 HTTP＋PG，无浏览器。** 准备拥有者与查看者，分别覆盖个人文档 grant viewer、团队空间 viewer。先证实可读 200。在 `DocumentContentsRepository.findCurrent` 的一次调用起点加入可恢复 Promise 闸门，已走完生产授权检查但尚未发正文 SQL；放行后仍调用原仓储方法。另一客户端经真实 API 撤销 grant/成员关系，断言 204，并用一个新请求自证读同文档为 404；拥有者通过保存 API 写入此前不存在的无害 marker，断言 200，再释放原读取。搜索用例在 `DocumentsRepository.searchByTitle` 起点暂停，先断言输入 scope 含团队空间；移出后创建新文档 201，查看者直接新 GET 为 404，再释放搜索。没有 mock 数据库；未修改生产源码，测试临时包装方法加入闸门，放行后调用原实现；没有用无效假数据绕开授权前提。

实际输出：

```json
{"probe":"grant","revoked":204,"saved":200,"read":200,"etag":"\"2\"","newContent":true}
{"probe":"membership","revoked":204,"saved":200,"read":200,"etag":"\"2\"","newContent":true}
{"probe":"search","removed":204,"created":201,"read":200,"returnedNewDocument":true}
```

3/3 缺陷特征探针通过，首次 1.80 秒、记录响应后复跑 1.20 秒。正确回归可接受同一旧快照内的数据或拒绝请求，但不能接受撤权后才出现的新数据。以上形状足以在项目测试 helper 中重建，无须依赖临时文件。

**同机制入口的静态核对（没有冒称实测）。**

| 入口 | HEAD 位置（均在 `apps/api/src/modules/` 下） | 判断 |
|---|---|---|
| 按空间列文档 | `documents/documents.service.ts:28–42` | 先 requireSpaceContent，后按旧 spaceId 范围查询，具有同形窗口。 |
| 列文件夹 | `documents/folders.service.ts:67–74` | 授权后另取父目录/子目录，目录可来自更新的快照。 |
| 回收站 | `documents/trash.service.ts:81–94` | 授权、删除单元、计数、父路径多次查询；除撤权窗口外，响应内部也未必同一时刻。 |
| 授权列表 | `documents/document-grants.service.ts:54–56` | 先验证 canShare，再查询当前 grants；权限降级后的新授权关系可进入旧请求。 |
| 成员列表 | `workspace/space-membership.service.ts:34–41` | 先 viewMembers，后读成员；敏感点是空间成员关系/角色，而非同事目录本来公开的人名。 |
| 文档详情 | `documents/documents.service.ts:47–49`；`document-access-policy.ts:102–105` | 元数据与权限事实分时读取，方向不同，不能直接声称已证明上述新正文泄漏；应覆盖移动与角色变更交错。 |
| 与我共享 | `documents/shared-documents.service.ts:39–46`；`documents.repository.ts:182–188` | 集合、标题与授权角色同 SQL，未发现搜索的陈旧空间 ID 放大；后续空间事实仍分查询，应纳入共同快照复验。没有另计一个已实测泄漏。 |
| 空间导航/页头 | `workspace/space-directory.service.ts:25–31` | 数据与角色判定来自同一查询对象，未发现本项同形问题。 |

**为什么既有测试没发现。** `tests/integration/src/permissions/revocation-timing.test.ts:103–189` 验证撤权提交后的下一次新请求；并发断言集中于保存和复制。矩阵固定角色，hidden/missing 比较两个失败路径，都不会自然产生“旧授权＋新数据”的成功响应。P6-S2 已对复制的同类源授权/快照错时问题作修复，不能由此推定直接读取也安全。

**建议方向。** 为跨仓储的授权读取提供短、统一的只读快照边界，例如显式 REPEATABLE READ 事务，或在受控查询层同一 SQL 返回数据与所需权限事实；把 transaction/snapshot 传到正文、visibleSpaces、搜索、目录等实际查询。仅套现有默认 READ COMMITTED 的 `TransactionRunner.run` 仍每条 SQL 换快照，而且还会写 commit ledger，不能直接当成只读快照机制。逐响应补一条末尾权限检查也不是通用解法。此项属于 A03 信息边界，不应混入 M3 的租约/在途保存互斥延期。

### CX2：参数发现失败后仍继续密码验证

**触发边界。** 数据库有旧 Argon2 参数账户，进程尚未成功发现完整参数集合，初次 DISTINCT 扫描发生可恢复 SQL 取消/超时/连接故障，但后续按用户名读凭据成功。此时已有旧账户会自学自己的组，不存在账户只能用目前已知的组。没有证明外部可稳定触发该数据库故障，也不是宣称正常运行的所有登录可枚举。

**根因及位置。** `apps/api/src/modules/users/users.service.ts:313–322` 吞掉参数读取失败、清空缓存 Promise、记警告，然后 resolve；`:91–101` 继续验证。`users.repository.ts:256` 的参数扫描与用户名查询独立；`password-hasher.ts:97–108` 从已有哈希学习组，`:112–116` 的 reject 仅按已知组计算，集合见 `:145–146`。因此“进程可以带数据库故障启动”被扩大成“缺少必要认证前提也可以继续密码验证”。外层 `auth.service.ts:145` 的繁忙退还机制拿不到已经被吃掉的错误。

**实测一：隔离服务/计算组探针。** 使用真实 UsersService、Argon2PasswordHasher，仓储参数查询注入 SQLSTATE 57014；底层哈希运行时只记录调用组，不实际做重计算。当前参数 `m=19456,t=2,p=1`，旧账户 `m=12288,t=3,p=1`。错误密码按“不存在→旧账户→不存在”执行，输出：

```text
不存在（首次）: [hash:m=19456,t=2,p=1]
旧参数账户:     [hash:m=19456,t=2,p=1, verify:m=12288,t=3,p=1]
不存在（之后）: [hash:m=19456,t=2,p=1, hash:m=12288,t=3,p=1]
```

这证明计算组差异，不依赖计时噪声。

**实测二：真实 HTTP＋PG、真实 Argon2，无浏览器。** 两个独立冷启动测试应用，库内均有 256 MiB/2 次旧参数账户，应用当前参数为 19 MiB/2 次。取消前先确认首条登录已进入 verifyCredentials，正在等待同一尚未完成的参数扫描 Promise；随后由测试管理连接只取消本测试应用的这次扫描，并释放测试锁，使后续凭据查询正常继续。若扫描失败后才新发登录，会触发新扫描，不能重建本次窗口。不存在/旧账户各一次错误登录，共两条请求，不模拟来源头。结果：

| 输入类别 | 响应 | CPU | 墙上耗时 | 参数发现警告 |
|---|---|---|---|---|
| 不存在账户 | 401 INVALID_CREDENTIALS | 24.686 ms | 27.193 ms | 有 |
| 旧参数账户 | 401 INVALID_CREDENTIALS | 180.663 ms | 190.046 ms | 有 |

仅两个样本，不能据此给出统计可辨识率；确定的计算组差异才是主证据。真实实验是验证故障回退的回归测试形状，不是外部触发步骤。

**逻辑链断点。** `users.service.test.ts:212–221` 明确期望参数读不出来时“这次验证照常”，使用 FakeHasher，未检查组合后的成本一致；`tests/integration/src/auth/login-timing.test.ts:142` 的冷启动情形让参数扫描正常成功。两个局部测试不能证明 ADR-007 的故障分支承诺。

**建议方向。** 将后台初始化容错与密码验证必须具备完整组集合分开。在首次完整发现成功前，不能把扫描失败视作可继续验证；数据库繁忙沿用 503 和名额退还，之后重试。补“集合加载失败时不进入不完整验证、恢复后首次不存在/旧账户工作组一致”的测试，并改变原来“失败照常”的错误期望。正常加载的多组陪算改进仍有效；这不是 DEF-037 已登记的组集合不收缩这一性能代价。

### CX3：仅授权用户的复制故事没有 UI 路径

**证据等级：静态确认。** `apps/web/src/features/shared-with-me/shared-page.tsx:22–38` 与 `features/search/search-page.tsx:25–42` 都只有打开文档的链接，没有行操作；`features/sheet-editor/editor-chrome.tsx:184–198` 页头只有返回、标题、分享及保存/只读状态。原改名/复制入口在空间文档列表，而只凭授权的人无权进入该列表。后端 `documents/access-rules.ts` 按有效内容角色允许编辑者改名、所有能读的人复制，没有对应 UI 消费该能力。

**上层冲突。** `docs/v0.1/M2-组织空间与权限/00-M2-总设计.md:57,80`，特别是 US-M2-08，没有“必须属于源空间”的限制；P5 设计也明确仅授权者可复制。DEF-039（`docs/v0.1/02-延期事项登记.md:54`）却只用“US-M2-10 的验收不含这两项”作为延期到 M3 的理由。审查 P5 B8/G3 时按单个 Phase/故事收窄范围，漏掉整个 M2 的 US08。

**可重建的验收检查。** 给普通成员一份其他个人/团队空间文档的单独 viewer 授权，不加入源空间；成员拥有自己的个人空间。核对“与我共享”→编辑器及搜索结果：既没有复制操作，也不能去源空间列表操作。editor grant 还缺改名入口。这里没有新增真实浏览器复现，结论依据上述完整渲染链和延期登记自身的明确描述；既有三浏览器故事通过不覆盖这个缺失路径。

**影响与方向。** 至少复制是已承诺的核心用户能力，不是小文案问题。补授予 viewer/editor 的可用复制入口、目标选择与成功反馈，且不能暴露源目录；编辑者改名按现有权限提供。增加仅授权者从 UI 复制到个人空间、源/副本编辑独立且 grants 不随副本的 E2E。若确需延期，须由需求方明确调整 US08/上层范围并同步验收，不能只登记一个仅讨论 US10 的理由。本次不替需求方批准范围变更。

### CX4：写入已成功，确认框却被后续刷新锁住

**位置。** `apps/web/src/features/sharing/share-dialog.tsx:43–48,323–327`：DELETE 已完成后 `await refresh.afterSuccess(true)`，之后才返回成功通知回调。`shared/lib/refresh-queries.ts:21–23` 等待 invalidateQueries，没有时限；`shared/api/client.ts:96–107` 的 fetch 也未在此设截止时间。`features/confirmation/confirm-dialog.tsx:125–153` 在整个 run 完成前维持 confirmingRef，拒绝关闭。

**已实测：React＋TanStack Query＋Radix/jsdom，无服务端或真实浏览器。** 渲染真实 ShareDialog，先让 GET 授权列表返回 Ben/viewer；确认取消，DELETE 返回 204；把随后 GET 的 Promise 保持 pending 11 秒（超过共用失败刷新路径的 10 秒恢复时限），尝试“取消”和 Esc。确认框仍在，按钮为“正在处理…”且 `aria-disabled=true`，成功通知尚未出现。随后让 GET 返回空列表 200，确认框立即关闭。该差分把原因定位在成功后的 GET，而不是 DELETE 未知或状态机未发请求。

探针初版关闭查询自动重试；最终追加使用项目 `QUERY_CLIENT_DEFAULTS` 的复核，避免把测试专用 QueryClient 设定当产品行为。请求保持 pending 时也不存在可以启动的重试。

**影响。** 后端已经取消授权，但用户无法退出该确认流程；只有后续读取结束、页面被关闭/重载等才能离开。代码没有应用层等待上限，不等于宣称浏览器网络栈永不超时。确认框注释 `:102–103` 的“标记不会一直留着”缺少 run 会结束的前提。已有未知结果恢复机制只覆盖 onError，不覆盖这个成功分支。

**建议方向。** 将确定的写入结果与视图刷新分开；成功时应能结束确认/恢复焦点/播报结果，刷新有明确进行中、失败和重试状态。如果必须等刷新，也应有有界等待；不能将已确认成功误报成写入失败或未知。对所有 await 写后刷新的确认调用者核对，但本次实测仅对分享取消成立，未逐页声称同症状。

### CX5：分享列表有缓存时的刷新错误被吞掉

**位置与根因。** `apps/web/src/features/sharing/share-dialog.tsx:338–373` 处理 pending、403/404、以及 `data === undefined`，却没有处理“data 仍有值、refetch 已失败”的一般错误分支。TanStack Query 保留旧数据，`afterSuccess` 又设置 `throwOnError:false`，最终直接渲染旧 Grants。`:32` 和 `refresh-queries.ts:8` 声称“刷新失败时列表自己显示加载失败”，此处未兑现。

**已实测：同一 React/jsdom 探针，响应桩。** 初始列表为 Ben/viewer，DELETE 204，随后列表 GET 500 INTERNAL_ERROR。确认框关闭，状态区显示“已取消分享给 @ben 本”，但 Ben 的原授权及“取消分享”按钮仍在，`queryByRole('alert') === null`，没有失败或重试入口。最终复核使用生产 QUERY_CLIENT_DEFAULTS，让首次刷新及一次自动重试都返回 500，并断言总共三次列表 GET（初次成功＋两次失败）；现象相同。没有以这个 mock 场景证明实际数据库删除成功；此处验证的是客户端在确定 204 之后的表现，后端取消链另有真实基线/E2E。

**影响与方向。** 用户看到成功说明和旧授权同时存在，无法识别数据已过时；新增/调角色也可能被旧数据显示掩盖。已获确定成功时按结果移除/更新对应缓存，同时明确显示仍未刷新的状态；保留数据的 refetch error 也需显式提示/重试。与 CX4 分开计：此项发生在刷新已经以错误结束后，单加超时不会修复它。

### CX6：文件夹请求标识比较的是当前状态

**根因与承诺。** `apps/api/src/modules/documents/folders.service.ts:90–92,314–326` 用原创建人的 id 以及当前 spaceId/parentId/name 判断重放；`apps/api/src/db/schema/documents/index.ts:52–66` 中的文件夹定义只有 requestId（第 64 行），没有不可变创建载荷摘要。改名/移动会改变请求身份。`:317` 假设“重试只发生在几秒之内”，但网络结果未知可以持续更久，同事也能在几秒内整理对象。工程规范 `docs/v0.1/01-工程规范与完成定义.md:115` 和 P4 §3.2 承诺相同请求返回原结果。

**已实测：真实 HTTP＋PG，无浏览器。** 使用有效账户个人空间，经正常 API：

1. 以固定 UUID requestId 新建文件夹“待整理”，201，记住 id。
2. 改名“已整理”，200。
3. 原样重发步骤 1 的 body：**409 REQUEST_ID_CONFLICT**，消息“请求标识已被另一个请求使用”。
4. 保留该 requestId，只把 body.name 改成“已整理”：**201、原 id、replayed=true**，即不同原始载荷反而被当成原请求。
5. 文档创建的对照：创建“待整理”→改名“已整理”→原样重发创建请求，**201、原文档 id、replayed=true**。

1 个扩展探针包含上述两方向及对照，1.09 秒通过。没有模拟真实断网，证明的是服务端同原载荷重放的确定错误。

**影响与方向。** 原样安全重试不能可靠确认之前的创建；前端 `shared/api/request-ids.ts:76–79` 遇到冲突释放标识，可能让用户重开一次创建。界面已有“上一次可能已创建”的提示，故不夸大为静默数据丢失或“同一标识创建了两次”。像文档新建/复制一样保存不可变请求摘要，重放按原载荷核对，再独立复核当前访问权；补改名、同空间移动、跨空间移动后原样重试及不同载荷反例。

### CX7：CI 分片自检验证的是重造的参数

**位置与现状。** `tools/src/verify/ci-workflow.test.ts:76–86` 解析 workflow 真实命令，却只保留 id/scope；比较计划时重建固定 `{fast:false,ci:true,audit:false}`。`tools/src/verify/plan.ts:98–101` 在 scope 前判断 fast，实际带 `--fast` 的命令不会执行完整 no-e2e 分片。当前 HEAD 的 `.github/workflows/ci.yml` **没有**这个错误参数；本条不是说当前 CI 已漏跑，而是它宣称守住的等价性缺少保护。

**已实测：隔离工具/内存变异，无 HTTP、数据库或远程 CI。** 临时 Vite pre-transform 只把自检中 `readText(WORKFLOW)` 的返回值替换为：在 `run: pnpm verify --ci --keep-going --scope=no-e2e` 里额外加入 `--fast`。原仓库 YAML 和生产代码未修改。运行真实 ci-workflow.test.ts，单独等价性用例通过；再运行整份文件，**7/7 通过，1.18 秒**。

同时以真实 `parseArgs`、`planSteps` 计算变异后命令：解析成功，fast=true，与正常 e2e 分片合并的实际步骤为 `lint,typecheck,unit,static-gates,audit,clean,build,build-e2e,e2e`；相对完整计划缺少 **tests（集成测试与覆盖率）和 artifact-gates（deps/licenses/artifacts/budgets）**。不是靠文字猜测漏项。

**建议方向。** 比较实际解析出的全部 options，必要时明确禁止 CI 分片 fast；保留此类改变前提的负向测试。检查目标应是工作流真实命令执行什么，而不是 scope 名称会对应什么。没有执行任何删减后的远程流水线。

## 6. 逻辑链核对

### 6.1 M2 总设计 §8 退出条件

| 退出条件 | 本次证据与结论 |
|---|---|
| US-M2-01 至 US-M2-14 全部通过；本机三个浏览器、CI 四个浏览器 | **不能认定满足**。本机选定 139 个用例×3 全过，但不等于验收项无遗漏；CX1、CX3–CX6 涉及故事缺口。未读取/执行远程 CI 的四浏览器结果。逐故事见下表。 |
| A03、A10、A14 完成验证；§5.3 矩阵全过 | 所选集成批包含现有全部 permissions 文件、矩阵与 hidden/missing 对照且通过；**A03 被 CX1 否定，A14 仍有 CX3–CX5**。A10 已有快照复制/独立保存的正向证据，但仅授权 UI 端到端链路未实现。 |
| pnpm verify 与 CI 全绿；容器 E2E 通过 | **本次未完整证明**。fast、选定集成/E2E、构建及本地静态/产物门禁过；未跑 full verify、覆盖率、在线 audit、远程 CI、容器 E2E。不能把这些拼成原样全套已过。另有 CX7 的防回归缺口。 |
| Phase 报告与交接齐全；合并前对抗评审已处理；延期登记复核 | P1–P5 交接、各 Phase 审查及 P6 六片/总结存在并已阅读相关结论；**本报告 7 项尚待处理**，DEF-039 有异议。没有替主会话填处理结果。 |
| 架构总览与 ADR 已更新 | 文件存在并包含 M2 设计；更新动作有证据，**保证的完整性仍须修正**：读取快照与哈希参数发现故障不能沿用现有“已保证”表述。 |
| 00 号计划书已按 r7 更新 | 已有后续修订（至 r12），组织/空间、只读提前、系统管理员被显式分享等已回写；动作成立。CX3 的延期与上层复制承诺仍未协调。 |
| 打 tag v0.1-m2 | 本次未执行标签操作；当前审查结论不支持据此打标签。 |

### 6.2 US-M2-01–14 验收逐条

“有证据”限于此次静态核对和实际选择的用例，不是所有未来并发/浏览器状态的证明。

| 故事 | 已核对的验收链及正向证据 | 剩余缺口/判定 |
|---|---|---|
| US-M2-01 邀请 | 摘要存储、7 天到期、撤销/重发/一次消费、用户名争用、同事务建账户/个人空间/审计、公开页面显示范围与限流；invitations/account-races 集成及 accounts/admin E2E 通过。 | 未发现新增令牌缺陷。到期事务边界另见 §8；未做洪水试验。 |
| US-M2-02 改密码 | 旧密码/强度、凭据版本锁下复核、当前会话换令牌、其余会话撤销、失效会话回滚、审计；change-password/account-races 与浏览器链通过。 | 正常链有证据；CX2 是共用验证前提的故障缺口，不能外推认证层整体无问题。 |
| US-M2-03 重置 | 签发即撤销会话并使旧密码无效、24 小时、一次消费、重发与撤销、目标停用、审计、成功后登录；集成和浏览器链通过。 | 未发现新增缺陷；没有把到期前进入事务的锁等待误判成到期后可新发请求。 |
| US-M2-04 系统账户管理/转移 | 停用即时使新请求未登录、启用不复活旧会话/链接、至少一个有效管理员、撤销签发给他人的待用链接；转移仅列标题、受限目的地、审计与并发复核；admin/users、transfer 及管理 E2E 通过。 | 所覆盖路径有证据；没有生产规模转移性能验证。 |
| US-M2-05 团队空间 | 系统管理员管理面与内容权限分离，全员可见例外、归档降级、恢复、加入空间记审计；空间/内容矩阵与三浏览器 E2E 通过。 | 稳态规则未见新增错误；归档/角色交错读快照应随 CX1 复验。 |
| US-M2-06 成员与角色 | 添加/角色调整/移出、同事身份呈现、保留 grants、锁下复核、审计；移出后的下一次新请求被拒已有实测。 | **在途新数据泄漏 CX1**，不能无保留说撤权链完整。 |
| US-M2-07 整理文档 | 导航、新建到有权空间、多级/10 层上限、改名、空间内/跨空间移动、只按空间角色决定结构操作；矩阵、树锁测试及文档 E2E 通过。 | **CX6 重试身份错误**；仅授权 editor 改名 UI 受 CX3 影响；列表/目录多快照问题见 CX1 静态面。 |
| US-M2-08 复制 | 后端读源＋目标可创建、锁下源/目标复核、快照/unitId 原样、副本独立保存、授权不复制；copy/copy-locks 与复制浏览器链通过。 | **CX3：仅授权 viewer/editor 没有 UI 路径**。现有 UI 故事覆盖不能证明所有被承诺角色均完成。 |
| US-M2-09 回收站 | 删除单元包含子树、编辑者所有权、恢复原位置、权限/永久删除、active 不可永久删、查询排除 trashed、30 天数据库时钟清理；trash/结构锁/jobs 集成及 E2E 通过。 | 清理到期用受控数据时间验证，未等真实 30 天或长运行；回收站读取快照见 CX1 静态面。 |
| US-M2-10 分享 | 选同事、设置/调整/取消、取高/归档冻结、仅授权者不获结构/分享权、“与我共享”空间名且无目录、同事务审计；sharing 与矩阵/E2E 通过。 | **CX1、CX4、CX5**；仅正常响应和无缓存初始失败状态不足以验收。 |
| US-M2-11 只读 | 选定整个 read-only E2E 目录、access 用例，真实三浏览器覆盖编辑入口、快捷键、撤销/重做、选择复制与公式 Worker；服务器拒绝 viewer/归档保存的矩阵通过。 | 未发现新增可持久化写入绕过；DEF-027/028/035 仍是明确局限，不能写成绝对没有任何可见无效入口/内存变化；没跑真实 Safari。 |
| US-M2-12 标题搜索 | 稳态空间/授权范围、回收站排除、大小写/LIKE 转义、路径按 accessVia 隐藏；search/矩阵/E2E 通过。 | **CX1 的搜索探针直接反例**：出现用户从未获权的新文档。 |
| US-M2-13 审计 | 时间/操作者/动作/对象筛选、分页、仅系统管理员、业务同事务记录、标题/正文不入明细、明细计数有界；admin/audit 与管理 E2E 通过。 | 所覆盖行为有证据；不是全生产规模审计库的容量验证。 |
| US-M2-14 越权/存在性 | 矩阵预期没有直接调用生产权限函数；世界含未授权文档、子目录、归档/全员可见；授权存在前提自证；hidden/missing 对照响应与规范化实际 SQL 序列；猜地址与三类撤权浏览器链通过。 | **A03 仍被 CX1 否定**。批准的 SQL 序列口径只能证明被比较路径，不能保证成功响应使用一致快照，也不是物理耗时严格相等的证明。CX2 是 ADR-007 的另一认证边界缺口。 |

## 7. 对旧审查、交接与延期登记的异议

1. **P6-S2 与 P5 的防泄漏结论范围过宽。** P6-S2 已修复制源授权/内容时序，报告 `reviews/P6-S2-权限核心与防泄漏.md:14,64,74` 的处理不覆盖直接正文/搜索。P5 报告中的“2666 格”“108 个探测”是明确的稳态及失败路径集合；本次重跑这些所属文件通过，仍不能支持所有读请求的无权信息不出现。CX1 不是已批准的 M3 在途保存/租约延期。
2. **ADR-007 的容错描述与恒定失败计算量不能同时无条件成立。** 文档已写到参数读不出来记警告、下次再读，说明实现并非误漏；欠缺的是在未知集合状态禁止继续认证。DEF-037 的“只影响代价，不影响失败耗时不暴露账户”不能覆盖 CX2。组集合收缩/运维可观测本身可以按原登记留给 M7，正确性故障不应混入。
3. **P5 B8/G3、DEF-039 延期论证没有跨故事核对。** `reviews/P5-审查报告.md:61` 所接受的仅授权者无复制/改名 UI，至少违反 US08 的原验收；“US10 不含”不是 M2 可延期的充分依据。应修复或取得上层范围调整，见 CX3。
4. **P6-S5 的写后状态结论遗漏成功分支和保留缓存的失败。** 10 秒未知结果刷新恢复解决了 onError 等待，并不保证 await 成功后刷新的 run 有界；分享界面的“刷新失败会显示错误”注释在有缓存时不成立，见 CX4/CX5。读屏状态区被正确放置也不能使尚未执行/错误的成功回调自动正确。
5. **P6-S3 的重放验证不是所有幂等条件的证明。** “8 条重放探针与 §7.4 一致”验证了权限变化等场景，却没覆盖创建对象的可变字段；现有 request-ids 测试可过而 CX6 仍存在。
6. **P6-S6/P4 交接的 CI 等价性保护需收窄。** 当前 YAML 的 scope 配置正确，有实际静态证据；测试却重造其他 options，CX7 的整文件存活变异说明它没验证真实命令的完整计划。不是指控远程 CI 当前已经漏跑。
7. **其余延期不凭猜测升级。** DEF-026/029/030 的容量与索引问题属于明确 M7 压测事项，本次没有新性能证据推翻；DEF-027/028 的无效只读入口、DEF-035 上游直接内存尺寸调整仍属已记录局限，未确认新增可保存绕过。DEF-038 应保持“真实 Safari 未复核”的未决状态：本次 WebKit 用例通过不能把新开页面的恢复等同于用户在原页重试成功，也不足以把所有浏览器恢复故障判为生产已确认。

## 8. 覆盖说明与排除项

### 8.1 已核对、未发现新增问题

- 一次性链接仅存摘要；签发、撤销、一次消费与账户/个人空间/审计事务边界；停用及取消系统管理员时，签发者关联的未用链接被撤销；凭据版本和会话旋转的事务内复核。
- 有效内容权限由空间角色与 grants 取高，再按归档降级；结构权限只来自空间；系统角色不直接取得内容；全员可见、显式分享的系统管理员例外按已确认 r12 实现。grant-only 不带 folderId/路径，个人空间名称按所有者身份呈现。
- 分享写入的账户→空间→文档锁顺序、锁下空间归属与权限复核；DELETE 可撤销停用者的授权；相同角色幂等不额外记审计。未发现与复制/移动的新增锁环。
- 树 advisory lock、跨空间整棵子树含 trashed 子孙、删除单元不拆散、active 不可永久删除；复制源空间/源文档共享锁及目标空间复核。未发现新的死锁或结构越权反例，不等于形式化证明所有交错。
- 提交结果 ledger 与响应事务内组装、busy-after-commit 实测；没有确认“写已提交却因随后拼响应繁忙返回失败”的新入口。
- 清理器与手动永久删除共享主体，文档先于文件夹删除、内容/版本/grants 级联；计数有界且审计不含标题，ID 数组走已有批量约定；定时器不重叠、失败退避、连接释放。schema-parity 和带历史数据迁移通过。
- 人名组件的登录名与隔离显示名、确认关后通知/焦点、公共未知结果说明、请求标识保留的主要机制，相关单元和三浏览器已有故事通过；局部例外已列 CX4–CX6。
- 页面错误夹具从 BrowserContext 的 weberror 收集，各用例自动断言；两个浏览器通知排除采用限定文本和同源判断，另有单元接线/分类测试。没发现本次可以确认的放宽吞错新问题；没有声称真实浏览器任意错误变体全部验证。

### 8.2 有意排除的候选

- **令牌到期跨锁等待。** 真实 HTTP/PG 探针中，把自己的邀请到期时间设为约 +1 秒；接受请求在到期前已进入事务并等行锁，过 1.2 秒确认当前时钟已过期后放锁，响应 200，accepted=true、expired_now=true、accepted_at<expires_at。ADR-013 明确用事务 `now()`，这是请求已经进入事务时尚有效的语义；未证明到期后才发起的请求能接受，因此不列漏洞。
- **跨账户重置与旧 Cookie 的会话行锁环。** 推演后发现前提不成立：签发重置先使密码失效并撤销目标全部会话，完成前目标不能用旧密码取得有效会话。没有人为植入违反系统不变量的数据后宣称产品死锁。
- **相同 SQL 序列就是绝对耗时相同。** 本次按需求方已确认的验收口径执行，认可已有对照的范围；没有重新声称缓存/计划/行数等运行时因素导致的墙上时间必然相同，也没有另造未实测的计时漏洞。

### 8.3 明确未覆盖

未逐行读完十万新增行；风险优先审查不能证明不存在其他问题。未跑远程 CI、Edge、真实 Safari、容器 E2E、全套 E2E/restart/CSP/部署故事、全部集成与覆盖率汇总、在线依赖安全审计、生产备份恢复、100 人负载、真实 30 天清理运行、真实读屏软件或全部移动设备。构建 E2E 产物含项目既有测试探针，不等于对生产二进制所有浏览器路径做过人工验收；生产构建另跑了门禁。没有评估 M3 及后续尚未实现的功能。

前端 CX4/CX5 是真实组件、响应桩与 jsdom，未进一步复现在真实浏览器/真实后端组合中；CX3 只有静态链路核对。安全 CX1/CX2 已有真实 HTTP/数据库复核，但不是自然概率、规模、远程可触发性试验。独立审查子片是同一次 Codex 评审的分工，不把三个同模型子代理包装成三种模型的独立交叉验证。

## 9. 实际执行台账

以下命令均在指定 worktree，均有前述 PATH 前缀。集成命令均带 §3 的 NERVE_TEST_DATABASE_URL；E2E 另带 E2E_DATABASE_URL。时间取 `/usr/bin/time -p` 的 real 或 Vitest 报告墙上 duration，已标明；测试并行累计 tests 时间不当总耗时。只读 `pwd/git/rg/cat/nl/sed` 按任务批次执行，没有把源码行数或工具调用算成测试数。

### 9.1 正向基线

| 命令 | 结果 | 耗时 | 日志（`/tmp/codex-m2/` 下） |
|---|---|---|---|
| `git rev-parse HEAD`、`git branch --show-current`、`git status --short`；`git diff --shortstat v0.1-m1..HEAD`、`git rev-list --count v0.1-m1..HEAD` | 初始干净、指定 HEAD/分支；147 提交、733 文件；结束只新增本报告 | 各不足 0.1 s | 结果写入报告头和 §1 |
| `pnpm verify --fast` | lint、typecheck、unit、pins/config/stories/migrations/schema 全过；219 文件、3432 tests | real 111.37 s；各步 38.9/5.8/43.6/22.9 s | `verify-fast.log` |
| `pnpm --filter '@nerve-office/api...' run build` | 通过 | real 6.43 s | `build-api.log` |
| `pnpm exec vitest run --config /tmp/codex-m2/vitest.config.mts --project integration tests/integration/src/permissions tests/integration/src/documents tests/integration/src/jobs tests/integration/src/spaces tests/integration/src/admin/audit.test.ts tests/integration/src/admin/transfer.test.ts tests/integration/src/database/migrations-with-data.test.ts tests/integration/src/database/schema-parity.test.ts tests/integration/src/api/busy-after-commit.test.ts --exclude '**/codex-*' --maxWorkers=4` | 37 文件、3259 tests 通过 | Vitest 32.82 s；real 33.05 s | `integration-baseline.log` |
| 同上 Vitest 配置，选 `auth/{invitations,password-resets,account-races,change-password,login-lockout,throttle-when-busy}.test.ts`、`admin/users.test.ts` | 7 文件、118 tests 通过；包含 §3.3 的执行偏差 | Vitest 8.53 s | `auth-baseline.log` |
| 同配置，选 `documents/{folders,trash,structure-locks,copy-locks,request-ids,organizing}.test.ts`、`admin/transfer.test.ts`、`jobs/trash-purge.test.ts`、`api/busy-after-commit.test.ts`、`database/{migrations-with-data,schema-parity}.test.ts` | 子片 11 文件、216 tests 通过；**全部与主批重叠，不再计新增覆盖** | Vitest 11.19 s | `concurrency/baseline.log` |
| 同配置 `--project unit apps/api/src/modules/users/password-hasher.test.ts apps/api/src/modules/users/users.service.test.ts -t '失败的验证\|UsersService.verifyCredentials'` | 2 文件、22 通过、14 被筛选排除；属于已跑单元基线子集 | Vitest 0.525 s | `auth/hasher-baseline.log` |
| `pnpm --filter @nerve-office/web run build:e2e` | 通过 | real 2.34 s | `build-web-e2e.log` |
| `pnpm --filter @nerve-office/e2e run test accounts admin documents spaces editor/read-only editor/access.spec.ts security/unauthorized-access.spec.ts --config /tmp/codex-m2/playwright.config.mts --workers=3` | 139 个所选用例×3 浏览器＝417 passed；0 skipped、0 unexpected、0 flaky | real 468.52 s（报告 7.8 min） | `e2e-baseline.log`、`e2e-results.json` |
| `pnpm build` | 生产构建通过 | real 2.96 s | `build-production.log` |
| `pnpm gate deps licenses artifacts budgets` | 四门禁通过 | real 2.98 s | `artifact-gates.log` |

stories 门禁列出 25 个 active 故事、7570 个可执行测试，这只是发现/对照数量，**不是本次全部执行数**。migration 门禁基准 `290ad191d3545dffb01cb5789314bc22f9f66115` 为 20 个迁移，当前 21 个。产物门禁检查 320 个生产依赖安装实例、916 个包、175 文件中的 172 个；平台首屏 172.0/180 KiB、编辑器 2020.6/2350 KiB、公式 Worker 677.4/800 KiB（gzip）。未在本机安装的 12 个平台专属包仍待 CI 检查，不能用许可门禁本机通过覆盖它们。

### 9.2 新增探针及工具变异

下列临时测试只为加载仓库配置短暂放在对应源码/测试目录，运行后立即删除；副本和证据留在 `/tmp/codex-m2/`。没有修改既有生产文件、测试或工作流。

| 命令/实验 | 结果 | 耗时 | 日志/副本 |
|---|---|---|---|
| 同集成配置运行 `tests/integration/src/permissions/codex-read-consistency.test.ts` | 3/3 缺陷特征成立；加响应落盘后同三例复跑，不重复计数 | 1.80 s；1.20 s | `permissions/read-probe*.log`、`read-probe-results.jsonl`、`codex-read-consistency.test.ts` |
| 同配置 `--project unit apps/api/src/modules/users/codex-hash-load.test.ts` | 1/1，确定不同计算组，CX2 | 0.537 s | `auth/hash-load.log`、`hash-load-result.json` |
| 同配置运行 `tests/integration/src/auth/codex-hash-startup-http.test.ts` | 1/1，两个冷启动应用各一条 HTTP 登录，CX2 | 1.96 s | `auth/hash-startup-http.log`、`hash-startup-http-result.json` |
| 同配置运行 `tests/integration/src/auth/codex-auth-boundaries.test.ts` | 1/1，到期跨锁等待，按 ADR-013 排除问题 | 2.90 s | `auth/boundaries.log`、对应测试副本 |
| 同配置运行 `tests/integration/src/documents/codex-folder-replay.test.ts` | 初版含文档对照，1/1；增加不同载荷方向并落盘响应后 1/1，CX6 | 1.10 s；1.09 s | `concurrency/folder-replay*.log`、`probe-results.jsonl` |
| `pnpm exec vitest run --project unit-web apps/web/src/features/sharing/codex-success-refresh.test.tsx` | 初次跑通版 2/2，CX4/CX5；再改用生产 QUERY_CLIENT_DEFAULTS 并核对重试次数复核 | 初版通过 Vitest 11.89 s、real 12.12 s；生产默认值复核 2/2 通过，Vitest 12.87 s、real 13.10 s | `frontend/probe.log`、`frontend/probe-production-defaults.log`、对应测试副本 |
| `pnpm exec vitest run --config /tmp/codex-m2/concurrency/ci-fast.config.mts --project unit tools/src/verify/ci-workflow.test.ts --testNamePattern 'verify 与 e2e 两个 job'` | 内存加 --fast 仍 1 通过、6 未选中，CX7 | 0.140 s | `concurrency/ci-fast-probe.log` |
| 同上一命令去掉 testNamePattern | 内存变异后整文件 7/7 通过 | 1.18 s | `concurrency/ci-fast-full-probe.log`、`ci-fast-transformed.test.txt` |
| `node --input-type=module` 调用真实 parseArgs/planSteps 比较实际步骤 | 解析成功、缺 tests 与 artifact-gates | 不足 0.1 s | `concurrency/ci-fast-plan.json` |

### 9.3 未成功的探针准备与收尾

- 首次 E2E 命令把多个 `--project` 与用例选择参数排列不当，Playwright 将目录词当成项目名，约 0.32 秒退出，未执行用例；改为原配置默认本机三个浏览器后得到上表 417 通过。此失败不是产品缺陷。
- 前端探针先两例因确认框名称定位不准失败（约 2.82 秒），修正后第二次 1 过/1 失败（约 12.86 秒，成功通知被人名组件拆成多个节点，原 getByText 不适用）；改用状态区文本断言后 2/2 通过。没有改被测组件来迎合探针。最终又核对生产查询重试设置，见上表。
- 若干只读路径定位得到“文件不存在”，以 `rg --files` 定位真实文件后继续；未把这些命令计作验证通过。
- 专用数据库/container 的创建与 ready 检查、测试退出/库清理及 `docker rm -fv`；删除后仅按自己的精确容器/卷名查询均为空。最终检查 HEAD 不变、分支不变，临时 codex 测试无残留，Git 状态仅本报告。未提交、未切分支、未 stash/reset，未改主目录。

## 10. 交付与复验要求

只交付本报告，不实施修复。主会话处理 CX1 时请以统一读取保证核对所有静态列出的入口，不能只修三个探针；CX2 须连同错误既有单测一起调整；CX3 需补实际故事路径或明确修订范围；CX4/CX5 要分别覆盖 pending 与保留缓存的失败；CX6 要校验不可变创建载荷；CX7 要让前提失效的变异真正变红。

修复后的处理与证据请写回 §4 留空列，并将安全探针转换为正式回归，再完成总设计 §8 尚未由本次证明的全套/容器/CI 条件。当前结论为不通过，不能将本次大量既有测试通过等同于已经满足合并与标签条件。

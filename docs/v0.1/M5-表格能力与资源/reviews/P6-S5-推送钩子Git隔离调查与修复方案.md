# P6-S5 推送钩子 Git 隔离调查与修复方案

2026-11-02 建立，2026-11-03 更新。状态：已按用户批准完成四入口 Git 隔离与定向 RED/GREEN，补丁独立复核 C/I/M=0/0/0；完整资源复验 full02 的 442 项中有 2 failures/1 error，尚不能推送。新断点与有界接续建议见[本机句柄查询与失败留档调查](P6-S5-本机句柄查询与失败留档调查.md)。已有 P6 提前推送和云端预验收授权保留，不重复请求发布授权，也不将旧失败改成通过。

## 发生了什么

用户批准云端预验收后，先完成精确 P6 工作流身份补正：相关 103 项、完整资源机制 437 项通过，三轮临时目录已清理，增量独审 C/I/M=0/0/0；正常提交为 `77325db7e55f454dd09d04ee6917152456ab0f96`。

随后从唯一 P6 worktree 执行受管的正常 `git push`，保留 pre-push 的 `pnpm verify --fast`，未绕过钩子。lint、类型检查通过；600 个单元测试文件中 599 个通过，12,005 项中 12,002 通过、3 项失败。失败均位于 `tools/src/gates/migrations-gate.test.ts`。静态门禁因前项失败未执行。**推送退出 1，远端不存在 P6 分支，云端 CI 没有启动。** 不将这轮标为通过，也不自动重跑同一 SHA。

该测试原本在临时目录创建小 Git 仓库，却把提交、分支切换和配置写到了项目 Git 元数据中。不是产品迁移文件被修改，也不是服务器/数据库故障，但实际误写了开发仓库，属于必须停止的新高风险发现。

## 根因与影响证据

`migrations-gate.test.ts` 的 `git()` 只指定 `cwd`，未隔离继承的 Git 仓库环境；其 init/config/add/commit/switch 因而不能保证目标是临时仓库。`migrations-gate.ts` 的 `gitIn(root)` 同样只指定 `cwd`，读取基准也可能误读外层仓库。Git 官方明确要求钩子访问其他仓库时先清除仓库相关环境，单独改变工作目录不足以隔离。[Git hooks 文档](https://git-scm.com/docs/githooks)

本次没有采集钩子的全量环境；具体归属链由实际 reflog、树、配置及源代码共同核对。原 P6 ref 从 `77325db7` 被夹具的“中文文件名”提交推进至 `d8583710`，再由“第一个迁移”推进至 `a3579569`；后者树只有三个夹具文件。测试随后创建 `feature` 并将 P6 worktree 的 HEAD 切到该分支，专属 index 缩成 577 字节。共享配置变成 `core.bare=true`、`user.name=gate`、`user.email=gate@example.com`、`commit.gpgsign=false`，导致主目录 `git status` 一度报告 bare。**主目录 HEAD 和 main ref 始终仍是 `main@82c3c266`。**

同类潜在入口还包括 `tools/test-resources/test_linux_browser_evidence.py` 的临时 Git 操作，以及 `linux_browser_evidence.py` 的指定源码根读取；前者在正常独立资源回归时没有继承钩子环境，不能用此前通过证明其在钩子环境中安全。未将这一潜在入口写成本轮已执行的误写来源。

独立源码调查将这一未修复的共同根因定为 **C/I/M=1/0/0**；它不是四个独立问题。没有发现第三套实际临时 Git 写入夹具。调查/方案文档的事实复核与缺陷修复后的验收另行记录，不能用文档通过关闭这项 Critical。

## 已完成的保全和恢复

原件在主目录 `.codex/handoffs/m5-p6-20261102/s5/central-acceptance/prepush-git-isolation-incident01/`：

- `index.json` 与 `git-metadata/`：29 个 Git 元数据文件，合计 1,087,846 字节；包含共享 config、HEAD/index、相关 refs/reflog 与 worktree 元数据，受限保存。
- `fixture-objects.pack`：1,187 字节，保存两次误提交的新增对象；原源码历史仍完整可达。
- `source-and-remote01.json`：按预登记提交逐个核对 Git blob 与文件模式，P6 的 4,775 个已跟踪文件及 main 的 4,735 个已跟踪文件均零差异；远端仅有原 `main@884591c8`，没有 P6 ref。
- `prepush-resource-run.json`：受管失败轮 `36d06a9e-ef60-4769-b6ad-cfcea9d11118` 的原回执及有界输出尾。完整终端输出未另存为完整日志，不把输出尾冒称完整原始日志。
- `recovery-intent01.json` / `recovery-result01.json`：恢复动作先落盘，再逐项核验。

恢复只处理已证明由夹具误写的 Git 状态：将 bare 恢复 false，移除夹具留下的局部身份/签名配置；有效作者已核对与事前正常提交及全局配置一致。P6 ref 使用原误写值作比较后恢复至 `77325db7`，worktree HEAD 指回原 P6 分支，只重建 index，没有 checkout/reset 或写入工作文件。仅删除 reflog 明确从全零创建、且仍指向本次夹具提交的 `feature` ref；其对象及记录已先保存。

恢复后两个工作区干净，main 与原 P6 SHA 正确。事前完整 config 原字节没有快照，因此配置恢复是依据已知状态重建有效设置，**不宣称 config 字节与事故前完全相同**。三条门禁失败保持；本轮进程退出、producerQuiescent=true、cleanupStage=complete，真实 scratch/短目录已回收。恢复不构成测试隔离缺陷已修复。

## 建议修复范围

1. 在“指定另一仓库”的 Git 调用边界建立明确环境隔离：仅对新建/读取临时仓库或指定源码根的子进程，移除 Git 声明的仓库局部变量（`git rev-parse --local-env-vars`）。保留进程 PATH 等正常继承，不全局改写 `process.env`/`os.environ`，不关闭正常 hooks，不通过修改全局 Git 配置掩盖问题。
2. 同步覆盖 TypeScript 临时迁移仓库及其 `gitIn(root)` 读取；Python 证据夹具及指定源码根读取采用同等边界。初始化前和写操作前验证解析出的 Git 根/目录归属；不允许外层项目目录被当成测试仓库。共享命令函数的非 Git 调用保持原行为。
3. 用受管 KiB 夹具建立“外层仓库/关联 worktree + 内层测试仓库”，注入指向**夹具外层**的 Git 环境，先证明旧实现失败，再验证修正。不得用真实项目 `.git` 作复现靶点。核对父 HEAD、refs、index、配置及工作文件在整个子测试前后不变；内层原迁移断言、中文路径及源码快照断言仍成立。
4. 反例覆盖 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE`、对象目录、前缀和配置注入相关变量；检查不修改父环境、不污染其他并发夹具。补真正的本地临时远端/pre-push 调用链，证明真实钩子环境下仍能安全跑这些小测试。临时仓库、远端和 worktree 全部归属本轮 scratch 并清理。
5. 相关定向回归、资源机制回归、lint/typecheck 和独立审查通过后正常中文提交。新的干净 SHA 经正常 pre-push 快速门禁推送，前后核对 real main/P6 refs、工作树和 Git 设置；固定 SHA、迁移基线及发布意图重新登记。然后沿已批准方案手动触发原六项 CI，保持原失败、重试和清理要求。

这只修复开发与测试工具中的仓库归属，不改产品迁移、数据库、浏览器断言、CI 触发器或既有门禁范围。重型检查继续串行，本机浏览器长测仍暂停。

## 决策边界

用户已批准上述局部 Git 隔离修复和小型验证，再接续已批准的云端预验收。此前停止依据 CLAUDE 的“意料之外的高风险发现”先保存提交、再等用户决策；实际发生了开发仓库元数据误写，超出一般测试断言失败。无需用户准备环境、密码或手动执行命令。

## 本次实施与验证结果

四入口均已改为显式根归属和子进程环境隔离：TypeScript 的迁移夹具/读取助手共用 `tools/src/shared/git-directory.ts`；Python 的 Linux 证据夹具/读取助手共用 `tools/test-resources/git_repository.py`。新建仓库禁用模板复制并核对不存在旧 `.git`，读取/写入前核对真实工作树根；只清除子进程的 Git 仓库局部变量及配置键值项，正常 PATH、TMPDIR 和受管变量保持，不改父环境、全局 Git 设置或真实项目 hooks。

受管 `test_git_repository_isolation.py` 覆盖真实 linked worktree pre-push、原迁移 7 项与原证据 20 项、9 类环境组合的双语言读取、父环境及父仓库保护、错误根/重复初始化拒绝。旧实现 RED 在受管假父仓库复现误写；修正后通过。新增夹具最初使用逐例清理，独审发现超时后可能仍有孙进程；已通过一个明确失败反例修正为外层运行器独占删除，创建前验证实际运行归属。最终五项定向通过，子进程闭合后外层实际回收；未用真实项目 `.git` 作攻击或复现目标。

| 检查 | 实际结果 | 受管 runId |
|---|---|---|
| Git 隔离旧实现 RED | 预期失败，真实项目元数据前后不变 | `7575617b-35be-4927-aa54-1d42da65c6c0` |
| 四入口修正及根保护 | 4 项通过 | `a6b28494-d6c0-4a6e-8fea-ac3ed468dfce` |
| 首轮完整资源回归 | 当时 441 项通过 | `c4ca2de6-35a4-4229-9f97-3ec1e09088fb` |
| tools 类型检查、三文件 lint | 均退出 0；之后 TS 未变 | `01730276-b488-4fac-ad03-9607869fc36e`、`c2eea0e0-2e93-4322-8de6-0c52734f623d` |
| 超时保全 RED | 1 项按预期失败：writer 存活时回执被删除 | `236d3d99-4592-4584-be61-ceed01538384` |
| 最终 Git 隔离定向 | 5 项通过，含真实 hook 和超时保全 | `d1f29d36-9e80-476e-ace9-17005c1cbfd8` |
| 最后完整资源回归 full02 | **442 项，2 failures/1 error；不能称通过** | `1a928162-8dda-4b83-9b13-7ef970761500` |

Git 补丁独审最初 0/1/0 的夹具超时清理项已经限定复核关闭，最终 **0/0/0**；这不覆盖新发现的旧资源夹具问题。full02 五项 Git 回归没有失败，但两条旧用例因 lsof 不完整记录拒绝，另有一条旧用例因缺少 cleanupStage 报错。外层 `producerQuiescent=true`、`cleanupStage=complete`，外层 scratch/短根消失；另有三个内层短根未闭合，详见新的调查，不能用外层结果宣称全部清理。

主目录仍为 `main@82c3c266`，共享 config 摘要仍为恢复后的 `1a078ac0b17bc9f7d98b4a91ca387a7a8f037db12b921794e08dcbea3d4e7f85`。代码、原回执、日志与复核索引保存在 `.codex/handoffs/m5-p6-20261102/s5/central-acceptance/git-isolation-fix/`；尚未执行新 SHA 推送或云端调度。停止后未再运行完整回归，也未恢复浏览器或 Docker 负载。

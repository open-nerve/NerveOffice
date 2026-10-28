# P4-S6 托管 CI 回收责任实施计划

> 执行方式：按 executing-plans / test-driven-development 逐项实施，模块可并行编辑，小型测试与重型门禁均由负责人串行调度；只使用现有 P4 worktree。

**目标：** 实施用户于2026-10-28明确批准的方案B，解除一次性托管VM的全宿主引用阻断，同时保持本机严格回收和完整测试标准。
**架构：** 将测试结果与资源处置分开。新增纯辅助模块负责托管身份/预算和稳定报告快照；现有Run继续负责登记、锁、进程、路径归属及发布。未知引用不授权删除。
**技术：** Python3.9标准库、现有TypeScript/Vitest与GitHub Actions。
**设计：** [已批准方案B](../reviews/P4-S6-CI清理边界复核与调整建议.md)；原审批前文本保留为历史，执行以本文批准记录为准。

## 全局约束与接口

- R主目录保持main18892db5；W为原codex/m5-p4-history-gc，起点63cccb69。中文正常提交；P4关闭前不开始P5。
- 显式策略变量 `NERVE_TEST_RESOURCE_POLICY=github-hosted-vm`；默认严格，不自动启用。固定GitHub-hosted/Linux/Ubuntu24.04、当前workspace/repo/run/attempt/job/SHA、runner名与boot ID绑定。环境约定不称密码学宿主证明。
- run.json在scratch创建前保存`hostedScope`。已有run不能补签；持锁重新核对磁盘台账、根inode、短目录/别名身份。hosted策略不再依赖PostgreSQL服务namespace豁免，严格旧路径继续保留。
- `status=passed|failed|interrupted`保留测试结果；`cleanupStage=host-disposal-pending`只表达资源待宿主回收，显式`cleanupComplete=false`。任何失败、中断、未退出写入者、报告无效或预算触发不得变绿。
- hosted模块：`context(repo)->dict|None`、`register(context,run_id,roots)->dict`、`validate(proof,context,run_id,roots)->None`、`measure(roots,limit_bytes=16GiB)->dict`、`check_budget(repo,roots,limit_bytes=16GiB,reserve_bytes=12GiB)->dict`。不导入lifecycle。所有阈值生产调用使用固定默认值，小测试可传KiB值。
- stable_reports模块：`snapshot_reports(scratch,destination,run_id,failed_profiles,command_log=None,report_limit=5GiB)->dict`和`verify_snapshot(root,run_id,receipt=None)->dict`。无lifecycle依赖。调用者先证明租约/身份/本轮生产者退出，无已知本轮引用。
- 导出树保留test-results/playwright-report布局；`test-results/stable-export.json`为版本1清单，含runId、complete、rawDisposition、entries（相对导出根path/bytes/sha256）、diagnosticBytes/省略项。返回`{manifest,sha256,files,bytes,complete}`。清单自己及后续resource-run/cleanup-receipt标记不进入自身hash，允许元数据路径须固定。验证须重算实际内容，拒绝未列入的任意额外文件或链接。
- 实施细化：Run先登记并创建reports父根，稳定快照独占子目录为`reports/portable`；`snapshot-owner.json`位于test-results内，随发布和artifact一起携带。manifest记录有效空目录；快照最多100,000个文件/目录/省略项（含自身两项元数据），manifest最多16MiB，复制前预估并在完成时复核。
- 覆盖率仅在hosted integration由运行器指定`NERVE_TEST_COVERAGE_DIR=<本轮output>/coverage`，其他运行清除旧继承值、本机仍用原coverage路径。verify上传精确portable/test-results，checker必须核验coverage-summary的total及非空HTML，不能拿空资源报告代替覆盖率。
- 运输归档由固定`pack_ci_profiles.py`在已登记reports根下创建独占`transport/`，先登记计划和inode再启动压缩，保持原stable manifest不变。只压缩已验证的便携profile子树；流式写入受剩余5GiB报告额度/12GiB余量约束，严格tar成员、类型、大小和hash与原清单对应。运输收据绑定runId、原manifest摘要及archive摘要/成员/预算；E2E既有artifact增加精确transport路径，不新增artifact、不回退原环境。创建/恢复不覆盖未知transport，失败只移除明确属于本次的partial。无profile以显式空运输收据表示，不创建假tar。最终checker重新核验并保存运输绑定；采样值不做循环哈希自引用，最终写入后的预算另行再核并输出到job日志。
- 原scratch/profile不移动、不删；保留owner、有效OPFS、指定报告；失败诊断4MiB/文件、16MiB/用例、64MiB/轮，普通报告5GiB。完整环境不上传、不缓存。
- 16GiB为观察到后必须停止的总量阈值，不是文件系统配额；每2秒计量同job全部受管scratch（包括既有待宿主回收项），短别名/硬链接不重复计数。现有0.1秒磁盘余量检查继续覆盖报告、构建/镜像等占盘；采样间隔及终止等待内可能越线，不声称零超调。12GiB余量不降低。
- 明确区分格式损坏/命令失败和语义不可解析对象：后者在hosted导出路径保留诊断并阻止删除，不能单独阻止非破坏快照；格式无法核验或真实路径/别名命中仍拒绝。默认open_paths行为不变。
- 本地最终原件/资源审计仍只接受实际cleanup complete；冻结v2工具、full12/container02不改写、不重签。新CI合同独立核验hosted证据。
- 手工测试经主目录已提交的run.py管理，报告放本轮handoff，测试temp仅使用受管TMPDIR。不要让正在修改的清理代码负责外层安全边界。

## 审查重点

1. 环境伪用/跨run或boot/旧台账/链接根不能获得委托资格；T1、T3反例。
2. active writer、已知短别名socket和未完成报告仍拒绝；T2、T3反例。
3. 同job旧scratch不反复重做finish、不把passed改为interrupted，并计入预算；T1、T3反例。
4. 导出失败/中断不上传raw或冒充测试通过；T2、T4反例。
5. 本机严格保护不退化，CI成功也不能伪报宿主已销毁；T3、T4反例。

## T1：托管身份与总量预算

文件：新增tools/test-resources/hosted.py及test_hosted.py。
- [x] 写小样例RED：默认严格、错误平台/job/workspace、不同run/attempt/runner/boot/SHA、旧或篡改scope拒绝；实际文件累计与重复inode/短别名、低余量、阈值触发。
- [x] 经受管运行器执行test_hosted.py，确认缺失行为的RED，保留原日志。
- [x] 实现上述五个API；路径测量不读取文件内容或跟随链接；可捕获的遍历竞争有明确有限处理，权限错误不视为零。
- [x] GREEN与独立代码审查，保留来源摘要、运行回执。生产入口未接线前不得称CI可用。

## T2：非破坏稳定报告导出

文件：新增tools/test-resources/stable_reports.py及test_stable_reports.py。
- [x] RED：结果/HTML/OPFS保留、raw不复制、失败诊断限额、source变化/链接/FIFO/错误owner拒绝、目标冲突/中断/重复调用、摘要篡改/额外文件拒绝。
- [x] 执行RED后实现流式复制和前后身份/hash核验，不把整个大文件读进内存；原环境逐字保留。
- [x] 先写目标归属记录、最后写完整清单；未完成导出不能当报告通过。只移动后续新建的导出副本时仍需来源/目标身份链。
- [x] GREEN及独审；与T1同一轮执行串行，样例总量为KiB级。

## T3：Run/Store和执行器接线

文件：lifecycle.py、run.py、新test_hosted_lifecycle.py，必要的原回归适配。
- [x] RED覆盖scope先登记再创建、默认strict仍拒绝global异常、hosted只读快照允许记录明确语义未知但仍阻止真实路径/活动group/损坏字段、未知根拒绝。
- [x] Store创建时登记scope；Run验证租约、scopePaths、短别名和当前context；专用export-ready路径与严格assert_quiescent分开。
- [x] finish保留scratch，复制稳定报告并登记host-disposal-pending；sweep验证后跳过已完成委托项，prune不得手动删除它们。
- [x] 启动前/执行中/导出前后核验预算。报告累计5GiB计入导出副本；超限、中断和写入者未退出仍非零。
- [x] publish只发布已验证的独占快照；rotate核对旧published归属与manifest，不覆盖未知目录；recover_ci重新验证身份/稳定导出，不能单凭publicationComplete返回。
- [x] 完整Python小型回归串行，原本机成功/失败/中断/重复回收保护保持。所有样例本轮结束清理（最终289项通过，原日志和源码摘要见python-all04）。

## T4：CI接线与证据合同

文件：ci_preflight_receipt.py/测试、ci.yml/ci-workflow.test.ts、tools/src/ci报告验证与测试；新轮外部资源审计。
- [x] RED覆盖hosted收据只有身份、进程、稳定清单、预算一致才接受；failed报告可以安全上传但job仍失败；本地complete必须无scratch/短根。
- [x] 工作流显式策略仅三job定义，移除这些步骤不再需要的service scope注入；固定sudo lsof仍为只读，原六项测试、超时/重试不变。
- [x] profile归档/上传必须等待稳定报告核验，归档失败不回退raw。verify/container也携带对应资源收据，不增加完整环境artifact。
- [x] 新外部CI资源验收合同、来源绑定及关闭工具已实现，核对便携清单/哈希/类型与新状态的KiB回归和独审通过；真实同SHA CI验收仍列T5。本地旧签署链不放宽，旧失败/旧工具原件保留。
- [x] 定向Python/TypeScript及配置回归、独审完成；AGENTS、测试规范、审批记录与handoff已更新。

## T5：最终串行验证与关闭

- [x] 核对小型实际Linux GNU tar与实际磁盘，使用已有镜像的小样例，未扩大为Linux zstd或托管CI已验；原件及限制保留。
- [x] 冻结50beb4e9及SDK输入，依次完整本机full13、同源container03均通过；每轮磁盘/内存及桌面监测正常，原件/资源审计接受并pin，临时环境已清理。
- [x] 正常中文文档提交b05b9514及no-ff/main790e746c推送（正常pre-push 292.02秒），精确文档等价与v3绑定成立。
- [x] CI40713106707的路径别名预检阻断已局部修复、55项定向与299项资源Python回归通过、独审接受；bfd31dba正常合入main63bf7d64并推送。后续CI40718430340六项资源预检实际通过，原失败不改写。
- [ ] CI40718430340容器328项通过后因活动目录计量竞态中断，11项未运行，报告checker与上传成功而job保持失败。按[调查](../reviews/P4-S6-活动目录计量阻断调查.md)修复已确认子项消失的采样，完成KiB RED/GREEN与独审；其余任务和报告能力按实际结果核对，不把此次失败工作流记为最终通过。
- [ ] 新源码须以独立full14/container04来源记录完成同源完整本机与容器门禁，之后正常合并/推送并验收同一最终SHA六项CI；旧full13/container03不替代本轮。若此次诊断的报告链路证据足够，直接进入最终验证，无需为重复取证再启动一轮诊断推送。
- [ ] 为新轮生成独立来源/报告/资源证明，最终独审、证据冻结、实际P4 worktree清理；完成后才从main建立P5。

执行账：主目录.codex/handoffs/m5-p4-20261022/s6/hosted-vm-policy/progress.json；每次修改/测试/提交同步，不靠会话记忆。用户已批准方案B和自主实施，不对这些已明确步骤再次询问。

## 2026-10-29 接续顺序

CI40718430340最终仅5/10份artifact：四浏览器及容器failure、verify cancelled。七万资源失败缺SQLSTATE，四浏览器缺主报告且复合容量原因未分开，coverage和E2E运输成功链没有实际证据。此前“现有诊断足够即可直接最终双门禁”的前提未满足。

活动采样33/309、bulk安全诊断及其13项最新小回归、清单40/313、日志帧134及各自独审已完成；大案例只有一次旧helper输入通过，不代替最终同源验收。先在现有唯一Phase分支正常保存全部局部结果，再正常no-ff与钩子诊断推送一次；实际新SHA结果决定是否还有产品/报告修复，不能凭本机通过猜测历史CI原因。

若新诊断通过且所需报告/运输原件成立，不要求人为重现旧故障；历史cause继续未知并保留原件。之后冻结最终源码与工具、串行full14/container04、正常最终合并推送、同最终SHA六CI及十artifact严格审计、独立关闭和实际worktree清理；诊断CI不替代最终CI。

r04尚未冻结/捕获，当前parentMain为63bf7d64。待新的真实诊断merge SHA落地，先保存将修改的少量候选源码原件，再按实际父提交/Phase tip维护候选及相应小测试，受管执行RED/GREEN并重新独审；十份复用工具保持原hash不变。不另复制整个工具集合，不覆盖旧候选回执或冻结v2/v3，不补签capture-before。没有实际SHA前不预填新父提交。

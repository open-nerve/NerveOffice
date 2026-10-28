# P4-S6 七万资源 CI 失败调查

日期：2026-10-29（上海）。状态：原始失败已定位到 SQL，数据库底层原因尚未取得；先补诊断，不修改产品查询、迁移、预算或验收范围。

## 原件与已知事实

诊断提交 `63bf7d64cf695ec40ae99101abb6a02429d06a89` 的 [CI40718430340](https://github.com/open-nerve/NerveOffice/actions/runs/40718430340)，verify job为122922379167。原日志、API元数据及annotations保存在主目录 `s6/hosted-vm-policy/ci-40718430340-capability-20261028T163100854851Z/`（完整前缀为 `.codex/handoffs/m5-p4-20261022/`）。原日志约2.66MB，最长一行2,197,064字符；阅读时按行有界截取，不能整行输出资源数组。

目标是 `tests/integration/src/assets/asset-references-bulk.test.ts` 的“七万个真实资源的来源查询、加锁和关系替换完整往返；绑定参数不随 ID 数量展开”。该文件于UTC15:59:51记录失败，文件耗时40,014ms；最终总计705文件中704通过、1失败，16,943项中16,942通过、1失败。失败SQL与 `DocumentAssetsRepository.replace()` 的 `INSERT INTO document_asset_links … SELECT … unnest … ON CONFLICT DO NOTHING` 相同。随后job被取消，平台注解明确达到45分钟上限。

错误日志中没有该异常的SQLSTATE、cause或调用栈；巨型参数行尾同样没有这些字段。不能根据40秒耗时推断为语句超时、锁等待、客户端超时或数据错误。日志输出延续到UTC16:28是可见顺序，但尚不能独立认定是巨型参数输出导致整个job超时。coverage对testdata/README.md的解析警告在已通过的full13也出现，不能把它当作此次数据库失败的根因。

## 调用链与待验证假设

Drizzle 0.45.3的查询错误把底层pg异常放在 `.cause`，顶层message却拼接全部参数。此案例直接调用领域服务，异常逃到Vitest，绕过项目日志序列化，丢失了可用的底层原因并产生巨型参数文字。

该测试仅覆盖databaseUrl，沿用应用默认statement_timeout=15,000ms、lock_timeout=5,000ms、客户端query_timeout=20,000ms；用例限制60,000ms。迁移0036的逐行引用活动触发器会对70,000个关系追加活动记录及外键检查，是需要测量的性能路径，但当前没有证据证明它导致本次失败。

full13的目标测试、仓储、领域服务、数据库配置、事务、迁移和锁文件与诊断源码相同，整套705文件、16,943项通过。full13未保留该用例单独耗时；其整轮单元/集成为216.33秒，CI为1110.33秒。平台性能差异值得调查，不构成放宽任何限额的依据。

## 下一步补证边界

1. 复用现有 `serializeError`，在目标测试的数据库失败边界记录固定阶段、耗时、数量及有界SQL/cause/SQLSTATE。只包装可识别的数据库异常，仍令测试失败，不能将原始Drizzle cause再次交给Vitest打印参数；非数据库断言保留原语义。该serializer的通用异常分支不是任意输入脱敏保证。
2. 先用真实PostgreSQL的小样例产生受控错误，验证Drizzle cause能够保留、参数标记不会进入最终格式化错误。该样例只验证诊断链，不代替原70,000资源案例。
3. 保持原数据规模、应用限制、用例限制和断言，受管串行定向重跑并记录各阶段事实；以实际错误码区分查询执行、锁等待或连接问题。若本机通过，记录不可复现的局限，不反推CI已通过。
4. 根因明确后再确定最小修复，独审及必要回归通过后，仍须同源full14/container04和最终同SHA六项CI。预算采样修复2831f7ed及其33/309项通过不覆盖此独立失败；P4未关闭，P5未开始。

## 诊断实施与本机对照

六份源码已完成窄范围诊断：现有serializer仅经测试专用出口提供，lint只允许该出口访问这一文件；目标用例使用固定阶段计时。事务回调内保留原错误，退出TransactionRunner/capture之后才包装可识别的数据库异常，避免改变回滚及SQLSTATE选择。输出再次按原异常的真实类型投影，未知cause不带自有字段/消息/任意stack；不信任可伪造的type名称。完整message前缀剥离后才取数据库帧，序列化自身失败时只留下有限SQLSTATE与固定诊断不完整标志；新异常不携带原cause。非数据库断言原对象重抛。

真实PG的57014、23505及回滚失败、参数伪帧、未知getter和类型名称冒充均先RED后修。最新13项诊断、局部lint和integration类型检查通过；此前11项诊断加50项lint边界合同的61项通过，六文件lint与API/integration/tools类型检查通过。没有修改生产查询、触发器、数据规模、超时或原用例断言。

原70,000资源案例只执行一次，带原样coverage与原阈值：案例1/1通过，JSON中耗时11,238.71ms，总命令测试处理14.07秒。阶段日志为fixture2,770ms、prepare385ms、hold2ms、authorize338ms、replace2,274ms、回读45ms、HTTP保存4,614ms、HTTP回读172ms。单文件运行的全仓coverage为47.48/33.89/0/0/0，未达到90/80/70/80/80，命令如实退出1；这不是完整门禁通过。

该大案例之后只修正失败诊断中的类型冒充投影，变更仅helper及其小测试，并补13项GREEN，没有重跑大案例。原helper SHA为 `60bba54564da7ac4e86471628116e035f3b3f40785b639a7b5f533e3cee23275`，最新helper为 `468656cc6af852172e9319bbef27d08c2d2a120dcb555bdb4d78204b83ae9dba`；不得把旧输入的大案例记录当作最终源码完整验收。

原件见 `s6/hosted-vm-policy/bulk-diagnostic-implementation-evidence.json`（SHA-256 `1d2c7e187a575b911569e131922fd7e301a63023dcc8ffd5c35d213fa5553904`）及不可覆盖的v2（`93c84f661794e1b0d05858248c25a43f7199b10bdd5428e9053a7c30847ad3c2`）。十二轮均有真实起止前后的输入摘要，临时目录、短根和专属进程组实际回收。六份源码及这些原件经独立审查接受，回执 `bulk-diagnostic-independent-review.json` 的SHA-256为 `e2e576e174e63031593d72a828b202a6b2e39c370ecb7260d64df56e50e2dda6`。

历史CI的底层SQLSTATE仍未知；本机通过没有消除这个证据缺口。后续CI须用新的安全阶段诊断取得实际结果，再决定产品修复，不能凭性能猜测修改查询或延长限制。

## 另行发现的日志边界

诊断审查同时以自制标记复现：合法含内部换行的搜索词经实际搜索pattern函数及真实Drizzle错误类，进入生产root/child logger后可混入stack；普通单行标记没有进入日志。原件在 `s6/hosted-vm-policy/logger-frame-probe-20261029/`，同轮源码前后不变且资源已清理。此为受控合成错误，没有执行HTTP或数据库请求，没有使用真实业务数据，也不能据此宣称历史用户数据已泄漏。

独审认为证据支持应修的局部日志隐私缺陷，不能直接定性为越权或高风险攻击。后续限定在logging模块的数据库错误帧提取及root/child/HTTP回归中修复，不改变搜索契约、SQL、全局日志结构或资源门槛；本节的六源诊断接受不覆盖这项后续修复。

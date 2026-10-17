# P6-S4 真实 Safari 保存与存储边界

> 2026-10-17；真实 Safari 六组保存测量、正常/隐私窗口对照和 S4 收尾检查已完成。P6 整阶段审查和验收仍在 S6，M4 尚未完成。

## 证据分层

正式执行依照 `plans/P6-S4-真实Safari保存测量与存储边界.md`。报告分别列当前 Safari 实测、WebKit 官方公开政策、固定上游源码；上游 main 不是所安装 Safari 27.0 的精确构建源码。

## 官方存储政策

WebKit 的 2023 年说明将默认存储列为 best-effort；总配额、磁盘压力或长期缺少交互均可能触发驱逐，活跃页面或持久模式可能获得豁免。`persist()` 按启发式规则决定是否授予；`estimate()` 的 quota 是上限，不能当作实际可写空间保证。应用仍需处理配额失败，不能把一次持久授权解释成永久保留。[Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

ITP 的七日口径是 Safari 使用日内缺少与该网站的用户交互，不是网页写入后七个自然日必删。官方单独说明主屏幕 Web App 的首方域名豁免；这不能直接变成普通浏览器标签页的产品保证。本 Step 没有真实等待七个使用日。[2020 年政策说明](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)、[现行 Tracking Prevention 文档](https://webkit.org/tracking-prevention/)

官方将隐私浏览描述为临时会话，关闭标签页、退出浏览器或重启会清理状态；各隐私标签的会话隔离。[Tracking Prevention：Private Browsing Mode](https://webkit.org/tracking-prevention/#private-browsing-mode)

2022 年 OPFS 介绍曾写明隐私窗口不可用，这是一份历史版本说明。S4 已在当前 Safari 分别尝试 `getDirectory`、Worker 同步句柄的实际写入/flush/读回及关闭重开，当前结果见末节；不能仅凭旧文档或 API 存在给当前版本定性。[The File System API with Origin Private File System](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)

## 固定上游实现线索

取证版本为 `9d236ecf922ec5d79d7bdb77989a8b0b01253a3c`；下载来源、各文件 SHA-256 与字节数保存在主目录 `.codex/handoffs/m4-p6-20261017/s4-webkit-storage-source/source.json`。以下只描述这一源码版本。

- `NetworkStorageManager.cpp` 的配额与时间驱逐路径分别检查活跃状态和 persisted 标记；`persist()` 拒绝非首方 origin 或没有持久标记路径的情况，再向 NetworkProcess 取得域名豁免集合，`persistOrigin()` 仅为集合内域名写入标记。
- `NetworkProcess.cpp` 将豁免集合查询转给当前会话的 ResourceLoadStatistics；没有对应会话/存储时交回空集合。
- `ResourceLoadStatisticsStore.cpp` 的 `domainsExemptFromWebsiteDataDeletion()` 合并 app-bound、managed、persisted 域名，并加入独立应用域名；删除候选循环在 `shouldExemptFromWebsiteDataDeletion()` 为真时跳过该域名。

因此，这一上游版本中持久授权和 ITP 删除豁免存在实现联系；不能写成“二者完全无关”。同样不能据此保证一次 `persist()` 成功就能免于用户清理、会话销毁或未来所有策略。普通/隐私窗口的当前返回值及重开结果见末节。

源码直接链接：[存储管理器](https://github.com/WebKit/WebKit/blob/9d236ecf922ec5d79d7bdb77989a8b0b01253a3c/Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp)、[NetworkProcess](https://github.com/WebKit/WebKit/blob/9d236ecf922ec5d79d7bdb77989a8b0b01253a3c/Source/WebKit/NetworkProcess/NetworkProcess.cpp)、[ResourceLoadStatisticsStore](https://github.com/WebKit/WebKit/blob/9d236ecf922ec5d79d7bdb77989a8b0b01253a3c/Source/WebKit/NetworkProcess/Classifier/ResourceLoadStatisticsStore.cpp)。

## 共用计时提取与原 P2 校准

S3 已以 `6aec1bbb` 提交。S4 计时函数沿用原 P2 起止点与 15 秒界限，新增 15 项行为测试 RED→GREEN，相关 lint 与全仓类型检查通过。原 P2 校准 `s4-timing-calibration-20261017T082336Z` 三浏览器 × 六组 × 两轮，共 18 组/36 轮通过，零 skip/flaky/unexpected，118.8 秒，源码/构建摘要未变。它仅是两轮校准，不充当 Safari 正式 120 轮。

首轮 `s4-timing-calibration-20261017T082008Z` 18 组均在计时前停止：旧测量累计 Worker 数的断言仍要求 1，P3 只读恢复检查已增加临时 Worker。源码 `outbox-session.readRecovered` 在 finally 关闭它；最终实测每组累计 2、测量时存活 1。测量现独立核对存活写入 Worker 恰好 1，累计数量作为事实保留，不把阈值放宽成任意数量，产品生命周期未改。

## 页面与宿主接线校准

独立解密已拆为测量前取得不可导出 key、随后纯本地解密；旧暂停/崩溃入口仍委托同一独立 AAD 实现。新增真实 Worker 发送/回包时刻、严格样本结构、逐轮宿主确认和只切本次 `/api/` 的代理。未完成上游请求时拒绝切断；切断后关闭实际连接，控制端点和静态资源仍可访问。线上每轮独立读取数据库 gzip 原件并核对完整字节摘要，离线保持原修订与摘要。

相关 224 项单元回归通过，新增失败诊断、离线客户端失败与隐藏拒绝的两项负例也已 RED→GREEN。全仓 lint/typecheck 和测试构建通过。首个接线批次 `s4-page-calibration-20261017T085421Z` 在登录来源校验收到 403，未测量；改为每组独占测试后端，以该组代理为真实公开来源，保持 Origin/CSRF 校验。`085715Z` 实际浏览器明确报执行 stub 未接线，作为 RED 原件保留。

`090348Z` Chromium 1m 在线两轮完整链路通过，15.4 秒、源码/构建未变。`091445Z` 的 Chromium/Chrome 12 组通过，WebKit 6 组在测量前进入只读，均为 0 样本。独立最小探针 `s4-webkit-context-1792228827717` 显示临时上下文 OPFS 报 UnknownError、持久上下文可打开，两者 Crypto 均就绪；校准改为与原 P2 相同的原生持久目录，没有修改产品存储策略。

最终 `s4-page-calibration-20261017T092114Z` 三浏览器 18 组、36 轮通过，零跳过/重试/异常，274.7 秒，源码与构建未变，独立原始附件审计通过。各组两轮中的较慢值为 1037–1158 ms，1 MiB 捕获最高 21 ms。以上均不能替代真实 Safari 120 轮。

随后补齐读一次真实草稿的纯校验负例：缺失、旧 seq、错身份/修订、未完成公式、过去/未来时间共 11 项，RED 10 失败/1 通过 → GREEN 11 通过。新增拒绝未来时间并抽取断言，补入 Safari 正式入口；该次变化后的重新构建、静态检查和旧暂停/崩溃回归如下。

`s4-preflight-20261017T093252Z` 的 lint、typecheck、167 单元、故事门禁、构建、18 项旧暂停/崩溃回归全部通过；旧场景零跳过/失败/重试，178.6 秒，源码/构建不变。最新 `s4-page-calibration-20261017T093934Z` 再次 18 组/36 轮通过，274.8 秒，独立审计通过、输入未变。

## 正式 Safari 首轮与长轮次判据修正

`s4-native-20261017T094435Z` 启动器工作目录不符，被专用测试数据库包装器在运行前拒绝，没有操作 Safari。修正的 `094650Z` 首组 1m online 20 轮通过：本机保存 p95 1043 ms，捕获 p95 20 ms，源码未变、清理完整。

同批 1m offline 保留 20 份真实草稿/Worker/解密与逐轮数据库原件，但最后未通过，不能记为完成。连续编辑跨过心跳间隔，实际租约续约首先断网；产品连接状态失效使 `editing-session` 暂停上传，后续会话核对也真实失败，因此没有正文 PUT。页面最终错误地只等待“正文上传失败”，20 秒后超时。三浏览器两轮校准先结束编辑，在首个心跳之前即发起正文上传，没有覆盖这一差异。

测量现改为只读产品请求层登记的本轮新连接失败，并由宿主核对精确应用端点的真实断开、切断后零上游与数据库不变；不修改产品管线或强迫上传。两项关键行为测试 RED→GREEN，相关 12 项通过。新增 20 轮三浏览器离线校准，之后重跑正式六组。失败 profile claim 与所有旧原件保留，暂不关闭 S4。

## 最新正式保存测量

修正后的相关 lint、全仓类型、121 单元及构建通过。`s4-page-calibration-20261017T095555Z` 三引擎各 20 轮离线长校准共 60 轮通过，101.9 秒；独立审计确认三组均真实出现续约失败、正文 PUT 为 0、逐轮数据库不变。`095820Z` 的六组条件三引擎两轮校准共 36 轮通过，274.9 秒，零跳过/失败/重试、独立审计通过。

正式原件为 `.codex/handoffs/m4-p6-20261017/s4-native-20261017T100256Z/`，当前 Safari 27.0。六组各 20 轮全部通过，`independent-audit.json` 独立复核 120 轮；所有组源码和构建摘要一致，运行期间未改变，清理正常，专用场景占用正常释放。每组开始前均解锁且空闲至少 120 秒，活动/可见性证据完整。离线指专用代理断开本轮应用 API，未关闭系统网卡。

| 样本 | 网络 | 轮数 | 本机保存 p95（ms） | 同步捕获 p95（ms） | 公式完成 p95（ms） |
|---|---|---:|---:|---:|---:|
| 约 1 MiB | 在线 | 20 | 1044 | 20 | 0 |
| 约 1 MiB | 应用 API 断开 | 20 | 1048 | 20 | 0 |
| 约 5 MiB | 在线 | 20 | 1136 | 66 | 0 |
| 约 5 MiB | 应用 API 断开 | 20 | 1135 | 67 | 0 |
| perf-50k | 在线 | 20 | 1049 | 25 | 685 |
| perf-50k | 应用 API 断开 | 20 | 1048 | 24 | 685 |

全部样本满足公式 ≤ 900 ms 条件，没有过滤或排除轮次；本机保存 p95 ≤ 2000 ms、1 MiB 捕获 p95 ≤ 100 ms 均满足。每轮在计时结束后只读真实草稿、匹配实际 Worker 回包、独立解密及核对正文/公式缓存；在线逐轮核对完整云端摘要与修订，离线逐轮保持基线。该结果只证明本轮版本/环境的保存测量，不作永久保留承诺。

## 正常与隐私窗口的同源对照

原件为 `.codex/handoffs/m4-p6-20261017/s4-storage-native-20261017T1018Z/`，macOS 27.0、Safari 27.0。独立探针只在本轮随机本机来源使用合成标记，不访问产品数据库、草稿或密钥。四个窗口依次执行正常写入、正常重开读取、隐私写入、隐私重开读取；来源和运行标识始终相同，正常窗口始终属于“NerveOffice M4-P6 保存测量”场景。原生界面确认模式并留回执，宿主分别核对上一窗口确实消失、新窗口只有一个精确测试页，四轮均在解锁并连续空闲至少 120 秒之后开始、全过程可见。

| 观察 | Worker OPFS | IndexedDB 对照 | persisted / persist / persisted | estimate quota（字节） |
|---|---|---|---|---:|
| 正常窗口写入 | 根目录、文件、同步句柄、写入、flush、读回、close 均完成；68 字节一致 | strict 事务完成，读回标记一致 | false / false / false | 82463372084 |
| 关闭后重开正常窗口 | 同步句柄读取原 68 字节一致 | 原标记一致 | false / false / false | 82463372084 |
| 隐私窗口写入 | `getDirectory()` 抛 `UnknownError`，没有进入同步句柄或写入 | strict 事务完成，读回标记一致 | false / false / false | 1048576000 |
| 关闭后重开隐私窗口 | `getDirectory()` 仍抛 `UnknownError` | 原库不存在；只读检查发现升级即中止，没有补写标记 | false / false / false | 1048576000 |

正常写入前后 estimate usage 为 0 → 1048660，重开读取前后为 110660 → 110664；隐私写入为 0 → 84，重开读取为 0 → 4 字节。API 的用量统计存在元数据与异步核算差异，这些数不是合成正文长度；quota 也不代表当前磁盘有同样多的可用空间。

结论仅限这一版本和本轮来源：正常场景的两种存储经过关闭重开后保留；隐私场景的 IndexedDB 是本次窗口会话中的临时数据。隐私 OPFS 连根目录都无法取得，所以不能写成“已写成后被清理”，也不能声称同步句柄已被验证可用。产品继续保守处理接口存在但根目录失败，不扩大为 `unsupported` 后静默承诺完整冗余。本次未取得 persist 授权，不能据此声称已实测获准站点的七日豁免。

探针结果判定 12 项单元 RED→GREEN；八项 HTTP/协议校准均通过（未知路径、错误 Host/Origin、超限、未 arm、错 run、重复 boot）。首个 Python urllib 校准在错误 Host 上超时，原件保留；直接本机 HTTP 连接对照已验证 200/403/200，最终校准显式连接回环地址，不据此改动宿主规则或推断系统代理根因。`independent-audit.json` 复核四轮原始事实、模式回执、窗口关闭、活动条件和源码摘要；12 项篡改负例均拒绝。宿主正常退出 0，最后测试窗口也已关闭。没有真实等待七个 Safari 使用日，没有永久存储保证。

## S4 收尾验证

`s4-final-checks-20261017T103132Z` 全仓 lint/typecheck 通过，单元为 9870 通过/1 失败：默认 29 步的目录穷尽断言漏列本计划要求独立运行的 `local-save-online/offline`。仅在测试中精确补齐这两项排除，默认 29 步的完整逐项断言保持；产品、测量入口、宿主及构建均未修改。`103717Z` 定向 lint/e2e 类型、全仓 491 文件/9871 单元及故事门禁全部通过，零跳过/失败，检查期间源码/构建未变。故事门禁识别全部 57 个 active 故事，包括 M4 的 15 项。

`verify-s4-completion.py` 重新审计正式六组120轮、四个存储窗口和最终源码；2229份正式测量输入中只有上述单元断言文件变化，全部运行时代码/驱动/构建一致，12项存储审计篡改负例及8项协议校准通过。原始失败没有覆盖。完成回执为外部 `s4-completion-receipt.json`。S4 四项任务完成；DEF-009/012 已补齐验证范围，最终关闭随 S6 的独立审查、完整本机/容器验收和同 SHA 六项 CI，不能据本 Step 宣布 P6/M4 完成。

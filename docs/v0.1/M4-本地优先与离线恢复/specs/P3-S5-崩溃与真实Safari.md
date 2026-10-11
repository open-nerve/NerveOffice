# P3-S5 崩溃与真实 Safari：设计规格

> 基线：S4 `9f86ab36`｜日期：2026-10-11｜唯一分支：`codex/m4-p3-recovery`

## 目标

取得 US-M4-04/05 真实进程中断后的用户链路证据：恢复最后一次实际写进本机的正文；服务端已经接收但浏览器没有拿到确认时，不多一个修订；主库丢失后从镜像找回，并如实提示。真实 Safari 的原标签页页面进程崩溃后，验证 S4 自动恢复。承接 Phase §6 S5、总设计 §2.1 第 6 条、§6.10；不把 Playwright WebKit 或注入 wasDiscarded 写成真实 Safari 结论。

## 三浏览器崩溃

复用 browser-crash.ts 的持久目录、精确认进程、同步冻结/结束、数量与幸存者核对。每浏览器一个 crash 项目、一个工作进程；macOS 的 crash-webkit 与其他 Playwright WebKit 互斥。报告必须带实际 PID/角色/来源、结束时刻、重开代次、Cookie 前提及 IndexedDB 日志状态。

用真实页面输入、实际捕获/生产发件箱 Worker/加密/落盘制造原件；测试进程用 readLocalDisk/diskSnapshot 独立解密核对最后写成的正文。只暂停首个页面的定时云端上传，不以 seedRecovery 或直接写 IDB 代替要验证的写入。

1. 未同步正文：保留原登录、清除 Cookie 后重新登录两条路。整棵浏览器重开是普通导航，不注入 sessionStorage、navigation 或 discarded。初始无自动申请且为阅读；原租约仍被占用时由页头“在此编辑”显式接手，取得新代次后恢复正文，零额外输入也同步，云端只增加一个修订。不能人为让旧租约过期以迎合“恢复并编辑”按钮。
2. 确认丢失：实际保存 PUT 经服务端完成、测试进程收到 200，但不把响应交给浏览器；独立核对磁盘 inFlight 与云端修订后真正结束浏览器。重开两种 Cookie 前提均以原 query/gzip 精确无租约核对，仍保持阅读，不增加修订；核对原件清理与最终云端正文。
3. 镜像恢复：真实写成并崩溃后，先重开不带 documentId 的探针页，在无写入者活动时明确删除主库、保留镜像，再打开真实文档。检查找回提示、原正文、显式接手与保存。这是确定的“主库丢失”前提；UR-034 的自然机制与半条日志实验仍由原崩溃套件独立验证，不宣称直接删库证明浏览器自然删库。

WebKit 共享 OPFS 的清理只针对本用例用户；先离开真实编辑页、关闭探针/管道的句柄，再移除该用户镜像。失败亦保留原始报告，不接触别的用户/来源。

## 真实 Safari

遵守已批准总设计 §2.1 第 6 条：仅用户空闲至少 120 秒且屏幕未锁时跑；运行中用户回来则作废。只结束能够证明属于本次测试页的 WebContent 进程，不结束 Safari 主进程，不碰既有用户页面，不改 Safari 的远程自动化或 Apple Events JavaScript 设置。

先做目标识别的只读可行性验证，再实现可发信号的驱动。候选证据须证明整个进程属于测试，而不只是当前可见页；同时核对进程出生前后基线、UID、微秒启动时间、实际 Safari WebContent 可执行文件与 Apple 签名，发信号前再次取证。空结果、多个候选、其他来源、未知归属或 PID 被复用均拒绝。仅凭进程名、最新 PID、父进程或窗口标题不足以操作。

上游 WebKit 的 activePagesOrigins/updateActivePages 将非临时页面来源发布为 LSActivePageUserVisibleOriginsKey，可作为本机探索的线索，不能在本机取证之前宣称可用：[WebKit 原始实现](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/WebProcess/cocoa/WebProcessCocoa.mm)。若本机无法可靠定位，留“未验证”报告并继续不依赖该实验的工作，不能勾选 A16 或完成 Phase。

### 本机只读校准后的归属方案（2026-10-11）

本机 Safari 27 / macOS 27 的多轮就绪页观测均未取得 LS origins；该来源枚举方案不接线。Safari.sdef 的只读 `tab.pid` 能返回当前页进程，但“旧 PID 当前没有标签”无法排除 BFCache 历史页，随机端口也不等于 WebKit 的 site 隔离。独立审查拒绝以此放宽归属。

用户另行明确批准创建 Safari 用户场景 **NerveOffice M4-P3 验证**，保留供后续验证。经原生 UI 创建全新场景、独立收藏夹，确认扩展关闭；原场景成为默认“个人”。创建前记录 PID 基线，创建后记录 Safari 自身的场景按钮、窗口 UUID、窗口 ID；只向这个新窗口放本项目自有测试页面，不迁入既有标签或标签组。

归属依据：Profiles 使用独立 WebsiteDataStore；WebKit 的进程共享、缓存与挂起历史页复用均要求同一 data store。因此，对从创建起始终专供测试的 profile，其历史页进程也属于测试。这是依据官方说明与上游源码的推论，再以本机映射校准支持，不把 `tab.pid` 当成完整历史页清单：[Profiles API](https://webkit.org/blog/14423/building-profiles-with-new-webkit-api/)、[WebProcessPool](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/WebProcessPool.cpp)、[WebProcessCache](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/WebProcessCache.cpp)、[SuspendedPageProxy](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/UIProcess/SuspendedPageProxy.cpp)。

本机无信号校准记录 `70c26f34-6b96-41f3-9a17-2df917208ed7`：专用窗口 `390978` 中 A（127.0.0.1）为 PID `61631`，导航 B（::1）换为 `70232`，历史返回 A 恢复 `61631`，`pageshow.persisted=true`。四次观测的场景、精确 URL、内核出生身份与 Apple 签名吻合；既有用户窗口 `390899` 的 PID `22657` 不变。用户空闲 121–124 秒，未锁屏，零信号。完整原始记录与创建证据在忽略的 S5 证据目录，最终随 S5 冻结。

驱动须把场景创建与独占证明作为**本机操作前提**，不能由 HTTP 页面报告提供。执行前要求固定窗口、场景与唯一精确随机测试 URL 的 `tab.pid` 一致；其他窗口映射同 PID、未知页面、场景/窗口变化均拒绝。仍要求 PID 不在创建前基线且出生时间晚于该基线；内核用户、Apple 签名、系统 WebContent 路径、bundle、ASN、微秒出生身份齐全。二次重新采集后，原生执行器在单 PID 信号前再次核对内核身份与签名。所有已知历史页均来自专用场景的测试；独占前提不再成立时作废，不能只靠当前列表重新认领旧场景。

页面准备与重载检查放在测试构建的自检入口，生产包不包含。准备阶段输入已知正文、等实际持久完成，向本次测试驱动交付非敏感就绪证据，保留原页真实记号与实例身份。驱动确认目标后结束一个页面进程；Safari 自行重载，新页只观察自动恢复，不手动点击编辑、不写回身份或伪造导航。核对原 clientInstanceId 的普通申请、恢复提示、实际正文、一次云端修订与本机清理。

初页和重载页的错误计数均须为零。报告只保留计数、身份、摘要与状态，不传错误正文或凭证。Playwright 的普通刷新校准使用独立 `reload-calibration` 模式，不能记录成 `process-kill`；实际 Safari 驱动只接受后者。

就绪通信优先采用测试驱动拥有的同源控制通道；必要时在测试服务之外增加本机反向代理，只转发原应用流量并截获明确测试路径，应用后端的接口与生产 CSP 不变。控制信息不包含密码、会话 Cookie、密钥或租约令牌。页面自检逻辑先在 Playwright 校准，目标识别/拒绝判定/结果核对先以单元反例固定。

## 实际驱动与首轮结果（2026-10-11）

实际模块分别负责归属纯判定（profile-process）、只读采集与执行接口（profile-adapter）、原生身份/临发检查（profile-native.swift）、专用场景已知页面与失效锁存（profile-continuity）、持久独占 claim（profile-claim）、测试同源代理（crash-proxy）、清理（crash-cleanup）和驱动（crash.ts）。页面/协议分别为 selftest-crash.ts 与 support/crash-session.ts。原 LS origins 的 page-process.ts 没有系统接线。

驱动从 tests/e2e 目录通过 NODE_OPTIONS=--conditions=@nerve-office/source node safari/crash.ts 调用，必须明确 NERVE_TEST_DATABASE_URL、--profile-proof、--owned-pages、--output。默认只做零信号 checked-only；--kill-owned-page 才允许一次已归属的页面信号。输入证明来自实际创建和连续观测，不能从示例复制。启动资源之前建立并同步持久 claim；异常后保留，不能因旧 PID 已死或当前页看起来正确就删除重用。成功亦须完整回收、最终连续性核对和报告落盘之后才释放。

代理只在本机同源的随机控制路径接收严格协议，应用 HTTP 字节/头、CSP 和服务端业务不变。初页实际生产 Worker 写成后独立解密；后页只观察，HTTP 另核对原身份普通申请及唯一保存，数据库另解压核对修订/正文。客户端中断、后端请求失败与响应正文中断分别记录；未完成恢复请求保留 status=0。最终信号前原生再次核对身份、桌面、新鲜度与总时限，所有清理逐项尝试。

真实 Safari 首轮 ca37d8a9-7d5a-4faf-a8dd-d244c48c01bb **未通过**。真实正文持久就绪后，向精确页面 PID 12783 发送一次 SIGKILL（1791730537962）；旧进程身份在 9ms 后已消失。Safari 原页自行重载并显示崩溃重载横幅，但停在阅读模式，恢复阶段 acquire/save 均为空，约 90 秒后页面报告 failed。整轮 outcome=unverified，自有后端正常退出、cleanupFailures=[]，没有再次发信号，claim 保留。

只读现场核对取得 navigationType=navigate、wasDiscardedSupported=false、timeOrigin=1791730538018，旧记号为 null，当前持有新实例 24c02205-b639-4d69-a664-2f9399721e60 的独占锁。S4 在 start.tsx 采集导航后，reloadIdentitySelector 同步清除非 reload/非 discarded 的恢复记号，selectReloadIdentity 不会读取旧候选。因此可确认导航门槛必然拒绝本机这次真正崩溃重载；不能把它归因服务端拒绝。初页记号写成与重载组装前的记号仍未记录，当前 null 不能区分浏览器丢失和应用主动清除。

取证经用户明确批准临时显示“网页开发者功能”，仅在原标签页检查器中读取 performance、目标 sessionStorage 记号与 Web Locks；没有导航、写回身份或点击编辑。读取后关闭检查器并确认设置恢复为 0。此时控制服务已清理，控制台中“无法连接服务器”的网络错误属于事后现场，不可混入初页 ready 的 pageErrors=0 结论。

### 后续决策：原页身份的设计前提

本机 Safari 的真实崩溃重载和通常的 navigate 不能仅凭现有两个导航字段区分，原页身份方案需要补足证明。建议保留已批准的自动恢复体验，先在同一 P3 分支做有明确边界的身份技术验证：

1. 比较可用的浏览上下文/历史条目标识，证明候选在原页崩溃中是否保留，以及普通打开、复制标签页、历史返回、关页重开和重登录时是否会被复制或复用；不预先认定任何单一 API 足够。
2. 补只读观测：初页持久完成后的记号、页面组装前导航与记号、首次实例锁结果、认证原件匹配结果。只记录非敏感身份与状态，不补写记号、不伪造导航、不自动 takeover。
3. 只有能同时证明原页连续性和复制页隔离，才更新身份证明设计并实现；服务端裁决、普通 acquire、原件匹配、并发栅栏和未知时保持阅读不变，再复验原有反例与真实 Safari。

若找不到可靠证明，应回到需求方讨论 Safari 明示手动恢复及范围变更，不能悄悄降低 §2.1 第 4 条的自动恢复承诺，也不能勾选 A16。按 CLAUDE.md 对意料之外高风险发现的要求，本轮先保存代码与事实，待确认调整方向后再改身份机制；不是将质量问题延期到下一 Phase。

## 验证与完成边界

新增真实崩溃场景、原崩溃套件、相关自检校准和生产自动保存模式均需零失败/重试；使用 PG 53522，不设置 CI。浏览器检查与其他检查互斥，运行时不改源码/测试/文档或提交。保留每次首轮失败、源码校验值与最终报告。

新增驱动/协议/判定代码有针对性的单元测试，完成后全项目单元/类型/lint、测试构建及生产产物边界复核；不放宽预算、时限或进程归属要求。独立审查修复复验后一次中文 S5 提交。S6 才做 Phase 总门禁、容器、架构/ADR、合并与同 SHA CI；虚拟机断电与 Safari 暂停/继续仍属于 P6。

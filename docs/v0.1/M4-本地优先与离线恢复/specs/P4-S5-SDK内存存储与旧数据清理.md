# P4-S5：SDK 内存存储与旧数据清理

状态：2026-10-14 基于 S4 `4430efbd` 完成实现、自审与 Step 验收，见 `../reviews/P4-S5-审查报告.md`。沿用已批准的 P4 §3.5 和用户自主推进授权；本 Step 完成后提交，整个 Phase 的独立审查及完整门禁仍在 S6。

## 1. 目的和事实

退出及确证账户停用时，除草稿主库、镜像和写入者之外，还要清理当前账户的保存中记号及已退役的 SDK 数据。SDK 的偏好仅在当前编辑器实例内存在，切换阅读/编辑或重新打开后不继承。本 Step 不改变恢复授权、草稿格式、密钥协议或服务端编辑权。

锁定的 Univer 1.0.1 在 UI 插件中注册 `ILocalStorageService`；核心 `Univer` 的 override 只替换其自身注册的标识，不能代替 UI 插件配置。`@univerjs/ui` 模块求值会打开 `UniverLocalStorage`，其连接没有 versionchange 关闭处理，销毁编辑器也不能关闭该模块私有连接。M4 总设计已接受这个空库事实，不修改依赖、不拦截全局 IndexedDB；被占用时如实显示未完成，关闭占用页后重试。

S4 基线的 `pending-save` 仅以文档为键；`edit-request` 已在 P3 退役为当前 Document 内存；旧 reload 记号不再用于恢复身份。当前档案只注册桌面 UI，移动端最近公式项的直接 localStorage 写入不在活动插件路径中，但其旧键仍列入清理。

## 2. 设计

### 2.1 每个编辑器的 SDK 内存存储

在 `editor/internal-api` 封装 `MemoryLocalStorageService` 和 `memoryLocalStorageOverride()`，从统一出口提供 override 给 sheet-profile 的 `UniverUIPlugin` 配置。阅读、编辑、公式 Worker/主线程变体都用同一覆盖；不把 UI 包引入公式 Worker。

实现锁定版本全部异步方法：getItem、setItem、removeItem、clear、key、keys、iterate。每个依赖注入实例有独立 Map；读写通过 structuredClone 隔离调用方可变对象，缺失返回 null，键按插入顺序遍历，iterate 从 1 开始、返回非 undefined 时终止。SDK 两种浏览器存储驱动本来就没有统一排序保证，不新增排序契约。dispose 清空 Map，后续旧回调的写入不重建数据，读为空；返回值仍保持接口，不制造未处理拒绝。

登记 API 来源、UI override 注入点、注入器销毁行为和回归。用实际 SDK 注册/获取服务证明注入位置及实例隔离；浏览器中通过真实编辑器行为证明没有新增偏好持久写入。允许 SDK 模块留下空的旧库，不能将“库存在”等同于替换失败。

### 2.2 保存中记号

新键为 `nerve-office:pending-save:<userId>:<documentId>`，值仍为 v1 的时间和基准修订。构造函数改为 `pendingSaveMarker(userId, documentId, options)`；editor-page 从建立模式时已经确认的用户传入。不同账户的同一文档互不读取/清除。旧未分用户键从不读取或迁移。

保留原 pagehide 同步写及存储不可用时退回立即接手的语义；已经知道会话停写/换人时不再补写旧记号。记号只是最多等待 30 秒的在途保存提示，不提供编辑身份或恢复资格。冻结页漏收通知时仍由原有会话确认和持久草稿栅栏约束正文写入，不新增同步认证协议。

### 2.3 精确清理清单

新增 SDK 无关的共享清理端口。只删除：

| 存储 | 范围 |
|---|---|
| localStorage | 当前 userId 的新 pending-save 前缀；旧单段 pending-save 键；`UniverLocalStorage/` 前缀；精确 `univer-mobile-recent-formula-functions`；旧 reload/edit-request 前缀 |
| 当前 Document 的 sessionStorage | 旧 reload/edit-request 前缀，以及旧单段 pending-save 和本人的 scoped pending-save |
| IndexedDB | 精确 `UniverLocalStorage` |

先收集匹配键再删除，避免浏览器在 removeItem 后重排索引而漏项。其他账户的新 pending-save、近似名称、未知键、所有其他数据库均保留。不读取旧值，不用旧记号判定归属或授权。不调用 Storage.clear、不枚举删除所有数据库。其他标签页私有的 sessionStorage 无法从本页遍历；各页启动清理自己的退役意图记号，失败不赋予任何身份，退出操作仍严格报告自己可访问存储的失败。

Storage getter、枚举、删除异常或 IDB 删除错误返回 failed；IDB blocked 或有界等待到期返回 pending。请求晚完成不能把已经返回的 pending 静默改为 cleared；下一轮按有效清理资格重新检查。浏览器无法取消已经发出的 deleteDatabase，仅允许它迟到删除这个已经退役、不承载新版本数据的精确旧库；绝不在迟到回调里继续删除用户记号或草稿。

### 2.4 和原清理资格组合

`LocalCleanupOptions.clearMetadata?: (userId: string) => Promise<MetadataCleanupOutcome>` 是无 SDK 的附加端口；`MetadataCleanupOutcome` 为 cleared、pending 或 failed(error)。低层探针不提供时仍只操作 outbox。三个生产入口统一从 browser-cleanup 组装该端口，避免某条退出/停用途径漏接。

`removeUser` 在原有同源锁内先由 retireUser 验证原许可并停写，然后执行附加清理及主库/镜像清理。附加清理失败不跳过草稿清理，也不阻止服务端退出。镜像和附加清理任何一项未完成均不能调用 finishUserCleanup；保留 clearing，下一轮使用同一原许可。新登录先换代后旧重试不得触碰任何用户键。数据库等待最多 3 秒，blocked 立即返回；不把网络放入锁内。

结果文案扩大为“本机数据”，明确尚未完成及关闭其他本站页面后重试。用户可在结果页前往登录；新登录使原操作失效。账户停用/启动重试沿用 S4 的清理资格和状态通知，不新增认证请求或首屏依赖。

## 3. 验收

- 单元：SDK 全接口、克隆/隔离/销毁；真实 UI 插件注入；pending-save 多账户及旧键拒读、已停写 pagehide；清单近似键/其他账户保留、存储异常、blocked/错误/迟到/重试；附加清理失败仍清草稿、原代次失效无副作用。
- 三浏览器：真实 SDK 偏好不跨重建持久化；完整退出清单、其他账户数据保留；真实旧库占用使退出完成但清理 pending，关闭占用页后重试成功；普通过期保留、确证停用清理和新登录使旧重试失效；现有在途保存/恢复回归。
- 生产节奏：新退出清单和 blocked 主链路在自动保存照常运行时通过。原始报告分别归档，不以重跑次数累计不同场景。
- S5 收尾：全单元、类型、lint、生产构建及原产物/体积门槛、故事登记。激活 US-M4-08 的前提是清单完整通过。完整 verify、生产容器、独立整 Phase 审查和 main 同 SHA CI 仍由 S6 验证。

## 4. 自审

- [x] 两个替代方案（核心 override、全局存储拦截）分别因注入无效及扩大影响面否决；采用已批准的 UI 注入和精确清单。
- [x] 不恢复已经退役的跨 Document 身份/意图；不存在旧记号向当前用户迁移。
- [x] blocked、不可取消请求、私有 sessionStorage 范围都有明确边界；不声称所有页面同步清空。
- [x] 无新增依赖、SDK 补丁、预算修改或范围延期；所有生产路径共用清理资格。

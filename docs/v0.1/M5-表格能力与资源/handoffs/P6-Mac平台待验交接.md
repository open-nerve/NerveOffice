# P6 Mac 平台待验交接

2026-11-04。对应 **DEF-074**。用户已批准先完成 M5 工程交付，Mac 原完整验收单列；最迟 M7 上线总验收前补验或明确裁决。M5 工程收官后停止，等待进一步安排，当前不启动 M6。

## 固定输入与已取得证据

Linux 预验收固定 `ad6e947032a2b19d6e93c4acb5548730b2a2113e`、CI94 `41682412692`：原六项、精确用例与资源原件均独立接受。当前工程接续方案提交 `712ce1d0` 只改文档；正式工程交付以最终 main 同 SHA CI 及 `central-acceptance/engineering-closeout/final-completion.json` 为准，不能用 Phase 结果代替最终 main。

下列是**尚未完成的 Mac 平台验证**，不是已知产品故障被改写为通过。P5 full04/full05、WindowServer/IOSurface 故障及旧缺失退出码保持原记录；本交接不声称故障根因已修。

| 必须补验的范围 | 已确认差异及入口 | 接受要求 |
|---|---|---|
| 原 Mac 完整 Gate | `pnpm verify`，本机 Chromium/Chrome/WebKit；CI Edge 仍在 Linux | 保留原完整步骤、用例、断言、重试判失败和覆盖率；固定源码/SDK并审查 JSON/HTML/附件，不用零散专项代签 |
| WebKit OPFS 与持久性 | `tests/e2e/support/webkit-storage.ts` 的 darwin 路径，`fixtures.ts`、crash/restart 与原 OPFS 证明 | 实际命名空间、持久数据、归档与删除结果成立；Linux 分支或单元模拟不代签 |
| 浏览器进程与钥匙串 | `browser-crash.ts`、`browser-processes.ts` 的 XPC/Networking/launchd 分支及 WebCrypto | 只操作本轮进程/资料，重开可读、整组退出、原归属与句柄检查成立；凭据由正常桌面会话提供 |
| 真实平台键盘与桌面 | `support/keyboard.ts`、read-only/input-focus/CSV 等既有用例；`desktop_session.py` | 验证真实 Mac 平台按键和会话，不把 Linux 的 UA/Meta 模拟当作本机结果；会话身份变化即停 |
| 生产容器组合 | 原 `pnpm test:e2e:container` 及固定源码/生产镜像 | 在批准的 Mac 执行环境补齐原平台组合与原资源核验，Linux 已有通过独立保留 |
| 真实 Safari 的 CSV 下载（2026-11-05 补登，M5 整体独立审查 Q-13） | `apps/web/src/features/sheet-editor/csv-download.ts` 在 click 后同步 `revokeObjectURL`；Playwright WebKit 可通过，真实 Safari 未验证 | 真实 Safari 下导出文件实际落盘且内容正确；若失败，改为下一个任务再释放对象地址并补回归，不以 WebKit 通过代签 |

Excel、真实 Safari/Finder 图片矩阵沿 **DEF-004** 与 [P2 原生待验登记](P2-原生环境待验登记.md)，不并入新的自动化豁免。**DEF-013** 的真实 macOS 输入法仍在 M6 开始前核对；M6 当前未获启动授权。M4 **DEF-073/UR-035**、M4 完整验收/标签独立保留。

## 重开前提与责任

执行责任由后续接手的开发 Agent 承担，平台/范围裁决由需求方决定；不要求用户日常手工启动脚本或交出密码。优先确定不会影响当前开发桌面的独立 Mac 环境，再给出固定输入、原范围、磁盘/内存/数据库/桌面/钥匙串和资源预检。

当前开发机的浏览器长测暂停保持。桌面会话保护只减少会话已变化后的连锁失败，不预防首次崩溃；分段执行、升级系统或 Linux 成功都不是自动恢复授权。真实 Safari 仍须解锁并在开始前空闲 120 秒，用户活动按既有规则中止。

复验经现有受管入口串行执行。失败留下必要有界报告，停止并调查；完整 VM/profile/数据库不永久复制，临时资源按归属及时清理，未知句柄或归属继续保留。最终证据须绑定受测源码、实际完整范围、原退出/清理与独立接受，确认后再关闭 DEF-074；不能仅凭 job 绿色、历史通过或环境安装成功关闭。

## 最终边界

最迟 M7 上线总验收前必须完成补验，或带精确剩余范围由需求方作明确裁决；时间到期不自动豁免。工程交付不等于 Mac/Safari 支持已完整验收，不取消任何浏览器支持或上线门槛，不打 M5 里程碑标签。即使隔离 Mac 复验通过，也只能证明该环境与输入，当前开发机 WindowServer 根因调查另行保存。

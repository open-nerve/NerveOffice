# P4-S6 CSRF 停写与确认协调复核

日期：2026-10-29。状态：局部实现、独审及三浏览器组合已通过，完整收尾尚待。本文不关闭 P4，P5 尚未开始。

## 背景与批准边界

full15 的原 Chromium CSRF 续期故事在同一次续期周期多发一次会话确认，原断言要求增量为 0、实际为 1。此前页面内去重不足以覆盖请求失效模块尚未装入的顺序。调查已提交 `b12b7636`；用户随后明确批准跨模块协调请求失效登记、查询取票和页面补核，保持原断言、草稿保护与验收门槛。旧 full15 的 395 项通过、1 项失败和未完成部分保持失败记录，不用于本修复验收。

## 实现边界

- 真实激活颁发的许可绑定轻量登记端口。请求层先同步登记原来源失效，再异步执行持久停写；原网络错误原样返回，不重发失败请求。完整协调器仍按需加载，不由 API 首屏静态装入 outbox。
- 查询在取原票和拿锁之前最多等待 3 秒。超时和取消释放本轮订阅、定时器和监听；已经登记的失效工作继续。每个当前来源只保存 preserve/disabled 两种事实及各一条在途操作。
- 查询接受和返回关联时重新核对相关、未退休的失效事实。IDB 在同一状态决策回调内同步否决后才使用原票和原 fence；失败存储不能重新关联已失效的旧许可，未落实停用不能先被重新激活覆盖。
- 明确退出、不同用户/CSRF、真实新登录按原来源和代次边界处理。原 `session-fence.ts` 未改，不给旧响应换票，不放宽跨代清理；取消仍抛原取消原因。
- 页面把本机 stopped 的补核需求与普通 checkAgain 分开，在 resumeLease 完成后查看当时许可。无许可响应的迟到来源标记只用于匹配通知，不交给 writer/reader，也不授予编辑或恢复权限。

## 独审发现与真实复现

初版 998 项通过后，独审发现 I1/I2 两处遗漏。先复现再修复，未用首次原 Chromium 通过掩盖其他顺序。

| 问题 | 原实现实际失败 | 修复与控制 |
|---|---|---|
| I1 查询先开始、相关失效后登记 | 三条单元反例：preserve 存储失败后仍关联 G1；query rejection 已暂停到 S2 后，pending/failed 的 late disabled 均被重新激活吞掉 | 接受/关联边界读取当时相关记录；原票不变。不同用户/CSRF及真实 mutation 新登录正例保留 |
| I2 已入锁但 IDB 尚未决策 | 真实 Chromium 中原生 get 成功事件先登记 disabled；前置 S2/strict/登记检查成立，后续仍返回 G3、真实 put active、没有 clearing/提交清理，最终仍 active | 同步否决放在真实 IDB decide/put 回调内；相同反例在三浏览器首次通过，且真实状态未先写 active、清理提交成立 |

原生探针只经既有测试构建入口注入 request/adopt/report 端口，调用真实 client、activation、store、锁和 IDB；不引入 fake-indexeddb，不修改 lint 规则，不替换 fence/事务。准备期间的 lint 失败如实保存，不当作行为 RED。

## 当前验证

| 范围 | 实际结果 |
|---|---|
| 关联单元 | 13 文件 / 1,005 项通过，包含原 998 项覆盖集和新增 7 项；页面 247 项、原图片交错、取消/退休/内存退路保留 |
| 静态 | web 与 E2E 类型通过；19 文件无修正 lint 零告警，diff-check 通过 |
| 生产构建与原预算 | 构建与 artifacts/budgets 通过；平台 179.9/180 KiB、编辑器 2143.2/2350 KiB、outbox Worker 15.0/15 KiB，预算未改 |
| 真实存储 | Chromium/Chrome/WebKit 各 13 项，共 39/39 首次通过，零重试、跳过、flaky；包含新增反例 3 项和原 session-fence 36 项 |
| 原交接/图片组合 | Chromium/Chrome/WebKit 各 20 项，共 60/60 首次通过；零重试、跳过、flaky、全局错误，原 CSRF/图片断言不变，439.57 秒 |
| 完整验收 | full16、container05、正常合并推送、同最终 SHA 六项 CI、冻结与实际关闭仍待；旧轮次不覆盖本次新增源码 |

## 证据与资源

主目录证据根：`.codex/handoffs/m5-p4-20261022/s6/hosted-vm-policy/final-ci-40787715273-investigation/csrf-coordination-20261029/`（下称 J）。初审 `implementation-review.md`，修复报告 `report.md`，精确交付 `fix1-final-modified-files.json`，相对独审输入补丁 `fix1-relative-to-review.patch`；最终复审入口 `fix1-implementation-review.md`，SHA `671fe26f25248c53db6d67ed173f041dd26eaf5dc183c3ce2f655177bd886c12`。独审的规格与质量结论均为 PASS，I1/I2 均 ADDRESSED，无新增 C/I/M；25 个冻结文件及 39 项真实结果逐项核对。已有证据保留实际失败与前后源码摘要，不覆写旧轮。

实现者 fix1 的 10 个受管运行已逐一核对实际 scratch、短根/别名、owner/进程组退出及锁释放；root 的构建/浏览器另有各轮 completion。真实 IDB 失败原件 `../evidence-archives/fix1-i2-red01` 约 2.1 MB，39 项 GREEN 原件 `../evidence-archives/fix1-store-green01` 约 0.75 MB，均已 seal。成功原环境已实际回收，未保留完整 VM、profile 或数据库副本；必要报告沿 14 天/5 GiB 归档策略管理。生产者和数据库退出、真实根消失与产品通过分别记录，不混写。

本机严格清理与 GitHub 托管方案 B 的责任界限保持。Excel/Safari/Finder、M4 DEF-073 等既有环境待验项按原交接保留，不能豁免本次产品缺陷或自动化失败。

60 项原件 `../evidence-archives/fix1-browser-matrix01` 已 seal，237 文件、1,803,909 B；receipt SHA `72477c0515925d283f958615c9776daea5468a576212fcfa8f6429af6b396ecd`。本轮 4,608 项源码前后一致；outer `119fe3c9-5099-44ff-af97-14ebc23b1cec` 与 inner `b8b39785-78d6-4263-863f-d2666946cfb4` 实际回收，WindowServer 989 保持。最终磁盘可用 106,944,364,544 B（约 99.6 GiB）。这组 60 项与前述 39 项相加为 99 项浏览器回归，仍不是完整本机/容器或 CI 门禁。

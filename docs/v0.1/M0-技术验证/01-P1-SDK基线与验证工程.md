# M0-P1 SDK 基线与验证工程：架构设计与实施规划

> 状态：进行中｜日期：2026-09-23｜基于代码版本：`6808cda`（main）

## 1. 目标与范围

对应 M0 总设计 §5 的 P1 一行，覆盖验证项 V01、V02：

- 建好验证工程 `spikes/m0/`，作为 P2–P6 共用的骨架；
- 锁定 SDK 版本基线，产出依赖图与许可清单，确认没有 Pro 依赖、没有远程运行依赖（V01）；
- 验证表格与文字文档编辑器在 00 号计划书 §11.3 的严格 CSP 下能否加载、编辑，包括公式 Web Worker（V02）；
- 记录包体积；顺带确认 React 版本与 Univer 的兼容性。

不在本 Phase：插件档案定稿与保存重开（P2）、图片与外部请求治理（P4）、各项功能的能力验证（P3、P5）。

## 2. 现状

- 仓库只有文档，没有任何代码；`spikes/` 尚未创建。
- **版本基线的变化**：Univer **1.0.0 正式版已于 2026-09-23 发布**（npm `latest`），晚于 00 号计划书的编写。计划书 §3.2 原定"M0 先用 rc、正式版发布后再升级"，现在直接锁定 1.0.0，不再经过 rc.0。这样做与 D2（1.0 线）的方向一致，还省去了一次升级回归；§3.2 的"M5 正式版门槛"随之满足。计划书在 M0 结束时统一更新到 r3。
- `refer/univer` 已按约定切换到 tag `v1.0.0`（d592fb7，已征得确认）。附录 B 的行号以这个 tag 为准复核。
- 本机环境：macOS 26.5.1，Apple M4 Pro，48 GiB；Node.js 24.3.0；Google Chrome 153；Safari 26.5；未安装 Edge。

## 3. 设计

### 3.1 验证工程的结构

`spikes/m0/` 是独立项目，有自己的依赖和锁文件，不属于将来的生产 workspace。

```text
spikes/m0/
├── package.json          精确版本；脚本：dev、build、serve、e2e、report:*
├── pnpm-lock.yaml
├── vite.config.ts        多页面构建：index / sheet / doc；公式 Worker 单独成块
├── index.html            实验入口：选择文档类型、样本、模式、是否启用 Worker
├── sheet.html、doc.html   编辑器页面，整页加载，一页一份文档（与 §10.2 一致）
├── src/
│   ├── host/             React 宿主：顶部状态栏 + 编辑器容器
│   ├── profiles/         候选插件档案：sheet.ts、doc.ts（插件、配置、语言包）
│   ├── harness/          创建编辑器、捕获快照、收集页面事件；向页面暴露 window.__m0
│   ├── workers/          公式 Web Worker 入口
│   └── experiments/      按验证项组织的实验代码（P1 基本不用）
├── server/serve.ts       静态服务：输出 CSP 响应头、接收 CSP 违规报告
├── scripts/              V01 依赖与许可报告、URL 扫描、包体积统计
├── e2e/                  Playwright 验证脚本；results/ 保存 JSON 结果（入库）
├── fixtures/             样本文档（P1 只放最小样本）
└── README.md             运行方式、环境要求，以及"不进入生产"的声明
```

**依赖方向**：`host` → `harness` → `profiles` → `@univerjs/*`。实验代码只通过 `harness` 使用编辑器；Playwright 只通过 `window.__m0` 和真实的键盘鼠标操作与页面交互。

### 3.2 接口约定

**页面参数**：`sheet.html?sample=<名称>&mode=edit|read&worker=0|1`，`doc.html?sample=<名称>&mode=edit|read`。

**`window.__m0`**（只供验证脚本使用）：

| 成员 | 说明 |
|---|---|
| `kind` | `'sheet'` 或 `'doc'` |
| `ready` | Promise：文档单元创建完成、首帧渲染完成后兑现 |
| `univer`、`univerAPI` | Univer 实例与 Facade，供实验直接调用 |
| `save()` | 调用 `FWorkbook.save()` / `FDocument.save()` 返回快照 |
| `events` | 页面内收集的 `securitypolicyviolation` 事件、未捕获错误、控制台错误 |

**服务端**（`server/serve.ts`，只用于验证）：

| 路径 | 说明 |
|---|---|
| `GET /*` | 提供 `dist/` 下的静态文件；HTML 响应带 CSP 头 |
| `POST /csp-report` | 接收违规报告（兼容 `application/csp-report` 与 `application/reports+json`），追加到内存列表与 `e2e/results/` 下的 JSONL |
| `GET /__csp-reports`、`DELETE /__csp-reports` | 供验证脚本读取、清空报告 |

CSP 由启动参数选择，默认同时发送两个头：

- **强制策略**（`Content-Security-Policy`）：原样使用 00 号计划书 §11.3 的策略，加上 `report-uri /csp-report`。
- **探测策略**（`Content-Security-Policy-Report-Only`）：比强制策略更严格，去掉 `style-src` 的 `'unsafe-inline'`、`img-src`/`font-src` 的 `data:`、`worker-src` 的 `blob:`。它不拦截任何东西，只用来回答"强制策略里放宽的每一项，是否真的需要"。

### 3.3 候选插件档案（P1 版）

P1 只需要一份"尽量接近最终档案"的候选集合，用来做依赖清单与 CSP 验证；档案 v1 在 P2 定稿。候选集合按 00 号计划书 §4.2、§4.3 取范围内的全部插件，按官方 preset 的注册顺序组装（插件模式，不用 presets）：

- **表格**：render、UI、docs、docs-ui、formula-engine、sheets、sheets-ui、sheets-numfmt(-ui)、sheets-formula(-ui)；drawing、drawing-ui、docs-drawing、sheets-drawing(-ui)；条件格式、数据验证、筛选、排序、查找替换、超链接、备注（note）各自的核心与 UI 插件；Worker 模式另加 rpc。
- **文字文档**：render、UI、docs、docs-ui、formula-engine（官方 docs 核心 preset 中包含，是否必需在 P5 核实）；drawing、drawing-ui、docs-drawing(-ui)；docs-hyper-link(-ui)；find-replace、docs-find-replace；docs-toc(-ui)（候选，是否纳入在 P5 决定）。
- **不纳入**：`@univerjs/network`（源码中除它自己外没有任何包使用 `IHTTPService`）、表格的 table、线程评论、十字高亮、水印、action-recorder、slides、telemetry、Vue/Web Component 适配器。

### 3.4 实验方案

**V01 版本锁定、依赖图与许可清单**

1. 安装候选集合涉及的全部 `@univerjs/*` 包，版本一律精确写为 `1.0.0`；`@univerjs/icons` 按 `@univerjs/ui` 声明的 `1.43.0` 锁定；React、react-dom `19.3.0`，rxjs `7.8.2`。
2. 版本一致性：脚本读取 `pnpm ls --prod --depth Infinity --json`，检查 `@univerjs/*` 都只有一个版本、一份实例；`react`、`rxjs`、`@wendellhu/redi` 同样不得出现多个版本（多份实例会破坏依赖注入）。
3. Pro 检查：依赖图与构建产物中搜索 `@univerjs-pro`、`univerjs-pro`，结果必须为零；同时搜索许可证校验、水印等关键字。
4. 许可清单：`pnpm licenses list --prod --json` 生成生产依赖的许可清单；按宽松许可（MIT、Apache-2.0、ISC、BSD、0BSD 等）、弱 copyleft、强 copyleft、未知分类，后三类逐个说明。
5. 远程运行依赖：
   - 静态扫描：从构建产物中提取全部绝对 URL，按主机分类，逐个说明用途（XML 命名空间、文档链接、错误信息等），找出任何会在运行时被请求的地址；
   - 动态核验：V02 的每个场景都记录页面发出的全部网络请求，非同源请求必须为零。

**V02 严格 CSP 下能否运行**

1. 以生产模式构建（`vite build`），由 `server/serve.ts` 提供，同时发送强制策略与探测策略（§3.2）。
2. Playwright 在每个浏览器中执行三个场景：
   - **表格（公式在主线程）**：加载 → 用真实键盘在单元格输入文字和公式（`=SUM(1,2)`）→ 通过 Facade 核对值与计算结果 → 打开工具栏下拉菜单与右键菜单 → 调用 `save()`；
   - **表格（公式在 Web Worker）**：同上，公式由 Worker 计算；另外核对 Worker 确实启动、确实返回了结果；
   - **文字文档**：加载 → 在正文用键盘输入英文与中文 → 使用工具栏加粗 → 通过快照核对内容 → `save()`。
3. 每个场景收集：页面内的 `securitypolicyviolation` 事件、服务端收到的报告（区分强制与探测）、未捕获错误与控制台错误、全部请求的来源。
4. 浏览器矩阵：Playwright 自带的 Chromium、本机 Google Chrome 153（`channel: 'chrome'`）、Playwright 自带的 WebKit（作为 Safari 引擎的代理）。
   - Edge 未安装；真实 Safari 需要管理员开启远程自动化。这两项登记为补充验证（见 §7），不阻塞本 Phase 的结论。
5. **通过标准**：三个浏览器的三个场景中，强制策略的违规为零，编辑与公式结果正确，非同源请求为零。否则逐条列出必须放宽的指令及原因。探测策略的报告用来说明强制策略中每一项放宽的必要性。

**包体积**：读取 Vite 的构建清单（manifest），按 `sheet.html`、`doc.html` 两个入口分别统计首屏需要的 JS、CSS 与 Worker 块，记录原始体积与 gzip 体积。

### 3.5 错误处理、安全与可观测性

- 验证工程只监听 `127.0.0.1`，不对外提供服务。
- 页面把违规事件、未捕获错误都收集到 `window.__m0.events`，验证脚本逐项断言，不依赖人工看控制台。
- 验证结果以 JSON 形式写入 `spikes/m0/e2e/results/`，并随代码入库，作为报告的证据。

## 4. 验证策略

M0 不交付产品功能，不为验证工程本身补测试（M0 总设计 §6）。本 Phase 的证据由以下脚本产出：

| 证据 | 脚本 | 对应验证项 |
|---|---|---|
| 版本一致性、Pro 检查、许可清单 | `scripts/deps-report.ts` | V01 |
| 构建产物 URL 扫描 | `scripts/url-scan.ts` | V01 |
| 三浏览器 × 三场景的 CSP 与编辑 | `e2e/v02-csp.spec.ts` | V01（动态核验）、V02 |
| 包体积 | `scripts/bundle-size.ts` | P1 产出 |

## 5. 约束符合性检查

- [x] 00 号计划书：版本锁定方式与 §3.2 的精神一致（直接锁正式版是对原计划的改进，见 §2），CSP 原样取 §11.3，不使用 presets（§3.3）、不引入 Pro；
- [x] M0 总设计：目录结构与 §6 一致；证据格式按 §7；停止规则按 §8；
- [x] ADR-001：验证工程的服务端同样使用 Node.js；
- [ ] 《工程规范与完成定义》：M1 前定稿，M0 不适用。

## 6. Step 拆分

各 Step 的任务清单见 `plans/P1-实施计划.md`。验证项的边界已在 §3.4 写清，不单独写 spec。

| Step | 目标 | 依赖 | 需要 spec | 验收 |
|---|---|---|---|---|
| S1 验证工程骨架 | 建好 `spikes/m0/`：依赖锁定、多页面构建、React 宿主、候选档案、harness、CSP 服务、Playwright 配置 | 无 | 否 | 表格与文字文档页面在开发模式和生产构建下都能加载、能输入；`window.__m0` 可用 |
| S2 V01 依赖与许可 | 版本一致性、Pro 检查、许可清单、URL 扫描 | S1 | 否 | 结果 JSON 生成；每一项都有结论 |
| S3 V02 CSP 验证 | 三浏览器 × 三场景的 CSP 与编辑验证 | S1 | 否 | 结果 JSON 生成；每个场景都有结论 |
| S4 包体积与报告 | 统计包体积；编写 `reports/P1-验证报告.md` | S2、S3 | 否 | 报告按 M0 总设计 §7 的格式写全 V01、V02 |

## 7. 风险与未决问题

| 风险 / 问题 | 应对 |
|---|---|
| 真实 Safari 与 Edge 本机无法自动化 | WebKit 与 Chromium 的引擎结论作为主要证据；真实浏览器的冒烟补测登记为延期项，在 M1 建立 E2E 浏览器矩阵时完成 |
| 构建工具与 Univer 的兼容问题（Vite 8、React 19.3） | 版本与 Univer 仓库自身使用的一致；出现问题时先查上游示例的配置 |
| CSP 违规来自构建工具而不是 SDK | 报告中区分来源；构建工具产生的问题在验证工程里解决，并记为 M1 的构建约束 |
| 1.0.0 发布当天可能有紧急修复版本 | 按 M0 总设计 §11：锁定后不跟随，除非新版本修复了阻断问题 |

## 8. 完成定义

- [ ] S1–S4 完成，验证脚本可以一键重跑
- [ ] V01、V02 的结论与证据写入 `reports/P1-验证报告.md`
- [ ] 结论审查完成，问题已修复并复验（`reviews/P1-审查报告.md`）
- [ ] 交接单已编写（`handoffs/P1-交接单.md`），延期项已登记
- [ ] M0 阶段没有架构总览可更新；对 00 号计划书的影响记录在报告中，M0 结束时统一更新到 r3

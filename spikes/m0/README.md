# M0 验证工程

> **只用于 M0 技术验证，不进入生产构建。** M1 建立生产工程时按正式流程重写，不从这里搬运代码。

对应文档：`docs/v0.1/M0-技术验证/`（总设计与各 Phase 的设计、验证报告）。

## 环境要求

- Node.js ≥ 24（服务端脚本直接以 TypeScript 运行，依赖 Node 的类型剥离）
- pnpm 12.6.0，用 `npx -y pnpm@12.6.0` 调用，不需要全局安装
- Playwright 浏览器：`npx playwright install chromium webkit`；`chrome` 项目使用本机安装的 Google Chrome

## 常用命令

```bash
npx -y pnpm@12.6.0 install --frozen-lockfile
npx vite                      # 开发模式，http://127.0.0.1:4600
npx vite build                # 生产构建到 dist/
node server/serve.ts          # 带 CSP 头的静态服务，http://127.0.0.1:4700（--csp full|off|html-only）

node scripts/deps-report.ts   # V01：版本一致性、Pro 检查、安装脚本、许可分类
node scripts/url-scan.ts      # V01：构建产物中的外部地址与联网代码（需先构建）
node scripts/bundle-size.ts   # P1：按入口统计包体积（需先构建）
npx playwright test           # 全部浏览器验证（需先构建；会自动启动 4700/4701/4702 三个服务）
node scripts/safari-selftest.ts  # 真实 Safari 自检（后台打开 Safari，结束后留下一个标签页）
```

验证结果以 JSON 写入 `e2e/results/`，随代码入库，作为验证报告的证据。

P2 起的样本与存储：

```bash
M0_BUILD_SAMPLES=check npx playwright test e2e/v03-build-samples.spec.ts --project=chromium   # 核对样本构建器与预期语义
M0_BUILD_SAMPLES=1 npx playwright test e2e/v03-build-samples.spec.ts --project=chromium       # 重新生成 fixtures（之后必须再 vite build）
```

- 文档存储（内存）：`GET/PUT /api/docs/:id`、`POST /api/docs/:id/copy?to=<新 id>`
- 页面参数：`doc=<id>` 从存储加载；`without=<组,…>` 去掉插件组；`unit=<id>` 覆盖空白样本的 unitId；`guard=1` 启用资源加载错误捕获

## 目录

| 路径 | 内容 |
|---|---|
| `src/profiles/` | 候选插件档案（表格、文字文档） |
| `src/harness/` | 创建编辑器、加载样本、收集页面事件；向页面暴露 `window.__m0` |
| `src/host/` | React 宿主页面 |
| `src/workers/` | 表格公式 Worker、文字文档排版 Worker |
| `server/` | 验证用静态服务：CSP 响应头（强制策略 + 探测策略；full / off / html-only 三种模式）、违规报告与自检结果接收 |
| `scripts/` | V01 与包体积的统计脚本、真实 Safari 自检 |
| `e2e/` | Playwright 验证脚本与结果 |
| `fixtures/` | 样本文档 |

## 页面

- `index.html`：样本列表
- `sheet.html?sample=<名称>&worker=0|1`：表格编辑器，`worker=1` 时公式在 Web Worker 中计算
- `doc.html?sample=<名称>&worker=0|1`：文字文档编辑器，`worker=1` 时排版在 Web Worker 中进行
- `csp-probe.html?target=<跨源地址>`：CSP 阳性对照，在页面与 Worker 中各发起一次跨源请求和动态代码执行
- 编辑器页面加上 `selftest=<场景>&next=<下一步>` 时进入自检模式：用 Facade 完成编辑、把结果交回服务，再跳转到下一步

每个编辑器页面整页加载，一页只承载一份文档。

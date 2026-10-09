import type { ArtifactPolicy } from './artifacts.ts'
import type { EntryBudget, WorkerBudget } from './budgets.ts'
// 门禁的策略数据（规范 §3，00 号计划书 §3.3）。每一项的新增与放宽都要写明原因，经代码审查。

/** 包管理配置的底线。 */
export const PNPM_POLICY = {
  /** 新发布的版本满 3 天才允许安装。 */
  minimumReleaseAgeMinutes: 4320,
  trustPolicy: 'no-downgrade',
} as const

/** 生产依赖允许的许可；其他许可逐个评审后才能加入。 */
export const PRODUCTION_LICENSES: readonly string[] = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']

/** 许可例外：包名、它声明的许可与接受的原因。 */
export interface LicenseException {
  name: string
  license: string
  reason: string
}

export const LICENSE_EXCEPTIONS: readonly LicenseException[] = []

/**
 * Univer 的版本基线（00 号计划书 §3.2）：协调发布的包同一个版本，独立发版的包按清单核对。
 * 1.0.1 与 1.0.0 的产物相同（内嵌的版本号除外）；1.0.0 的一部分包没有来源证明，过不了 trustPolicy（M1-P4）。
 */
export const UNIVER_POLICY = {
  version: '1.0.1',
  independent: { '@univerjs/icons': '1.43.0' } as Readonly<Record<string, string>>,
}

/**
 * 多份实例会破坏依赖注入、元数据登记或 React 上下文的包。每一项是包名，或者 `@作用域/*`（这个作用域下的每个包各只能有一份）。
 * NestJS 的依赖注入与装饰器元数据依赖 @nestjs/common、@nestjs/core 与 reflect-metadata 各只有一份；drizzle-orm 的表定义与查询要来自同一份（P2）。
 */
export const SINGLETON_PACKAGES: readonly string[] = [
  'react',
  'react-dom',
  'rxjs',
  '@wendellhu/redi',
  // Univer 的每个包都靠同一份依赖注入容器与服务标识协作（规范 §3）
  '@univerjs/*',
  '@nestjs/common',
  '@nestjs/core',
  'reflect-metadata',
  'drizzle-orm',
  // 平台前端（M1-P3）：路由与请求缓存靠 React 的上下文传递，多份实例互相看不见。
  // Radix 的组件之间共用上下文与全局状态（弹层的层级、焦点范围）；radix-ui 只是汇总包，实际的实现在各个 @radix-ui/* 包里（审查 B23）
  'react-router',
  '@tanstack/react-query',
  'radix-ui',
  '@radix-ui/*',
]

/** 产物扫描（00 号计划书 §3.3、§11.3）。 */
export const ARTIFACT_POLICY: ArtifactPolicy = {
  /**
   * 产物中允许出现的地址（审查 B21）：它们只是字符串，不会被请求。按具体地址登记，同一个主机上的其他地址仍然违规；
   * 门禁的说明会列出这次没出现的地址，依赖升级后核对，过时的删除。
   */
  allowedAddresses: [
    { address: 'http://www.w3.org/2000/svg', source: 'react-dom、lucide-react', reason: 'SVG 的命名空间：react-dom 创建 SVG 元素时用，lucide-react 写进图标的 xmlns 属性' },
    { address: 'http://www.w3.org/1998/Math/MathML', source: 'react-dom', reason: '创建 MathML 元素时用的命名空间' },
    { address: 'http://www.w3.org/1999/xlink', source: 'react-dom', reason: 'xlink:href 等属性的命名空间' },
    { address: 'http://www.w3.org/XML/1998/namespace', source: 'react-dom', reason: 'xml:base、xml:lang、xml:space 属性的命名空间' },
    { address: 'https://react.dev/errors/', source: 'react-dom', reason: '生产构建的错误信息只带错误码，拼上错误码指向错误说明页，只出现在错误信息里' },
    { address: 'http://localhost', source: 'react-router', reason: '解析相对地址时用的基准（new URL(path, "http://localhost")），只用来解析，不发请求' },
    { address: 'https://reactrouter.com/en/main/routers/picking-a-router', source: 'react-router', reason: '在数据路由之外调用数据路由的钩子时，错误信息里的文档链接' },
    { address: 'https://github.com/ungap/url-search-params', source: 'react-router', reason: '浏览器不支持 URLSearchParams 时的警告里推荐的补丁，只是文字，不加载' },
    { address: 'https://json-schema.org/draft/2020-12/schema', source: 'zod', reason: 'z.toJSONSchema() 写进 $schema 的标识（draft 2020-12）' },
    { address: 'http://json-schema.org/draft-07/schema#', source: 'zod', reason: 'z.toJSONSchema() 写进 $schema 的标识（draft-07）' },
    { address: 'http://json-schema.org/draft-04/schema#', source: 'zod', reason: 'z.toJSONSchema() 写进 $schema 的标识（draft-04）' },
    { address: 'https://tailwindcss.com', source: 'tailwindcss', reason: '样式文件开头的许可注释' },
    // ---- 表格编辑器（M1-P4，Univer 1.0.1 与它的依赖；只出现在编辑器页与公式 Worker 的产物里）----
    { address: 'https://support.microsoft.com/zh-cn/excel/functions/', prefix: true, source: '@univerjs/engine-formula', reason: '公式说明（中文）里的"教学"链接，约 500 条：显示在公式帮助里，用户点击时在新窗口打开，页面不请求' },
    { address: 'https://support.google.com/docs/answer/', prefix: true, source: '@univerjs/engine-formula', reason: '同上：没有微软文档的函数用 Google 表格的帮助页' },
    { address: 'https://www.wps.cn/learning/course/detail/id/340.html?chan=pc_kdocs_function', source: '@univerjs/engine-formula', reason: '同上：一个函数的帮助页' },
    { address: 'https://univer.ai/', source: '@univerjs/engine-formula', reason: '公式参数说明里的示例值（HYPERLINK 等），只是显示的文字' },
    { address: 'https://github.com/dream-num.png', source: '@univerjs/engine-formula', reason: 'IMAGE 参数说明里的示例值，只是显示的文字；IMAGE 只接受平台地址（P4 设计 §3.6.7）' },
    { address: 'https://example.com/api', source: '@univerjs/engine-formula', reason: 'WEBSERVICE 参数说明里的示例值，只是显示的文字' },
    { address: 'https://redi.wzhu.dev/docs/faq#could-not-find-dependency-registered-on', source: '@wendellhu/redi', reason: '依赖注入出错时错误信息里的说明链接' },
    { address: 'https://redi.wzhu.dev/en-US/docs/faq#import-scripts-of-redi-more-than-once', source: '@wendellhu/redi', reason: '同上：重复加载时的错误信息' },
    { address: 'http://sharejs.org/types/text-unicode', source: 'ot-text-unicode', reason: '协同编辑的操作类型的标识（uri 字段），不请求' },
    { address: 'http://sharejs.org/types/JSONv1', source: 'ot-json1', reason: '同上' },
    { address: 'https://github.com/dream-num/univer#text-x', source: '@univerjs/core', reason: '同上：Univer 自己的操作类型的标识' },
    { address: 'https://github.com/dream-num/univer#json-x', source: '@univerjs/core', reason: '同上' },
    { address: 'https://github.com/MikeMcl/decimal.js', source: 'decimal.js', reason: '许可注释' },
    { address: 'https://universheet.net/docs/Canvas.html', source: '@univerjs/engine-render', reason: '画布取不到数据地址时错误信息里的说明链接' },
    { address: 'http://localhost:5173', source: '@univerjs/core', reason: 'isLegalUrl 把以它开头的字符串当作合法地址（SDK 开发时的遗留），只做字符串比较，页面不请求；键入这样的文字会像其他网址一样被自动识别为链接（DEF-019、DEF-021）' },
    { address: 'http://www.w3.org/TR/REC-html40', source: '@univerjs/ui、@univerjs/sheets-ui、@univerjs/docs-ui', reason: '复制到剪贴板的 HTML 里 Excel 用的命名空间（xmlns）' },
    { address: 'http://www.w3.org/1999/xhtml', source: '@univerjs/sheets-ui', reason: 'XHTML 的命名空间' },
    { address: 'https://example.com/a-b.svg', source: '@univerjs/design 的样式', reason: '样式里一个生成出来却没有元素使用的背景图工具类（univer-bg-[url(…)]）；万一用到，CSP 的 img-src 只允许本站' },
    // ---- 平台自己的代码 ----
    {
      address: 'https://relative-link.invalid',
      source: '@nerve-office/contracts 的链接地址判定（documents/link-address.ts，编辑器页的链接改写器经 normalizeCellLinks 用它，M3-P3 S2）',
      reason: '本站相对地址（/…）按它解析、再比较来源是否不变（new URL(path, 它)），只用来解析与比较，不发请求；.invalid 按 RFC 2606 不会解析成任何主机。先例是 react-router 的 http://localhost',
    },
  ],
  /**
   * `Function('return this')()` 这类全局对象探测的次数上限。
   * M0 在 Univer 的产物里见过 3 处（lodash），运行时会被短路（M0-P1 报告 §2）；M1-P4 的实际产物是 2 处（编辑器页与公式 Worker 各一处）。
   */
  globalThisProbeMax: 2,
  /**
   * 已登记的动态代码（P3 设计 §3.7，审查 B3）：都来自 zod 4 的 JIT。
   * zod 在创建对象结构时读取 jitless；前端入口第一个引入的模块就设置 jitless（ADR-008），在任何结构创建之前，
   * 所以探测与编译器都执行不到。万一执行，CSP 里没有 'unsafe-eval'，浏览器会拦下。
   */
  knownDynamicCode: [
    {
      name: 'zod 的 JIT 探测',
      reason: 'zod 检测能否执行动态代码：用函数体为空的 Function(\'\') 试一下，不执行任何代码；jitless 时跳过',
      pattern: /(?<![\w$])Function\(\s*(["'`])\1\s*\)/,
      max: 1,
    },
    {
      name: 'zod 的 JIT 编译器',
      reason: 'zod 为对象结构生成解析函数（Doc.compile：先把 Function 赋给变量，再 new 出生成的代码）。只在 JIT 打开且探测成功时调用，jitless 下执行不到',
      pattern: /compile\(\)\{(?:let|const|var) ([\w$]+)=Function,[\w$]+=this\?\.content\?\?\[(?:""|''|``)\];return new \1\(\.\.\.Object\.keys\(this\.closed\),`return function \(/,
      max: 1,
    },
  ],
  /**
   * 出现即违规的关键字（不区分大小写；只扫描生产构建 apps/web/dist）：Pro、许可证校验、第三方统计与遥测上报；
   * 以及编辑器的 E2E 探针挂在 window 上的名字（M2-P3 设计 §3.7）、页面自检结果的格式标识（M3-P2 设计 §3.5，
   * editor/testing/selftest-report.ts 的 SELFTEST_REPORT_FORMAT）与切换的计时挂在 window 上的名字（editor/testing/switch-timing.ts 的
   * SWITCH_TIMING_OPTIONS，M3-P2 复核 B2）、自动保存的控制挂在 window 上的名字与它在 sessionStorage 里的键（editor/testing/autosave-control.ts，
   * M3-P4 设计 §3.14）、交接日志挂在 window 上的名字（editor/testing/handover-log.ts，M3-P5 设计 §3.13）、发件箱的浏览器层探针与崩溃用例的探针
   * 挂在 window 上的名字（features/sheet-editor/outbox/testing/outbox-probe.ts、crash-probe.ts，M4-P1 设计 §3.1、§3.7）：它们只在测试构建里（dist-e2e），
   * 生产构建里连名字都不能有。
   * 测试专用的模块主要按来源认（artifacts.ts 的 TEST_ONLY_SOURCES），这几个名字是兜底
   */
  forbiddenKeywords: ['univerjs-pro', 'univer-pro', 'licensekey', 'license-key', 'license_key', 'posthog', 'sentry', 'google-analytics', 'googletagmanager', 'gtag(', 'mixpanel', 'grpc', 'protobuf', '__nerveEditorProbe', 'nerve-office.editor-selftest', '__nerveSwitchTiming', '__nerveAutosaveControl', 'nerve-office.autosave-hold', '__nerveHandoverLog', '__nerveOutboxProbe', '__nerveCrashProbe'],
}

/** 漏洞扫描的例外：GHSA 编号、原因与到期日（到期后必须重新评审）。 */
export interface AuditException {
  id: string
  reason: string
  expires: string
}

export const AUDIT_EXCEPTIONS: readonly AuditException[] = []

/**
 * 各入口首屏 JS（gzip）的预算（规范 §11）：在建立入口的 Phase 里定下，调整要在 Phase 设计里写明原因。
 * 平台页面（M1-P3）：收尾时门禁实测 147.7 KiB，预算比实测多约 22%。主要构成约为 react-dom 65、React Router 31、
 * contracts 与 zod 26、TanStack Query 11、tailwind-merge 9、应用代码 7。
 * 以后需要瘦身时，可以按路由懒加载，或者让 contracts 改用 zod/mini。表格编辑器页在 M1-P4 加上。
 * 平台页面的首屏另限定文件数（M2-P6 复核第三批 S-b）：入口块与它和编辑器页共用的那一块，共 2 个。只给平台页面用的模块经两个入口
 * 共用的模块转出时（第二批找出的那种回退），入口会多出两个小块（实测 4 个文件），体积只多约 1.6 KiB、还在预算之内，lint 也只拦得住
 * 经 shared/api/index.ts 转出这一条路，这里从结果上兜住
 */
export const ENTRY_BUDGETS: readonly EntryBudget[] = [
  { entry: 'index.html', label: '平台页面', maxGzipBytes: 180 * 1024, maxInitialFiles: 2, reason: 'M1-P3 收尾时门禁实测 147.7 KiB，预算比实测多约 22%；首屏 2 个文件（入口块与和编辑器页共用的块，M2-P6 复核第三批 S-b）' },
  { entry: 'editor.html', label: '表格编辑器页', maxGzipBytes: 2350 * 1024, reason: 'M1-P4：生产档案 sheet@1 实测 1991 KiB（Univer 约占九成，与 M0 候选档案的 1.93–1.96 MiB 相当），预算比实测多约 18%' },
]

/** 入口在启动时就创建的 Worker（P4 设计 §3.9）：Worker 脚本随页面加载下载，另列一项。 */
export const WORKER_BUDGETS: readonly WorkerBudget[] = [
  { entry: 'editor.html', worker: 'formula.worker', label: '公式 Worker', maxGzipBytes: 800 * 1024, reason: 'M1-P4：实测 673 KiB，预算比实测多约 19%' },
]

/** 平台页面的入口：它的产物（含与编辑器页共用的块）里的地址只按具体地址放行 */
export const PLATFORM_ENTRIES: readonly string[] = ['index.html']

/** 编辑器页的入口：它能加载到的产物与它创建的 Worker 里，地址可以按 ARTIFACT_POLICY 的前缀登记放行 */
export const EDITOR_ENTRIES: readonly string[] = ['editor.html']

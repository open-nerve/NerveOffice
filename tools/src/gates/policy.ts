import type { ArtifactPolicy } from './artifacts.ts'
import type { EntryBudget } from './budgets.ts'
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

/** Univer 的版本基线（00 号计划书 §3.2）：协调发布的包同一个版本，独立发版的包按清单核对。 */
export const UNIVER_POLICY = {
  version: '1.0.0',
  independent: { '@univerjs/icons': '1.43.0' } as Readonly<Record<string, string>>,
}

/**
 * 多份实例会破坏依赖注入、元数据登记或 React 上下文的包；每个 `@univerjs/*` 包同样只能有一份。
 * NestJS 的依赖注入与装饰器元数据依赖 @nestjs/common、@nestjs/core 与 reflect-metadata 各只有一份；drizzle-orm 的表定义与查询要来自同一份（P2）。
 */
export const SINGLETON_PACKAGES: readonly string[] = [
  'react',
  'react-dom',
  'rxjs',
  '@wendellhu/redi',
  '@nestjs/common',
  '@nestjs/core',
  'reflect-metadata',
  'drizzle-orm',
  // 平台前端（M1-P3）：路由与请求缓存靠 React 的上下文传递，多份实例互相看不见；Radix 的组件也共用上下文
  'react-router',
  '@tanstack/react-query',
  'radix-ui',
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
  ],
  /**
   * `Function('return this')()` 这类全局对象探测的次数上限。
   * M0 在 Univer 的产物里见过 3 处（lodash），运行时会被短路（M0-P1 报告 §2）。
   */
  globalThisProbeMax: 3,
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
  /** 出现即违规的关键字（不区分大小写）：Pro、许可证校验、第三方统计与遥测上报。 */
  forbiddenKeywords: ['univerjs-pro', 'univer-pro', 'licensekey', 'license-key', 'license_key', 'posthog', 'sentry', 'google-analytics', 'googletagmanager', 'gtag(', 'mixpanel', 'grpc', 'protobuf'],
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
 * 平台页面（M1-P3）：实测约 152 KiB，其中 react-dom 65、React Router 31、contracts 与 zod 26、TanStack Query 11、
 * tailwind-merge 9、应用代码 7；留约 15% 的余量。以后需要瘦身时，可以按路由懒加载，或者让 contracts 改用 zod/mini。
 * 表格编辑器页在 M1-P4 加上。
 */
export const ENTRY_BUDGETS: readonly EntryBudget[] = [
  { entry: 'index.html', label: '平台页面', maxGzipBytes: 180 * 1024, reason: 'M1-P3 实测约 152 KiB，留约 15% 的余量' },
]

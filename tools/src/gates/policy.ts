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

/** 多份实例会破坏依赖注入或 React 上下文的包；每个 `@univerjs/*` 包同样只能有一份。 */
export const SINGLETON_PACKAGES: readonly string[] = ['react', 'react-dom', 'rxjs', '@wendellhu/redi']

/** 产物扫描（00 号计划书 §3.3、§11.3）。 */
export const ARTIFACT_POLICY = {
  /** 产物中允许出现的绝对地址的主机：它们只是字符串，不会被请求。 */
  allowedHosts: {
    'react.dev': 'React 错误信息里的文档链接',
    'www.w3.org': 'XML、SVG 与 MathML 的命名空间标识',
  } as Readonly<Record<string, string>>,
  /**
   * `Function('return this')()` 这类全局对象探测的次数上限。
   * M0 在 Univer 的产物里见过 3 处（lodash），运行时会被短路（M0-P1 报告 §2）。
   */
  globalThisProbeMax: 3,
  /** 出现即违规的关键字（不区分大小写）：Pro、许可证校验、第三方统计与遥测上报。 */
  forbiddenKeywords: ['univerjs-pro', 'univer-pro', 'licensekey', 'license-key', 'license_key', 'posthog', 'sentry', 'google-analytics', 'googletagmanager', 'gtag(', 'mixpanel', 'grpc', 'protobuf'] as readonly string[],
}

/** 漏洞扫描的例外：GHSA 编号、原因与到期日（到期后必须重新评审）。 */
export interface AuditException {
  id: string
  reason: string
  expires: string
}

export const AUDIT_EXCEPTIONS: readonly AuditException[] = []

/**
 * 启动时等检查结果的时限：与就绪检查相同，数据库连不上时不能把开始监听拖到连接超时（审查 A4）
 */
export const STARTUP_CHECK_WAIT_MS = 2_000

/** 一次启动自检的结果：查到了，或者查询失败 */
export type StartupCheckOutcome<T> = { readonly value: T } | { readonly error: unknown }

export interface StartupCheck<T> {
  /** 查询（例如问数据库） */
  readonly run: () => Promise<T>
  /** 有了结果（查到或失败）：记日志 */
  readonly report: (outcome: StartupCheckOutcome<T>) => void
  /** 超过时限还没有结果：先照常启动（记一条说明），结果出来之后照样交给 report */
  readonly slow: () => void
}

/**
 * 启动自检的共同做法（审计表的保护 AuditProtectionCheck、本机密钥的主密钥 MasterKeyCheck，M3-P6 设计 §3.4）：只记日志、不阻止启动；
 * 最多等 STARTUP_CHECK_WAIT_MS，超过时照常启动，查询有了结果再记
 */
export async function runStartupCheck<T>(check: StartupCheck<T>): Promise<void> {
  const outcome: Promise<StartupCheckOutcome<T>> = (async () => check.run())().then(value => ({ value }), (error: unknown) => ({ error }))
  let timer: NodeJS.Timeout | undefined
  const waited = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, STARTUP_CHECK_WAIT_MS, undefined)
  })
  try {
    const settled = await Promise.race([outcome, waited])
    if (settled !== undefined) {
      check.report(settled)
      return
    }
  }
  finally {
    clearTimeout(timer)
  }
  check.slow()
  void outcome.then(settled => check.report(settled))
}

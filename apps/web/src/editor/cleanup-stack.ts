// 逐步创建的资源的清理（审查 B8）：每创建一样就登记它的清理，失败或销毁时按创建的相反顺序清理。
// 一项清理出错不妨碍其余各项（例如 Univer 销毁时出错，Worker 照样终止），错误交给浏览器的错误报告

export interface CleanupStack {
  /** 登记刚创建的资源的清理 */
  readonly defer: (step: () => void) => void
  /** 按登记的相反顺序清理；清理过的不再清理 */
  readonly run: () => void
}

export function createCleanupStack(report: (error: unknown) => void = error => reportError(error)): CleanupStack {
  const steps: Array<() => void> = []
  return {
    defer(step) {
      steps.push(step)
    },
    run() {
      for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
        try {
          step()
        }
        catch (error) {
          report(error)
        }
      }
    },
  }
}

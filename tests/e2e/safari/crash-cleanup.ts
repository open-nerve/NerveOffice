/** 逐项尝试回收；一项失败不会跳过后续项。只返回固定步骤名，底层错误可能含敏感环境信息。 */
export async function settleCrashCleanup(steps: readonly { readonly name: string, readonly run: () => void | Promise<void> }[]): Promise<string[]> {
  const failed: string[] = []
  for (const step of steps) {
    try {
      await step.run()
    }
    catch {
      failed.push(step.name)
    }
  }
  return failed
}

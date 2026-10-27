// 只保留检查操作与内核错误码；第三方异常的正文、路径、环境和命令行不进入 CI 诊断。
import { constants } from 'node:os'
import { z } from 'zod'

const operations = ['stat-process', 'read-process', 'parse-process', 'list-processes', 'read-environment', 'signal-process', 'unclassified'] as const
type Operation = typeof operations[number]
export const failureStageSchema = z.enum(['prepare', 'run', 'settle', 'reports', 'diagnostics', 'unknown'])
const systemCodes = new Set(Object.keys(constants.errno))
export const processDiagnosticSchema = z.object({
  operation: z.enum(operations),
  code: z.string().refine(code => code === 'UNKNOWN' || systemCodes.has(code)),
  pid: z.number().int().positive().optional(),
})
export const processFailureSchema = processDiagnosticSchema.extend({ at: z.number(), stage: failureStageSchema })

class ProcessInspectionError extends Error {
  readonly diagnostic: z.infer<typeof processDiagnosticSchema>
  readonly code: string

  constructor(operation: Operation, error: unknown, pid?: number) {
    super('Linux 进程检查失败；不能宣告已无写入者')
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && systemCodes.has(error.code)
      ? error.code
      : 'UNKNOWN'
    this.code = code
    this.diagnostic = { operation, code, ...(pid === undefined ? {} : { pid }) }
  }
}

export function inspectProcessOperation<T>(operation: Operation, action: () => T, pid?: number): T {
  try {
    return action()
  }
  catch (error) {
    if (error instanceof ProcessInspectionError)
      throw error
    throw new ProcessInspectionError(operation, error, pid)
  }
}

export function processDiagnostic(error: unknown): z.infer<typeof processDiagnosticSchema> {
  return error instanceof ProcessInspectionError ? { ...error.diagnostic } : { operation: 'unclassified', code: 'UNKNOWN' }
}

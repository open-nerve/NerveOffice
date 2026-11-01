// 只保留检查操作、内核错误码与有界身份字段；外来正文/命令名/路径/环境不进入诊断。
import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import { z } from 'zod'

const operations = ['open-process', 'stat-process', 'read-process', 'close-process', 'parse-process', 'list-processes', 'read-environment', 'signal-process', 'unclassified'] as const
type Operation = typeof operations[number]
export const failureStageSchema = z.enum(['prepare', 'run', 'settle', 'reports', 'diagnostics', 'unknown'])
const systemCodes = new Set(Object.keys(constants.errno))
export const processStates = ['R', 'S', 'D', 'T', 't', 'X', 'Z', 'P', 'I'] as const
const invalid = z.literal('invalid')
const unsigned = z.number().int().nonnegative()
const groupNumber = z.number().int().min(-1)
const observationSchema = z.object({
  bytes: unsigned.max(4097),
  overflow: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fields: unsigned.max(4097),
  structure: z.boolean(),
  pid: z.union([z.number().int().positive(), invalid]),
  uid: z.union([unsigned, invalid]),
  pidMatches: z.union([z.boolean(), invalid]),
  state: z.union([z.enum(processStates), invalid]),
  parent: z.union([unsigned, invalid]),
  group: z.union([groupNumber, invalid]),
  session: z.union([groupNumber, invalid]),
  threads: z.union([unsigned, invalid]),
  start: z.union([invalid, z.string().regex(/^\d{1,20}$/).refine(value => /^\d{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n)]),
})
const statDiagnosticSchema = z.object({
  reason: z.enum(['invalid-structure', 'invalid-state', 'invalid-fields', 'invalid-identity', 'pid-mismatch', 'invalid-group', 'record-too-large', 'exit-unresolved', 'observation-deadline', 'observation-io']),
  observations: z.array(observationSchema).max(3),
})
export type StatObservation = z.infer<typeof observationSchema>
type StatDiagnostic = z.infer<typeof statDiagnosticSchema>
const diagnosticFields = z.object({
  operation: z.enum(operations),
  code: z.string().refine(code => code === 'UNKNOWN' || systemCodes.has(code)),
  pid: z.number().int().positive().optional(),
  stat: statDiagnosticSchema.optional(),
})
const bounded = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 2048
export const processDiagnosticSchema = diagnosticFields.refine(bounded)
// 固定阶段各一个槽，每槽 <= 2 KiB，因此合计严格小于 16 KiB。
export const processFailureSchema = diagnosticFields.extend({ at: z.number(), stage: failureStageSchema }).refine(bounded)

class ProcessInspectionError extends Error {
  readonly diagnostic: z.infer<typeof processDiagnosticSchema>
  readonly code: string

  constructor(diagnostic: z.infer<typeof processDiagnosticSchema>) {
    super('Linux 进程检查失败；不能宣告已无写入者')
    this.diagnostic = processDiagnosticSchema.parse(diagnostic)
    this.code = this.diagnostic.code
  }
}

export function inspectProcessOperation<T>(operation: Operation, action: () => T, pid?: number): T {
  try {
    return action()
  }
  catch (error) {
    if (error instanceof ProcessInspectionError)
      throw error
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && systemCodes.has(error.code)
      ? error.code
      : 'UNKNOWN'
    throw new ProcessInspectionError({ operation, code, ...(pid === undefined ? {} : { pid }) })
  }
}

export function processDiagnostic(error: unknown): z.infer<typeof processDiagnosticSchema> {
  return error instanceof ProcessInspectionError ? processDiagnosticSchema.parse(error.diagnostic) : { operation: 'unclassified', code: 'UNKNOWN' }
}

/** 只接受本模块固定字段，不把 parser 的异常正文包装进诊断。 */
export function statInspectionFailure(reason: StatDiagnostic['reason'], observations: readonly StatObservation[], pid?: number): Error {
  return new ProcessInspectionError({ operation: 'parse-process', code: 'UNKNOWN', ...(pid === undefined ? {} : { pid }), stat: { reason, observations: [...observations] } })
}

/** 消歧中途的 I/O 失败保留先前观察，同时保持真实失败操作和 errno。 */
export function withStatObservations(error: unknown, observations: readonly StatObservation[]): Error {
  return new ProcessInspectionError({ ...processDiagnostic(error), stat: { reason: 'observation-io', observations: [...observations] } })
}

import { z } from 'zod'

const number = z.number().finite().nonnegative()
const operation = z.enum(['write', 'read'])
const error = z.strictObject({ name: z.string().min(1).max(128) })
const failure = z.strictObject({ outcome: z.literal('error'), error })
const booleanResult = z.union([z.strictObject({ outcome: z.literal('completed'), value: z.boolean() }), failure])
const estimate = z.strictObject({ usage: number, quota: number, usageDetails: z.record(z.string(), number).optional() })
const estimateResult = z.union([z.strictObject({ outcome: z.literal('completed'), value: estimate }), failure])
const step = z.enum(['getDirectory', 'getFileHandle', 'createSyncAccessHandle', 'truncate', 'write', 'flush', 'read', 'close', 'cleanupClose'])
const opfs = z.strictObject({
  operation,
  stages: z.array(step).max(9),
  matched: z.boolean().nullable(),
  bytes: number.nullable(),
  readBytes: number.optional(),
  outcome: z.enum(['completed', 'error']),
  error: error.extend({ stage: step }).optional(),
  cleanupFailed: z.literal(false).optional(),
})
const indexedDB = z.union([
  z.strictObject({ outcome: z.literal('completed'), value: z.union([
    z.strictObject({ outcome: z.literal('completed'), matched: z.boolean() }),
    z.strictObject({ outcome: z.literal('missing'), upgradedThenAborted: z.literal(true) }),
  ]) }),
  failure,
])
const report = z.strictObject({
  startedAt: number,
  finishedAt: number,
  userAgent: z.string().min(1).max(1000),
  secureContext: z.literal(true),
  origin: z.url(),
  operation,
  persistedBefore: booleanResult,
  persist: booleanResult,
  persistedAfter: booleanResult,
  estimate: estimateResult,
  estimateAfter: estimateResult,
  opfs,
  indexedDB,
  visibility: z.array(z.strictObject({ at: number, state: z.literal('visible') })).min(1),
})

/** 观测完整不等于支持或永久保留；拒绝缺失、超时和伪造的成功阶段。 */
export function storageBoundaryResultsValid(value: unknown): boolean {
  const parsed = report.safeParse(value)
  if (!parsed.success)
    return false
  const data = parsed.data
  if (data.finishedAt < data.startedAt || data.opfs.operation !== data.operation)
    return false
  const expected = ['getDirectory', 'getFileHandle', 'createSyncAccessHandle', ...(data.operation === 'write' ? ['truncate', 'write', 'flush'] : []), 'read', 'close']
  const actual = data.opfs.stages.filter(stage => stage !== 'cleanupClose')
  if (!actual.every((stage, index) => stage === expected[index]))
    return false
  if (data.opfs.outcome === 'completed') {
    return data.opfs.error === undefined && data.opfs.stages.length === expected.length && actual.length === expected.length
      && data.opfs.matched !== null && data.opfs.readBytes !== undefined
      && (data.operation === 'write' ? data.opfs.bytes !== null : data.opfs.bytes === null)
  }
  return data.opfs.error !== undefined && [expected[actual.length], actual.at(-1)].includes(data.opfs.error.stage)
}

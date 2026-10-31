// /proc 身份读取的唯一边界：过渡记录不是不存在，也不是可授权发信号的身份。
import type { StatObservation } from './e2e-diagnostics.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { inspectProcessOperation, processDiagnostic, processStates, statInspectionFailure, withStatObservations } from './e2e-diagnostics.ts'

export const identitySchema = z.object({ pid: z.number().int().positive(), start: z.string().regex(/^\d+$/), uid: z.number().int().nonnegative(), group: z.number().int().positive() })
export type Identity = z.infer<typeof identitySchema>
export interface ProcessRow extends Identity { parent: number, state: string }

const RECORD_LIMIT = 4096
const OBSERVATIONS = 3
const DISAMBIGUATION_MS = 25

function integer(value: string | undefined, minimum: number): number | 'invalid' {
  const number = Number(value)
  return value !== undefined && /^-?\d+$/.test(value) && Number.isSafeInteger(number) && number >= minimum ? number : 'invalid'
}

function inspectStat(input: Buffer, uid: number, expectedPid?: number): { observation: StatObservation, row?: ProcessRow, sentinel?: true } {
  // 公共 parser 也只保留有界前缀；overflow 的摘要不冒称完整超长记录。
  const bytes = input.subarray(0, RECORD_LIMIT + 1)
  const overflow = bytes.length > RECORD_LIMIT
  const space = bytes.indexOf(0x20)
  const end = bytes.lastIndexOf(0x29)
  const prefix = bytes.subarray(0, Math.max(0, space)).toString('latin1')
  const tail = bytes.subarray(end + 2).toString('latin1')
  const fields = tail.endsWith('\n') ? tail.slice(0, -1).split(' ') : tail.split(' ')
  const structure = space > 0 && bytes[space + 1] === 0x28 && end > space + 1
    && bytes[end + 1] === 0x20 && /^\d+$/.test(prefix)
    && !bytes.subarray(space + 2, end).includes(0)
    && tail.endsWith('\n') && fields.length === 50
  const pid = integer(prefix, 1)
  const state = processStates.find(value => value === fields[0]) ?? 'invalid'
  const parent = integer(fields[1], 0)
  const group = integer(fields[2], -1)
  const session = integer(fields[3], -1)
  const threads = integer(fields[17], 0)
  const rawStart = fields[19] ?? ''
  const start = /^\d{1,20}$/.test(rawStart) && BigInt(rawStart) <= 18446744073709551615n ? rawStart : 'invalid'
  const observation: StatObservation = {
    bytes: bytes.length,
    overflow,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    fields: fields.length,
    structure,
    pid,
    uid: Number.isSafeInteger(uid) && uid >= 0 ? uid : 'invalid',
    pidMatches: expectedPid === undefined || pid === 'invalid' ? 'invalid' : pid === expectedPid,
    state,
    parent,
    group,
    session,
    threads,
    start,
  }
  function fail(reason: Parameters<typeof statInspectionFailure>[0]): never {
    throw statInspectionFailure(reason, [observation], expectedPid)
  }
  if (overflow)
    fail('record-too-large')
  if (!structure)
    fail('invalid-structure')
  if (state === 'invalid')
    fail('invalid-state')
  if (!fields.slice(1).every(value => /^-?\d{1,20}$/.test(value)
    && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 18446744073709551615n)
  || parent === 'invalid' || threads === 'invalid' || start === 'invalid') {
    fail('invalid-fields')
  }
  if (pid === 'invalid' || observation.uid === 'invalid')
    fail('invalid-identity')
  if (expectedPid !== undefined && pid !== expectedPid)
    fail('pid-mismatch')
  if (group === -1 && session === -1 && parent === 0 && threads === 0)
    return { observation, sentinel: true }
  if (group === 'invalid' || group < 0 || session === 'invalid' || session < 0)
    fail('invalid-group')
  // 完整结构/状态/身份均验证后，才过滤不可授权的内核任务。
  if (group === 0)
    return { observation }
  return { observation, row: { pid, uid, group, parent, start, state } }
}

/** comm 可包含任意非 NUL 字节（包括括号/换行/非 UTF-8）；仅前后 ASCII 字段决定身份。 */
export function parseProcessStat(text: string | Buffer, uid: number, expectedPid?: number): ProcessRow | undefined {
  const result = inspectStat(Buffer.isBuffer(text) ? text : Buffer.from(text), uid, expectedPid)
  if (result.sentinel)
    throw statInspectionFailure('exit-unresolved', [result.observation], expectedPid)
  return result.row
}

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')
}

function readStat(pid: number, uid?: number): ReturnType<typeof inspectStat> | undefined {
  const fd = inspectProcessOperation('open-process', () => openSync(`/proc/${pid}/stat`, 'r'), pid)
  try {
    const actualUid = inspectProcessOperation('stat-process', () => fstatSync(fd).uid, pid)
    if (!Number.isSafeInteger(actualUid) || actualUid < 0)
      throw statInspectionFailure('invalid-identity', [], pid)
    if (uid !== undefined && actualUid !== uid)
      return undefined
    const bytes = Buffer.alloc(RECORD_LIMIT + 1)
    let count = 0
    while (count < bytes.length) {
      const read = inspectProcessOperation('read-process', () => readSync(fd, bytes, count, bytes.length - count, null), pid)
      if (read === 0)
        break
      count += read
    }
    return inspectStat(bytes.subarray(0, count), actualUid, pid)
  }
  finally {
    // close 失败也不能解释成进程消失，或被一个更早的 ENOENT 掩盖。
    inspectProcessOperation('close-process', () => closeSync(fd), pid)
  }
}

export function readProcess(pid: number, uid?: number): ProcessRow | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0)))
    throw statInspectionFailure('invalid-identity', [], Number.isSafeInteger(pid) && pid > 0 ? pid : undefined)
  const observations: StatObservation[] = []
  let deadline: number | undefined
  for (let attempt = 0; attempt < OBSERVATIONS; attempt++) {
    if (deadline !== undefined && performance.now() >= deadline)
      throw statInspectionFailure('observation-deadline', observations, pid)
    let result: ReturnType<typeof readStat>
    try {
      result = readStat(pid, uid)
    }
    catch (error) {
      const diagnostic = processDiagnostic(error)
      if (diagnostic.stat !== undefined)
        observations.push(...diagnostic.stat.observations)
      if (deadline !== undefined && performance.now() >= deadline)
        throw statInspectionFailure('observation-deadline', observations, pid)
      if (diagnostic.stat !== undefined)
        throw statInspectionFailure(diagnostic.stat.reason, observations, pid)
      // 只有进程打开/读/查询的真实不存在；close 的异常仍阻断。
      if (absent(error) && diagnostic.operation !== 'close-process')
        return undefined
      if (observations.length > 0)
        throw withStatObservations(error, observations)
      throw error
    }
    if (result !== undefined)
      observations.push(result.observation)
    if (deadline !== undefined && performance.now() >= deadline)
      throw statInspectionFailure('observation-deadline', observations, pid)
    if (!result?.sentinel)
      return result?.row
    // 正常首次读取不附加新的时延失败条件，只有已验证的过渡状态进入消歧。
    deadline ??= performance.now() + DISAMBIGUATION_MS
  }
  throw statInspectionFailure('exit-unresolved', observations, pid)
}

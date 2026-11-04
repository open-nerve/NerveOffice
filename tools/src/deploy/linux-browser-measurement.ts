import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

export type MeasurementStage = 'daemon' | 'container-size' | 'scratch-size' | 'volume-size' | 'filesystem' | 'container-stats' | 'sample-log' | 'budget'

const reasons = new Set([
  'linux-measurement-stderr',
  'linux-daemon-changed',
  'linux-container-replaced',
  'linux-du-format',
  'linux-volume-measurement',
  'linux-stats-format',
  'linux-measurement-log-budget',
  'container-oom',
  'environment-budget',
  'disk-reserve',
  'measurement-invalid',
])
const errorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOMEM', 'ENOSPC', 'EPIPE', 'EIO', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])
const signals = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS'])
const PREFIX_BYTES = 64 * 1024
const executeFile = promisify(execFile)

export async function measurementCommand(command: string, args: readonly string[]): Promise<string> {
  const result = await executeFile(command, args, { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 })
  if (result.stderr.trim())
    throw Object.assign(new Error('linux-measurement-stderr'), { code: 0, stdout: result.stdout, stderr: result.stderr })
  return result.stdout.trim()
}

function streamSummary(value: unknown) {
  const bytes = typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 0
  // Limit the temporary encoding allocation too; never serialize raw output.
  const prefix = typeof value === 'string'
    ? Buffer.from(value.slice(0, PREFIX_BYTES)).subarray(0, PREFIX_BYTES)
    : Buffer.isBuffer(value) ? value.subarray(0, PREFIX_BYTES) : Buffer.alloc(0)
  const text = prefix.toString('utf8')
  return {
    bytes,
    hashedBytes: prefix.length,
    sha256: createHash('sha256').update(prefix).digest('hex'),
    truncated: bytes > prefix.length,
    mentionsMissingEntry: /no such file or directory/i.test(text),
    mentionsPermissionDenied: /permission denied/i.test(text),
  }
}

export function measurementFailureDetail(stage: MeasurementStage, error: unknown) {
  const fields = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
  const reason = typeof fields.message === 'string' && reasons.has(fields.message)
    ? fields.message
    : fields.name === 'ZodError' ? 'output-schema-invalid' : 'command-failed'
  return {
    stage,
    reason,
    exitCode: typeof fields.code === 'number' && Number.isInteger(fields.code) && fields.code >= 0 && fields.code <= 255 ? fields.code : null,
    errorCode: typeof fields.code === 'string' && errorCodes.has(fields.code) ? fields.code : null,
    signal: typeof fields.signal === 'string' && signals.has(fields.signal) ? fields.signal : null,
    killed: fields.killed === true,
    stdout: streamSummary(fields.stdout),
    stderr: streamSummary(fields.stderr),
  }
}

export function recordMeasurementFailure(stage: MeasurementStage, error: unknown, write: (detail: ReturnType<typeof measurementFailureDetail>) => void, stop: () => void): boolean {
  try {
    write(measurementFailureDetail(stage, error))
    return true
  }
  catch {
    return false
  }
  finally {
    stop()
  }
}

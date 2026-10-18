import type { ChildProcess } from 'node:child_process'
import type { ImageProcessingInput, ProcessedImage } from './image-types.ts'
import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ASSET_INVALID_RULES } from '@nerve-office/contracts'
import { AppError } from '../../shared/errors/app-error.ts'
import { imageAborted, imageBusy } from './image-admission.ts'
import { isMessage, validateImageInput } from './image-process-protocol.ts'
import { IMAGE_LIMITS, validateProcessedImage } from './image-types.ts'

export interface ImageChildEntry { readonly script: URL, readonly args?: readonly string[] }
export interface ImageRunnerOptions {
  readonly entry?: ImageChildEntry
  /** 测试可缩短时限，不能大于 ADR 的生产硬上限；不是运维配置。 */
  readonly executionMs?: number
  /** 缺失/不可用必须启动失败，用于部署检查和故障测试。 */
  readonly prlimitPath?: string
}

export function imageProcessingEntry(moduleUrl: string = import.meta.url): ImageChildEntry {
  return { script: new URL(moduleUrl.endsWith('.ts') ? '../../../dist/modules/assets/image-processing.child.js' : './image-processing.child.js', moduleUrl) }
}

export type ImageRunnerFailure = 'initialization' | 'protocol' | 'crashed' | 'codec' | 'timeout' | 'heap'
export class ImageRunnerError extends AppError {
  readonly reason: ImageRunnerFailure
  constructor(reason: ImageRunnerFailure) {
    const complex = reason === 'timeout' || reason === 'heap'
    super(complex ? 'ASSET_INVALID' : 'SERVICE_UNAVAILABLE', undefined, complex ? { details: { rule: 'too-complex' } } : {})
    this.reason = reason
  }
}

type Outcome = { ok: true, image?: ProcessedImage } | { ok: false, error: Error }
interface Active { done: Promise<ProcessedImage | undefined>, stop: (error: Error) => void }

/** 一个已准入任务对应一个新进程；不复用、不再次排队，close/reap 完成前不交付结果。 */
export class ImageRunner {
  readonly #entry: ImageChildEntry
  readonly #executionMs: number
  readonly #prlimitPath: string
  #active: Active | undefined
  #initializing: Promise<void> | undefined
  #initialized = false
  #closed = false

  constructor(options: ImageRunnerOptions = {}) {
    this.#entry = options.entry ?? imageProcessingEntry()
    this.#executionMs = options.executionMs ?? IMAGE_LIMITS.executionMs
    this.#prlimitPath = options.prlimitPath ?? '/usr/bin/prlimit'
    if (!Number.isInteger(this.#executionMs) || this.#executionMs < 1 || this.#executionMs > IMAGE_LIMITS.executionMs)
      throw new RangeError('图片执行时限超出固定预算')
  }

  get liveProcesses(): number { return this.#active === undefined ? 0 : 1 }

  /** 真正启动同一个入口并核验其硬限制，不以可执行文件存在代替能力检查。 */
  async initialize(): Promise<void> {
    if (this.#closed)
      throw imageBusy()
    this.#initializing ??= (async () => {
      try {
        await this.#exchange(undefined, new AbortController().signal)
        if (this.#closed)
          throw imageBusy()
        this.#initialized = true
      }
      catch {
        if (this.#closed)
          throw imageBusy()
        throw new ImageRunnerError('initialization')
      }
    })()
    return this.#initializing
  }

  async process(input: ImageProcessingInput, signal: AbortSignal): Promise<ProcessedImage> {
    if (this.#closed || this.#active !== undefined)
      throw imageBusy()
    if (!this.#initialized)
      throw new ImageRunnerError('initialization')
    if (signal.aborted)
      throw imageAborted()
    if (input.data.byteLength > IMAGE_LIMITS.maxBytes)
      throw new AppError('PAYLOAD_TOO_LARGE')
    let copied: ImageProcessingInput
    try {
      const checked = validateImageInput(input)
      copied = { ...checked, data: Buffer.from(checked.data) }
    }
    catch {
      throw new ImageRunnerError('protocol')
    }
    const result = await this.#exchange(copied, signal)
    if (result === undefined)
      throw new ImageRunnerError('protocol')
    return result
  }

  async close(): Promise<void> {
    this.#closed = true
    const active = this.#active
    if (active !== undefined) {
      active.stop(imageBusy())
      await active.done.catch(() => {})
    }
  }

  async #exchange(input: ImageProcessingInput | undefined, signal: AbortSignal): Promise<ProcessedImage | undefined> {
    const handle = this.#launch(input, signal)
    this.#active = handle
    return handle.done.finally(() => {
      if (this.#active === handle)
        this.#active = undefined
    })
  }

  #launch(input: ImageProcessingInput | undefined, signal: AbortSignal): Active {
    const started = performance.now()
    const nodeArgs = ['--jitless', `--max-old-space-size=${IMAGE_LIMITS.heapMb}`, `--max-semi-space-size=${IMAGE_LIMITS.semiSpaceMb}`]
    let child: ChildProcess
    try {
      child = fork(fileURLToPath(this.#entry.script), [...(this.#entry.args ?? [])], {
        ...(process.platform === 'linux' ? { execPath: this.#prlimitPath } : {}),
        execArgv: process.platform === 'linux' ? [`--as=${IMAGE_LIMITS.addressSpaceBytes}:${IMAGE_LIMITS.addressSpaceBytes}`, '--core=0:0', '--', process.execPath, ...nodeArgs] : nodeArgs,
        env: { MALLOC_ARENA_MAX: '2', UV_THREADPOOL_SIZE: '1', VIPS_DISC_THRESHOLD: '256m' },
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
    }
    catch {
      throw new ImageRunnerError('initialization')
    }
    let outcome: Outcome | undefined
    let ready = false
    let stderr = ''
    const finish = (next: Outcome): void => {
      if (outcome === undefined || (outcome.ok && !next.ok))
        outcome = next
      child.kill('SIGKILL')
    }
    const stop = (error: Error): void => finish({ ok: false, error })
    const abort = (): void => stop(imageAborted())
    const remaining = Math.max(1, this.#executionMs - (performance.now() - started))
    const timer = setTimeout(() => stop(new ImageRunnerError(input === undefined ? 'initialization' : 'timeout')), remaining)
    const done = new Promise<ProcessedImage | undefined>((resolve, reject) => {
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk.slice(0, Math.max(0, 16384 - stderr.length))
      })
      child.stderr?.on('error', () => stop(new ImageRunnerError('crashed')))
      child.on('error', () => stop(new ImageRunnerError('crashed')))
      child.on('message', (value: unknown) => {
        if (outcome !== undefined) {
          if (outcome.ok)
            stop(new ImageRunnerError('protocol'))
          return
        }
        try {
          if (isMessage(value, ['type', 'stage']) && value.type === 'failed' && typeof value.stage === 'string' && ['initialize', 'encode', 'verify', 'protocol'].includes(value.stage)) {
            stop(new ImageRunnerError('codec'))
            return
          }
          if (!ready) {
            if (!isMessage(value, ['type', 'protocol', 'addressSpaceBytes']) || value.type !== 'ready' || value.protocol !== 1
              || value.addressSpaceBytes !== (process.platform === 'linux' ? IMAGE_LIMITS.addressSpaceBytes : null)) {
              throw new Error('ready')
            }
            ready = true
            if (input === undefined) {
              finish({ ok: true })
              return
            }
            child.send({ type: 'process', input }, (error) => {
              if (error !== null)
                stop(new ImageRunnerError('crashed'))
            })
            return
          }
          if (isMessage(value, ['type', 'rule']) && value.type === 'invalid' && (ASSET_INVALID_RULES as readonly unknown[]).includes(value.rule)) {
            stop(new AppError('ASSET_INVALID', undefined, { details: { rule: value.rule } }))
            return
          }
          if (!isMessage(value, ['type', 'image']) || value.type !== 'processed')
            throw new Error('result')
          finish({ ok: true, image: validateProcessedImage(value.image) })
        }
        catch {
          stop(new ImageRunnerError('protocol'))
        }
      })
      child.once('close', (_code, exitSignal) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (outcome === undefined) {
          // 只认 V8 的明确堆耗尽 + SIGABRT，普通退出/SIGKILL/库错误字串均不推断 OOM。
          const heap = exitSignal === 'SIGABRT' && /Allocation failed - (?:JavaScript heap|process) out of memory/.test(stderr)
          outcome = { ok: false, error: new ImageRunnerError(heap && input !== undefined ? 'heap' : 'crashed') }
        }
        stderr = '' // 原始 stderr 不成为 Error/cause，不进入正常日志或客户端。
        if (outcome.ok)
          resolve(outcome.image)
        else
          reject(outcome.error)
      })
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted)
      abort()
    return { done, stop }
  }
}

// 快照检查的执行（M3-P3 设计 §3.3、§3.12，DEF-018）：保存与另存为副本把解压之后的字节交给这里，在子进程池里解码、解析、
// 按规则检查、规范化、算哈希（snapshot-inspection.ts），主进程只拿回小结果。用子进程而不用工作线程（需求方 2026-10-05 决定）：
// 子进程的堆撞上上限时 V8 中止的只是那个子进程，服务照常；工作线程在 V8 的内置函数里撞上上限时整个进程中止（S3 实测）。
// - 子进程数、排队、时限与每个子进程的堆上限来自配置（NERVE_SNAPSHOT_INSPECTION_*）；空闲超过 IDLE_PROCESS_TIMEOUT_MS 的子进程结束掉；
// - 同一个账户在执行与排队里合计至多 INSPECTIONS_PER_ACCOUNT 份（审查 A2）：多出来的只对这个人回 503，别人照常排进来；
// - 排队满了、等待超时、子进程崩溃或超时、正在退出：503 SERVICE_UNAVAILABLE 带 Retry-After（与数据库繁忙、等待密码哈希同一个做法，
//   页面的保存照"结果未知"重试）；子进程的堆超过上限：这份快照按"过于复杂"拒绝（规则 too-complex）；
// - 应用退出时结束全部子进程（onApplicationShutdown：在途的请求已经排空，ADR-004）；应用被强制结束时子进程随 IPC 断开退出。
// 子进程的入口按这个文件自己的扩展名找：源码运行（单元测试、集成测试按源码条件引用 api）时是 snapshot-inspection.child.ts，
// 由 Node 直接剥离类型执行，contracts 也按源码条件解析；构建产物与镜像里是同一个目录下的 .js。找不到入口时建不起来（启动即失败），
// 不退回主进程
import type { DocumentProfile, SnapshotRule } from '@nerve-office/contracts'
import type { OnApplicationShutdown } from '@nestjs/common'
import type { AppConfig } from '../config/index.ts'
import type { AppLogger } from '../logging/index.ts'
import type { InspectionTask, PassedSnapshot, SnapshotInspection } from './snapshot-inspection.ts'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SNAPSHOT_MAX_DEPTH } from '@nerve-office/contracts'
import { AppError } from '../../shared/errors/app-error.ts'
import { KeyedQuota } from '../../shared/keyed-quota.ts'
import { ProcessPool, ProcessPoolError } from '../../shared/process-pool.ts'
import { SNAPSHOT_MAX_ENTRIES } from './snapshot-checks.ts'

/** 子进程池的设置（AppConfig 的 snapshotInspection） */
export type SnapshotInspectionSettings = AppConfig['snapshotInspection']

/**
 * 子进程空闲多久之后结束（毫秒）。保存是几秒一次的后台请求：有人在编辑时子进程一直热着（后进先出，忙时总是同一个先接活）；
 * 停下来一分钟就把内存全部还给系统。DEF-018 的测量（容器里）：空闲的子进程独占约 26 MiB，检查过一份 5 MiB 的真实快照之后约 119 MiB，
 * 而且不会自己回落（空闲的进程里 V8 不还堆，手动回收也只回落一点），只有结束进程才还干净；代价是之后的第一次检查多一次冷启动（约 50–65 ms）
 */
export const IDLE_PROCESS_TIMEOUT_MS = 60_000

/**
 * 同一个账户在检查池里（执行中与排队中合计）至多几份（M3-P3 审查 A2）。快照的检查在判断访问之前（与文档无关，看不到与不存在得到同样的回答），
 * 整个池子所有人共用：没有这个上限时，任何一个登录的账户并发提交重的快照（目标可以是随机的 id），就能占满子进程与排队，
 * 让所有人的保存一直得到 503。取 2：一个页面的保存是串行的（上一次有结果之前不发下一次），另存为副本只在失去编辑权之后、
 * 也不与那一页的保存同时；一个人同时开着两个页面、同一刻各自保存时正好 2 份。第三份起只对这个人回 503（带 Retry-After，
 * 与池子繁忙同一个回答，页面照"结果未知"重试），别人照常排进来。按账户计、不看文档：判断与文档无关，"看不到与不存在一致"不变
 */
export const INSPECTIONS_PER_ACCOUNT = 2

/** 检查的结果：通过，或者违反的规则（与文档无关的，加上 too-complex） */
export type InspectionOutcome = PassedSnapshot | { readonly ok: false, readonly rule: Exclude<SnapshotRule, 'unit-id' | 'resource-missing'> }

/** 子进程的入口与它的 Node 选项：与这个文件同一个目录、同一个扩展名 */
export interface InspectionChildEntry {
  readonly script: URL
  readonly execArgv: readonly string[]
}

/**
 * 按这个模块自己的地址找子进程的入口。源码运行时（.ts）Node 直接执行入口的源码，要按源码条件（@nerve-office/source）解析
 * contracts，与测试进程对工作区的包的解析一致；构建产物里（.js）按默认条件解析到 contracts 的构建产物
 */
export function inspectionChildEntry(moduleUrl: string = import.meta.url): InspectionChildEntry {
  const fromSource = new URL(moduleUrl).pathname.endsWith('.ts')
  return {
    script: new URL(`./snapshot-inspection.child.${fromSource ? 'ts' : 'js'}`, moduleUrl),
    execArgv: fromSource ? ['--conditions=@nerve-office/source'] : [],
  }
}

const LINK_MESSAGE = '表格里有不能保存的链接'

/** 每条规则的默认说法（错误响应的 message）：页面按 details.rule 给出自己的说法，这里给接口的其他调用方与日志 */
const SNAPSHOT_INVALID_MESSAGES: Readonly<Record<SnapshotRule, string>> = {
  'encoding': '表格内容不是 UTF-8 编码的文本',
  'json': '表格内容不是合法的 JSON',
  'depth': `表格内容的嵌套超过 ${SNAPSHOT_MAX_DEPTH} 层`,
  'entries': `表格内容的元素超过 ${SNAPSHOT_MAX_ENTRIES} 个`,
  'too-complex': '表格内容过于复杂，检查时用的内存超过上限',
  'structure': '表格内容的结构不正确',
  'resources': '表格的插件数据的结构不正确',
  'resource-duplicate': '表格的插件数据有重复的项',
  'resource-unknown': '表格里有不支持的插件数据',
  'resource-data': '表格的插件数据的内容不正确',
  'resource-not-empty': '表格里有不支持的功能的数据（例如保护）',
  'image-source': '表格里有不能保存的图片',
  'link-structure': LINK_MESSAGE,
  'link-address': LINK_MESSAGE,
  'link-range-id': LINK_MESSAGE,
  'unit-id': '表格内容不属于这份文档',
  'resource-missing': '表格缺少上一版里有内容的插件数据',
}

/**
 * SNAPSHOT_INVALID 的错误：details.rule 是规则的标识（contracts 的 snapshotInvalidDetailsSchema），说明是这条规则的默认说法。
 * 不回显快照的内容（M3-P3 设计 §3.12）；页面按规则给出自己的说法
 */
export function snapshotInvalid(rule: SnapshotRule): AppError {
  return new AppError('SNAPSHOT_INVALID', SNAPSHOT_INVALID_MESSAGES[rule], { details: { rule } })
}

/** 快照的检查：在子进程池里执行（见文件开头）。由 DocumentsModule 按配置建（工厂），退出时关闭 */
export class SnapshotInspector implements OnApplicationShutdown {
  readonly #pool: ProcessPool<InspectionTask, SnapshotInspection>
  /** 每个账户在池子里占着的份数（INSPECTIONS_PER_ACCOUNT） */
  readonly #accounts = new KeyedQuota(INSPECTIONS_PER_ACCOUNT)
  readonly #logger: AppLogger
  /** 503 时建议多久之后再试：排队等待的时限（向上取整到秒，至少 1 秒） */
  readonly #retryAfterSeconds: number

  constructor(settings: SnapshotInspectionSettings, logger: AppLogger, entry: InspectionChildEntry = inspectionChildEntry()) {
    if (!existsSync(fileURLToPath(entry.script)))
      throw new Error(`快照检查的子进程入口不存在：${fileURLToPath(entry.script)}`)
    this.#pool = new ProcessPool({
      script: entry.script,
      execArgv: entry.execArgv,
      processes: settings.processes,
      queue: settings.queue,
      taskTimeoutMs: settings.timeoutMs,
      heapMb: settings.heapMb,
      idleTimeoutMs: IDLE_PROCESS_TIMEOUT_MS,
    })
    this.#logger = logger.with({ module: 'documents', component: 'snapshot-inspector' })
    this.#retryAfterSeconds = Math.max(1, Math.ceil(settings.queue.maxWaitMs / 1000))
  }

  /** 现有的子进程数（按需创建，出错或空闲到期之后丢弃） */
  get liveProcesses(): number {
    return this.#pool.liveProcesses
  }

  /**
   * 检查解压之后的快照（profile 是文档的档案，requester 是发起的账户）：通过时给出 unitId、内容哈希、资源名与字节数，不通过时给出规则。
   * 没有得到结果（这个账户的份数已满、繁忙、子进程崩溃或超时、正在退出）时抛出 503 的 AppError
   */
  async inspect(raw: Uint8Array, profile: DocumentProfile, requester: string): Promise<InspectionOutcome> {
    const release = this.#accounts.tryAcquire(requester)
    if (release === undefined) {
      // 请求的日志带着这个人的 userId（会话守卫之后），这里不另记
      this.#logger.warn('同一个账户在快照检查里的份数已满（执行中与排队中合计），这次回 503', { limit: INSPECTIONS_PER_ACCOUNT, rawBytes: raw.byteLength })
      throw this.#unavailable()
    }
    try {
      return await this.#pool.run({ bytes: raw, profile })
    }
    catch (error) {
      if (!(error instanceof ProcessPoolError))
        throw error
      return this.#failed(error, raw.byteLength)
    }
    finally {
      release()
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#pool.close()
  }

  #failed(error: ProcessPoolError, rawBytes: number): InspectionOutcome {
    switch (error.reason) {
      case 'out-of-memory':
        this.#logger.warn('快照过于复杂：检查时子进程的堆超过上限，按 too-complex 拒绝', { rawBytes })
        return { ok: false, rule: 'too-complex' }
      case 'crashed':
        this.#logger.error('快照检查的子进程出错，这次回 503', { err: error, rawBytes })
        break
      case 'timeout':
        this.#logger.warn('快照检查超过时限，结束这个子进程，这次回 503', { rawBytes })
        break
      case 'queue-full':
      case 'wait-timeout':
      case 'closed':
        // 排队满了、等待超时、正在退出：繁忙，请求日志按 503 带 Retry-After 记 warn
        break
    }
    throw this.#unavailable(error)
  }

  /** 503 SERVICE_UNAVAILABLE 带 Retry-After（排队等待的时限）：池子繁忙与这个账户的份数已满是同一个回答 */
  #unavailable(cause?: ProcessPoolError): AppError {
    return new AppError('SERVICE_UNAVAILABLE', undefined, { ...(cause === undefined ? {} : { cause }), headers: { 'Retry-After': String(this.#retryAfterSeconds) } })
  }
}

import type { OpenCheckReport } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { DocumentAccessPolicy, requireAccess } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { normalizedFailures, OPEN_CHECK_REPORT_WINDOW_MS, OPEN_CHECK_REPORTS_PER_ACCOUNT, OpenCheckReportGate, openCheckReportKey } from './open-check-report-gate.ts'

/**
 * 打开自检失败的上报（M3-P4 设计 §3.13，US-M3-15）：页面的编辑器打开时发现档案不全或数据没有完整载入，这份文档只能阅读，页面把失败报上来。
 * - 能读就能报：在只读快照里判断（ADR-017 的写法，不写库），看不到、不存在、在回收站里的一律 NOT_FOUND，执行的语句相同；
 * - 采纳的记一条 warn，带稳定的 event: 'open-check-failed'（M7 按它告警），服务端补上文档当前的修订号与档案，便于判断报的是不是旧版本；
 *   请求的日志本来就带着报告人的 userId（会话守卫之后），这里不另记。不记审计：这是系统信号，不是用户的操作；
 * - 进程内去重与按账户限量（open-check-report-gate.ts）：重复的、超出的照样 204，不记（超出时每个窗口记一条"上报过多"）。
 * 只作诊断，不改任何状态；请求体已经按 contracts 严格解析（不带快照、资源的 data 与异常的 message），日志只记解析出的字段
 */
@Injectable()
export class OpenCheckReportService {
  readonly #logger: AppLogger

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly gate: OpenCheckReportGate,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  async report(userId: string, documentId: string, report: OpenCheckReport): Promise<void> {
    const document = await this.transactions.readSnapshot(async (transaction) => {
      const { document: readable } = await requireAccess(this.policy, userId, await this.documents.findById(documentId, transaction), transaction)
      return readable
    })
    const failures = normalizedFailures(report.failures)
    const decision = this.gate.decide(userId, openCheckReportKey(documentId, report.revision, report.clientBuild, failures))
    if (decision === 'accept') {
      this.#logger.warn('打开自检失败，这份文档只能阅读', {
        event: 'open-check-failed',
        documentId,
        revision: report.revision,
        currentRevision: document.revision,
        documentProfile: document.profile,
        access: report.access,
        trigger: report.trigger,
        failures,
        clientBuild: report.clientBuild,
        univerVersion: report.univerVersion,
        profile: report.profile,
        formatVersion: report.formatVersion,
      })
    }
    else if (decision === 'throttled-first') {
      this.#logger.warn('打开自检的上报过多，这个窗口之内不再记录', {
        event: 'open-check-reports-throttled',
        limit: OPEN_CHECK_REPORTS_PER_ACCOUNT,
        windowMinutes: OPEN_CHECK_REPORT_WINDOW_MS / 60_000,
      })
    }
  }
}

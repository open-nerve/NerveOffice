import type { EditorDiagnosticReport } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { DocumentAccessPolicy, requireAccess } from './document-access-policy.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { formulaWorkerReportKey, normalizedFailures, OPEN_CHECK_REPORT_WINDOW_MS, OPEN_CHECK_REPORTS_PER_ACCOUNT, OpenCheckReportGate, openCheckReportKey } from './open-check-report-gate.ts'

/**
 * 打开自检失败的上报（M3-P4 设计 §3.13，US-M3-15）：资源自检失败与可恢复 Worker 故障共用通道；后者不限制正常编辑。
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

  async report(userId: string, documentId: string, report: EditorDiagnosticReport): Promise<void> {
    const document = await this.transactions.readSnapshot(async (transaction) => {
      const { document: readable } = await requireAccess(this.policy, userId, await this.documents.findById(documentId, transaction), transaction)
      return readable
    })
    // 新变体只描述故障事实；是否完成重建由页面判断，不把它混成禁止编辑的资源损坏。
    const diagnostic = 'kind' in report
      ? {
          key: formulaWorkerReportKey(documentId, report.revision, report.clientBuild, report.failure),
          message: '公式 Worker 出错，页面尝试使用主线程计算',
          fields: { event: 'formula-worker-failed', failure: report.failure },
        }
      : {
          key: openCheckReportKey(documentId, report.revision, report.clientBuild, report.failures),
          message: '打开自检失败，这份文档只能阅读',
          fields: { event: 'open-check-failed', failures: normalizedFailures(report.failures) },
        }
    const decision = this.gate.decide(userId, diagnostic.key)
    if (decision === 'accept') {
      this.#logger.warn(diagnostic.message, {
        ...diagnostic.fields,
        documentId,
        revision: report.revision,
        currentRevision: document.revision,
        documentProfile: document.profile,
        access: report.access,
        trigger: report.trigger,
        clientBuild: report.clientBuild,
        univerVersion: report.univerVersion,
        profile: report.profile,
        formatVersion: report.formatVersion,
      })
    }
    else if (decision === 'throttled-first') {
      this.#logger.warn('编辑器诊断上报过多，这个窗口之内不再记录', {
        event: 'open-check-reports-throttled',
        limit: OPEN_CHECK_REPORTS_PER_ACCOUNT,
        windowMinutes: OPEN_CHECK_REPORT_WINDOW_MS / 60_000,
      })
    }
  }
}

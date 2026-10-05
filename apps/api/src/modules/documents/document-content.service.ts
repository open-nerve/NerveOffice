import type { RevisionConflictDetails, SaveContentQuery, SaveContentResponse } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { GzipBody } from '../security/index.ts'
import type { CurrentClient } from './client-format-gate.ts'
import type { AccessibleDocument } from './document-access-policy.ts'
import type { ContentEnvelope } from './document-contents.repository.ts'
import type { DocumentRow } from './documents.repository.ts'
import type { EditingActor } from './edit-lease.service.ts'
import type { RevisionNoneMatch } from './if-none-match.ts'
import type { RecordedRequest } from './save-outcomes.ts'
import type { PassedSnapshot } from './upload-inspection.ts'
import { Buffer } from 'node:buffer'
import { shrunkResources } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { AuditService } from '../audit/index.ts'
import { SessionService } from '../auth/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { ClientFormatGate, requireWritableDocument } from './client-format-gate.ts'
import { DocumentAccessPolicy, requireAccess, requireDocumentContent, requireDocumentOperations } from './document-access-policy.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentSaveReceiptsRepository } from './document-save-receipts.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { requestLeaseLoss } from './edit-lease-rules.ts'
import { requireActiveLogin } from './edit-lease.service.ts'
import { EditLeasesRepository } from './edit-leases.repository.ts'
import { matchesNoneMatch } from './if-none-match.ts'
import { legacyNonEmptyResources } from './legacy-resources.ts'
import { savedPayloadDigest } from './payload-digest.ts'
import { revisionSourceFor } from './revision-source.ts'
import { isRecorded, replayedSave, savedOutcome } from './save-outcomes.ts'
import { SnapshotInspector } from './snapshot-inspector.ts'
import { INSPECTED_PROFILE, rejectedSnapshot, requirePassingSnapshot } from './upload-inspection.ts'

/** 读取到的内容：gzip 压缩的快照 JSON 字节，与它对应的修订号（ETag）。 */
export interface DocumentContent {
  readonly revision: number
  readonly snapshot: Buffer
}

/**
 * 读取的结果（M3-P2 设计 §3.2）：当前内容（200）；或者请求带的 If-None-Match 正是当前修订（DEF-017），只有修订号、不读内容（304）
 */
export type ContentRead
  = | { readonly kind: 'current', readonly content: DocumentContent }
    | { readonly kind: 'notModified', readonly revision: number }

/**
 * 谁在保存（M3-P1 设计 §3.4.4）：账户、这次登录（会话守卫认证过的），与请求头里的编辑租约令牌（没带时为 undefined，按没有租约处理）。
 * 控制器从 @CurrentPrincipal() 与 @EditLeaseToken() 取得
 */
export interface ContentSaver extends EditingActor {
  readonly token: string | undefined
}

/** 这一次保存（事务里的各步要的）：请求、负载摘要、"公式待更新"、核对过的页面与检查过的快照 */
interface SaveAttempt {
  readonly saver: ContentSaver
  readonly query: SaveContentQuery
  readonly upload: GzipBody
  readonly digest: Buffer
  readonly formulasPending: boolean
  readonly client: CurrentClient
  readonly snapshot: PassedSnapshot
  readonly origin: AuditOrigin
}

/** 文档的内容（P4 设计 §3.5）：读取当前快照；按基准修订号条件写入新的快照（M3-P3 起有完整的快照检查与"内容相同不递增"）。 */
@Injectable()
export class DocumentContentService {
  readonly #logger: AppLogger

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly receipts: DocumentSaveReceiptsRepository,
    private readonly leases: EditLeasesRepository,
    private readonly sessions: SessionService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
    private readonly clients: ClientFormatGate,
    private readonly inspector: SnapshotInspector,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  /**
   * 能读取就返回当前内容；别人的与不存在的都是 NOT_FOUND。有记录却没有内容是数据不一致，按意外错误处理，不伪装成 404。
   * 判断权限与读内容在同一个只读快照里（M2 Codex 评审 CX1）：原来先判断、再另读内容，判断之后撤权（取消授权、移出空间）、
   * 随即保存的新内容会被这个在途的请求带出去；现在读到的是判断权限的那一刻的内容。
   * 条件请求（noneMatch，M3-P2 设计 §3.2，DEF-017）：权限照常先判断（看不到与不存在一致，304 不透露文档在不在），
   * 当前修订是条件里的那一个就只回修订号、不读内容。修订号取判断权限时读到的文档行：与内容同一个快照，读出来的一定对应
   */
  async read(userId: string, id: string, noneMatch?: RevisionNoneMatch): Promise<ContentRead> {
    return this.transactions.readSnapshot(async (transaction) => {
      const { document } = await requireAccess(this.policy, userId, await this.documents.findById(id, transaction), transaction)
      if (noneMatch !== undefined && matchesNoneMatch(noneMatch, document.revision))
        return { kind: 'notModified', revision: document.revision }
      const content = await this.contents.findCurrent(id, transaction)
      if (content === undefined)
        throw new Error(`文档有记录却没有内容：${id}`)
      return { kind: 'current', content }
    })
  }

  /**
   * 保存（M3-P3 设计 §3.1；P4 设计 §3.5.1，M3-P1 设计 §3.4.4）。守一条原则：同一次保存的重放先于其余一切检查（00 号计划书 §7.4 第 2 步，
   * M3 总设计 §6.3）——已经提交过的同一次保存，之后不论编辑权、客户端的版本、校验的规则怎样，重试都拿到原来的结果（A07）：
   * 1. 重放预检（事务之外，不解析快照）：按 requestId 查修订记录与回执，同一个人、同一份文档、负载摘要一致、仍能访问，就返回原来的结果。
   *    其余情况一律往下走，不提前回答：看不到的、不存在的、另一份文档的 requestId 都留给事务里的再查（"看不到与不存在"的语句序列照旧）；
   * 2. 客户端的数据格式（与文档无关）：过旧时 CLIENT_OUTDATED（ClientFormatGate）；
   * 3. 快照的检查（与文档无关，工作线程）：不合格时 SNAPSHOT_INVALID（details.rule），通过时得到 unitId、内容哈希与资源名；
   * 4. 一个事务：能否访问 → 能编辑时锁文档行、锁下再判断 → 再查一次重放（并发的同一次请求）→ 这次登录仍然有效 → 文档的格式
   *    （比服务端新：DOCUMENT_TOO_NEW）→ 能编辑 → 编辑租约 → 基准修订号 → unitId → 不缩水 → 内容哈希与当前相同：写回执、设"公式待更新"，
   *    修订号不变（unchanged）→ 否则写内容（连同哈希与非空的资源名）、修订号加一、修订记录（哈希与客户端构建）、文档的信封、审计。
   * 先判断再加锁：看不到的请求不在文档上取锁，响应的时序与不存在的文档相同（审查 A2）；只能查看的请求同样不取锁，
   * 不让能编辑的人的保存排队（复验 RA7）——它能得到的只有重放，不加锁查一次请求标识就有结论，到不了租约这一步。
   * 能编辑时先锁文档再查幂等：同一个请求的两次并发重试，后到的一方拿到锁时前一方已经提交，按幂等返回原结果，而不是误报冲突。
   * 重放只要求仍能访问：被降为查看者、空间被归档、租约失效之后重发同一个请求，照样拿到原来的结果（M2-P6 复核 A 的 S-4；A07）。
   * 登录在锁下再核对一次（M3-P1 审查 A1，requireActiveLogin）：会话守卫之后还隔着上传正文、检查与等锁，这期间的撤销挡在这里；失效时 401。
   * 租约在基准修订号之前：失去编辑权的页面得到"编辑权已失效"而不是修订号冲突；unitId 与不缩水在基准修订号之后：落后的页面先得到冲突，
   * 拿过时页面的快照去比当前的资源没有意义。"内容相同"在全部检查之后：编辑权失效之后，内容没变的保存照样被拒（access.spec.ts）
   */
  async save(saver: ContentSaver, id: string, query: SaveContentQuery, upload: GzipBody, origin: AuditOrigin): Promise<SaveContentResponse> {
    // 契约里"公式待更新"可选、不带等于否：规整成布尔值再算摘要（同一个 requestId 而标记不同就是另一个请求，§3.8）
    const formulasPending = query.formulasPending === true
    const digest = savedPayloadDigest(query.baseRevision, upload.decompressed, formulasPending)
    const replayed = await this.replayBeforeChecks(saver.userId, id, query.requestId, digest)
    if (replayed !== undefined)
      return replayed
    const client = this.clients.require(query)
    const snapshot = await requirePassingSnapshot(this.inspector, this.#logger, upload, id)
    const attempt: SaveAttempt = { saver, query, upload, digest, formulasPending, client, snapshot, origin }
    return this.transactions.run(async (transaction) => {
      const accessible = await this.lockIfEditable(saver.userId, id, transaction)
      const { document } = accessible

      // 并发的同一次请求：后到的一方拿到锁时前一方已经提交。requestId 用过、却不是这一次保存的：REQUEST_ID_CONFLICT
      const recorded = await this.recorded(query.requestId, transaction)
      if (isRecorded(recorded)) {
        const original = replayedSave(recorded, saver.userId, document.id, digest)
        if (original === undefined)
          throw new AppError('REQUEST_ID_CONFLICT')
        return original
      }
      await requireActiveLogin(this.sessions, saver, transaction)
      requireWritableDocument(document)
      // 不是重放才要求能编辑：能编辑时这是锁下的判断，只能查看时就是上面那次（没有取锁）
      requireDocumentOperations(accessible, ['edit'])
      await this.requireLease(saver, document, query, transaction)
      if (query.baseRevision !== document.revision)
        throw await this.conflict(saver.userId, document, transaction)
      if (snapshot.unitId !== document.unitId)
        throw rejectedSnapshot(this.#logger, 'unit-id', id)

      const current = await this.contents.findEnvelope(id, transaction)
      if (current === undefined)
        throw new Error(`文档有记录却没有内容：${id}`)
      this.requireNoShrink(id, current, snapshot)
      const contentHash = Buffer.from(snapshot.contentHash)
      // 存量的哈希为空：按"不同"处理，这一次写入补上（第一次保存多一个修订，§3.7）
      if (current.contentHash?.equals(contentHash) === true)
        return this.confirmUnchanged(attempt, document, transaction)
      return this.write(attempt, document, contentHash, transaction)
    })
  }

  /**
   * 重放预检（§3.1 第 2 步）：事务之外，在连接池上按 requestId 查修订记录与回执；是这个人对这份文档的同一次保存、而且他现在仍能访问这份文档，
   * 就给出原来的结果。否则什么也不回答（undefined），交给后面的检查与事务里的再查——看不到与不存在在这里执行同样的两条语句
   * （查不到这个 requestId），之后走同一条路。读到的记录写下之后不再改，单独的语句读出就是完整的；仍能访问的判断在读出记录之后，
   * 判断时能访问，原来的结果（修订号与时间）就是他有权知道的
   */
  private async replayBeforeChecks(userId: string, id: string, requestId: string, digest: Buffer): Promise<SaveContentResponse | undefined> {
    const original = replayedSave(await this.recorded(requestId), userId, id, digest)
    if (original === undefined)
      return undefined
    const document = await this.documents.findById(id)
    const access = document === undefined ? undefined : await this.policy.accessOf(userId, document)
    return access === undefined ? undefined : original
  }

  /** 这个 requestId 的修订记录与回执（不带事务时在连接池上读，见 replayBeforeChecks） */
  private async recorded(requestId: string, transaction?: Transaction): Promise<RecordedRequest> {
    return {
      revision: await this.revisions.findByRequestId(requestId, transaction),
      receipt: await this.receipts.findByRequestId(requestId, transaction),
    }
  }

  /**
   * 不缩水（00 号计划书 §8.2，M3-P3 设计 §3.3）：上一版非空的资源里、在档案白名单之内的，这一版都要在（变空不算缩水）。
   * 上一版的非空资源名存在 document_contents 里；存量为空时解析上一版得到（legacy-resources.ts，写明了不经工作线程的理由），
   * 解析不了的存量没有可核对的上一版，记一条警告、照常往下走
   */
  private requireNoShrink(id: string, current: ContentEnvelope, snapshot: PassedSnapshot): void {
    const previous = this.previousNonEmptyResources(id, current)
    if (previous === undefined)
      return
    const missing = shrunkResources(previous, snapshot.presentResources, INSPECTED_PROFILE)
    if (missing.length > 0)
      throw rejectedSnapshot(this.#logger, 'resource-missing', id, { missing })
  }

  /** 上一版非空的资源名：存下的；存量（为空）时解析上一版，解析不了时记一条警告、为 undefined（没有可核对的上一版） */
  private previousNonEmptyResources(id: string, current: ContentEnvelope): readonly string[] | undefined {
    if (current.resourceNames !== null)
      return current.resourceNames
    const legacy = current.legacySnapshot === null ? undefined : legacyNonEmptyResources(current.legacySnapshot)
    if (legacy === undefined)
      this.#logger.warn('存量的快照解析不出资源，这一次保存不核对不缩水', { documentId: id })
    return legacy
  }

  /**
   * 内容与当前相同（§3.7）：修订号不变，不写内容、修订记录与审计；写一条回执（重试照样拿到这个结果），把"公式待更新"设成请求里的值（§3.8），
   * 给出当前修订与它的时间，unchanged 为真。回执的 requestId 被同时进行的、另一份文档上的同一个 requestId 用掉了：REQUEST_ID_CONFLICT
   */
  private async confirmUnchanged(attempt: SaveAttempt, document: DocumentRow, transaction: Transaction): Promise<SaveContentResponse> {
    const current = await this.revisions.findByRevision(document.id, document.revision, transaction)
    if (current === undefined)
      throw new Error(`当前修订没有修订记录：${document.id}`)
    const receipt = await this.receipts.insert({
      requestId: attempt.query.requestId,
      documentId: document.id,
      revision: document.revision,
      payloadDigest: attempt.digest,
      savedBy: attempt.saver.userId,
      savedAt: current.createdAt,
    }, transaction)
    if (receipt === undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    if (document.formulasPending !== attempt.formulasPending)
      await this.documents.setFormulasPending(document.id, attempt.formulasPending, transaction)
    return { revision: receipt.revision, savedAt: receipt.savedAt.toISOString(), unchanged: true }
  }

  /**
   * 写入新的一版：修订记录（来源、内容哈希、客户端构建）→ 修订号加一与文档的信封（SDK 版本是页面上报、核对过的，客户端构建，
   * "公式待更新"）→ 内容（gzip 的原样字节、哈希与非空的资源名）→ 审计
   */
  private async write(attempt: SaveAttempt, document: DocumentRow, contentHash: Buffer, transaction: Transaction): Promise<SaveContentResponse> {
    const { saver, query, upload, client, snapshot } = attempt
    const next = document.revision + 1
    const revision = await this.revisions.insert({
      documentId: document.id,
      revision: next,
      kind: 'saved',
      requestId: query.requestId,
      payloadDigest: attempt.digest,
      source: { clientInstanceId: query.clientInstanceId, localSeq: query.localSeq },
      savedBy: saver.userId,
      contentHash,
      clientBuild: client.clientBuild,
    }, transaction)
    // 同一个 requestId 同时被另一份文档的保存或一次新建用掉了（它们锁的不是这一行）
    if (revision === undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    await this.documents.advanceRevision(document.id, next, { sdkVersion: client.univerVersion, clientBuild: client.clientBuild, formulasPending: attempt.formulasPending }, transaction)
    const replaced = await this.contents.replace(document.id, {
      snapshot: upload.compressed,
      rawBytes: upload.decompressed.length,
      contentHash,
      resourceNames: snapshot.nonEmptyResources,
    }, transaction)
    if (!replaced)
      throw new Error(`文档有记录却没有内容：${document.id}`)
    await this.audit.record({
      action: 'documents.content_saved',
      actor: { type: 'user', id: saver.userId },
      target: { type: 'document', id: document.id },
      origin: attempt.origin,
      details: { revision: next },
    }, { transaction })
    return savedOutcome(revision)
  }

  /**
   * 保存要求编辑租约（M3-P1 设计 §3.4.4）：令牌是当前这一行的、按有效条件有效（edit-lease-rules.ts 的 requestLeaseLoss）、
   * 代次等于查询参数的 writeEpoch、这次登录与查询参数的标签页都是租约绑定的，否则 EDIT_LEASE_LOST（details 带原因）。
   * 文档行已经锁住（能编辑的请求才走到这里），代次是锁下读到的；租约行不加锁读：能改写它的申请与收回写入权都要先拿文档行的锁。
   * 保存不续租（续租靠心跳）
   */
  private async requireLease(saver: ContentSaver, document: DocumentRow, query: SaveContentQuery, transaction: Transaction): Promise<void> {
    const lease = await this.leases.findByDocument(document.id, transaction)
    const loss = requestLeaseLoss(lease, document.writeEpoch, { token: saver.token, sessionId: saver.sessionId, clientInstanceId: query.clientInstanceId, writeEpoch: query.writeEpoch })
    if (loss !== undefined)
      throw new AppError('EDIT_LEASE_LOST', undefined, { details: { reason: loss } })
  }

  /**
   * 判断能否访问（别人的与不存在的都是 NOT_FOUND）；能编辑时再锁住文档行、锁下再判断一次，返回锁下的最新状态（修订号等）。
   * 锁下再判断：加锁之前文档可能已经移到别的空间，或者授权被收回了（M2），都按锁下的状态为准（复验 RA7）。
   * 只能查看的不取锁，返回不加锁读到的那一版：调用方拿它只能查重放，写入之前还要求能编辑。
   * 与改名、移动、删除走同一个判断（requireDocumentContent）：归档的空间里说明"空间已归档"，而不是"只能查看"
   */
  private async lockIfEditable(userId: string, id: string, transaction: Transaction): Promise<AccessibleDocument<DocumentRow>> {
    const unlocked = await requireDocumentContent(this.policy, userId, await this.documents.findById(id, transaction), [], transaction)
    if (!unlocked.permissions.canEdit)
      return unlocked
    return requireDocumentContent(this.policy, userId, await this.documents.lockById(id, transaction), [], transaction)
  }

  /**
   * 修订号冲突，详情带当前修订号及其来源：客户端据此判断是不是"自己追自己"（P4 设计 §3.5.2）。
   * 来源只给保存这一版的人本人，别人看到 null（revisionSourceFor，M3-P1 复验 C4）
   */
  private async conflict(userId: string, document: DocumentRow, transaction: Transaction): Promise<AppError> {
    const current = await this.revisions.findByRevision(document.id, document.revision, transaction)
    const details: RevisionConflictDetails = { currentRevision: document.revision, source: revisionSourceFor(current, userId) }
    return new AppError('DOCUMENT_REVISION_CONFLICT', undefined, { details })
  }
}

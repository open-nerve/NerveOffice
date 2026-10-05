import type { ConflictCopyQuery, CreatedDocument } from '@nerve-office/contracts'
import type { AuditOrigin } from '../audit/index.ts'
import type { Transaction } from '../database/index.ts'
import type { GzipBody } from '../security/index.ts'
import type { DocumentAccess } from './access-rules.ts'
import type { Actor, SpaceContentAccess } from './document-access-policy.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { DocumentRow } from './documents.repository.ts'
import { Buffer } from 'node:buffer'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { inIdOrder } from '../../shared/id-order.ts'
import { AuditService } from '../audit/index.ts'
import { TransactionRunner } from '../database/index.ts'
import { AppLogger } from '../logging/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { ClientFormatGate } from './client-format-gate.ts'
import { creatableSpace, documentAccessIn, DocumentAccessPolicy, requireAccess, requireSpaceContent } from './document-access-policy.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { toDetail } from './document-views.ts'
import { DocumentsRepository } from './documents.repository.ts'
import { FoldersRepository } from './folders.repository.ts'
import { conflictCopyPayloadDigest } from './payload-digest.ts'
import { RequestLedger } from './request-ledger.ts'
import { SnapshotInspector } from './snapshot-inspector.ts'
import { SpaceTreeRepository } from './space-tree.repository.ts'
import { rejectedSnapshot, requirePassingSnapshot } from './upload-inspection.ts'

/** 副本放在哪里：调用者在那个空间的访问（拼响应用）与那个空间里的文件夹（null 是根目录） */
interface Placement {
  readonly target: SpaceContentAccess
  readonly folderId: string | null
}

/**
 * 另存为副本（M3-P2 设计 §3.2，00 号计划书 §7.5）：失去编辑权、还读得到原文档的人，把本页的内容（上传的快照）存成一份新文档。
 * - 只要求能读原文档（读不到 404，看不到与不存在一致）：失去编辑权、还读得到的人正是要用它的人；内容本来就能读、能复制；
 * - 放在哪里：本人在原文档所在的空间有新建权限时，放进原文档现在所在的文件夹（文件夹不在了放空间的根目录）；否则放进本人个人空间的根目录。
 *   不由请求决定，按锁下的权限；
 * - 处理的顺序与保存相同（M3-P3 设计 §3.1）：重放预检（事务之外）→ 客户端的数据格式（CLIENT_OUTDATED）→ 快照的完整检查
 *   （SNAPSHOT_INVALID，子进程）→ 事务；快照的顶层 id 要等于原文档的 unitId（副本的 unitId 与原文档相同，与复制一样不改写，
 *   00 号计划书 §8.3）。不做"不缩水"与"内容相同"：副本是一份新文档；
 * - 新文档：类型照原文档；信封是这次上传的、核对过的页面的（插件档案、平台格式版本、SDK 版本、客户端构建，"公式待更新"，M3-P3）——
 *   内容是页面上传的，信封描述的是这份内容：原文档可能由更新的版本写过（回滚之后），照抄它的档案与格式版本，旧格式的内容就会标着新的
 *   （审查 A7）；与保存记信封的做法一致（documents.repository.ts 的 UploadEnvelope）。
 *   内容连同规范化的哈希与非空的资源名；修订号 1、代次 0，修订记录 created（带哈希与客户端构建）；
 *   不继承原文档的单独授权（与复制相同：副本是一份新文档，授权只给原文档）；
 * - requestId 幂等，与新建、复制同一个做法：同一个人的同一次请求（摘要一致）返回那份副本现在的样子，带 replayed。
 *   重放先于其余检查（M3-P3 设计 §3.1）：事务之外先查一次，事务里在 requestId 的锁下再查一次（并发的同一次请求）；
 * - 审计 documents.conflict_copied（原文档与副本所在的空间，不记标题）；响应与复制相同（新文档的详情）。
 *
 * 锁（与复制、新建同一套顺序，ADR-014）：requestId 的 advisory lock → 原文档所在空间的树锁（只在要放进那个空间时取：副本可能落进文件夹，
 * 与删除、移动那个文件夹串行；也挡住原文档在空间内换文件夹）→ 原文档所在的空间与本人个人空间的行（FOR SHARE，按 id）→ 原文档行（FOR SHARE）。
 * 锁下重新判断能读原文档（移出空间、取消授权、删除、移走要么先提交、被看到，要么等副本提交之后才生效），重新决定放在哪里
 * （降为查看者、归档、移出先提交时放进个人空间；锁下才变成能新建的照旧放进个人空间——取锁之前没有取那个空间的树锁，这也是一个合法的先后）
 */
@Injectable()
export class DocumentConflictCopyService {
  readonly #logger: AppLogger

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly documents: DocumentsRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly revisions: DocumentRevisionsRepository,
    private readonly ledger: RequestLedger,
    private readonly folders: FoldersRepository,
    private readonly tree: SpaceTreeRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
    private readonly audit: AuditService,
    private readonly clients: ClientFormatGate,
    private readonly inspector: SnapshotInspector,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  async copy(actor: Actor, id: string, command: ConflictCopyQuery, upload: GzipBody, origin: AuditOrigin): Promise<CreatedDocument> {
    const userId = actor.userId
    // "公式待更新"可选、不带等于否：规整成布尔值再算摘要（M3-P3 设计 §3.8）
    const formulasPending = command.formulasPending === true
    const digest = conflictCopyPayloadDigest(id, command.title, upload.decompressed, formulasPending)
    // 重放先于其余检查（M3-P3 设计 §3.1 第 2 步）：已经建好的那份副本，之后客户端被判为过旧、校验的规则收紧，原样的重试照样拿到它
    const replayed = await this.replayBeforeChecks(userId, command.requestId, digest)
    if (replayed !== undefined)
      return replayed
    // 与文档无关的两步在事务之前（与保存相同）：别人的与不存在的文档得到相同的结果
    const client = this.clients.require(command)
    const snapshot = await requirePassingSnapshot(this.inspector, this.#logger, upload, id)
    const contentHash = Buffer.from(snapshot.contentHash)
    return this.transactions.run(async (transaction) => {
      // 同一个 requestId 的写入排队执行：后到的一方在下面就能看到前一方的修订记录，按重放处理（与新建、复制相同，锁排在最前，RequestLedger）；
      // 它用在一次内容相同的保存上（回执）时 REQUEST_ID_CONFLICT
      const previous = await this.ledger.lockForCreated(command.requestId, transaction)
      if (previous !== undefined)
        return this.replay(userId, previous, digest, transaction)

      // 先判断（不加锁）：读不到原文档的请求不取任何锁，与不存在的文档执行同样的语句
      const checked = await requireAccess(this.policy, userId, await this.documents.findById(id, transaction), transaction)
      // unitId 终身不变，不必等锁：内容不属于这份文档的请求同样不取锁
      if (snapshot.unitId !== checked.document.unitId)
        throw rejectedSnapshot(this.#logger, 'unit-id', id)
      const sourceSpaceId = checked.document.spaceId
      const personalSpaceId = await this.personalSpaceIdOf(userId, transaction)
      const intoSource = await creatableSpace(this.policy, actor, sourceSpaceId, transaction) !== undefined
      if (intoSource)
        await this.tree.lock([sourceSpaceId], transaction)
      // 两个空间的行按 id 顺序取共享锁：与归档、移出成员、调整角色（FOR NO KEY UPDATE）互斥
      for (const spaceId of inIdOrder([sourceSpaceId, personalSpaceId]))
        await this.spaces.holdSpace(spaceId, transaction)
      // 原文档行的共享锁：与删除、移动、取消授权（都取 FOR UPDATE）互斥；锁下重新读、重新判断能不能读它
      const source = await requireAccess(this.policy, userId, await this.documents.holdById(id, transaction), transaction)
      // 空间行是按取锁之前读到的空间取的：万一刚好有一次跨空间移动提交了，这把锁就保护不到它，按"没找到"回答（与复制相同）
      if (source.document.spaceId !== sourceSpaceId)
        throw new AppError('NOT_FOUND')
      const placement = await this.placementOf(actor, source.document, intoSource, personalSpaceId, transaction)

      // 类型与 unitId 照原文档（锁下确认过是正常状态），信封是这次上传的、核对过的页面的；建不出来是数据不一致，按意外错误处理
      const copy = await this.documents.copyFrom(id, {
        spaceId: placement.target.space.id,
        folderId: placement.folderId,
        title: command.title,
        createdBy: userId,
        envelope: { profile: client.profile, formatVersion: client.formatVersion, sdkVersion: client.univerVersion, clientBuild: client.clientBuild, formulasPending },
      }, transaction)
      if (copy === undefined)
        throw new Error(`锁住的原文档建不出副本：${id}`)
      await this.contents.insert(copy.id, { snapshot: upload.compressed, rawBytes: upload.decompressed.length, contentHash, resourceNames: snapshot.nonEmptyResources }, transaction)
      const revision = await this.revisions.insert({
        documentId: copy.id,
        revision: 1,
        kind: 'created',
        requestId: command.requestId,
        payloadDigest: digest,
        source: null,
        savedBy: userId,
        contentHash,
        clientBuild: client.clientBuild,
      }, transaction)
      // requestId 已经被用掉（在它的锁下查过两张表，走到这里不会撞上；留作兜底）
      if (revision === undefined)
        throw new AppError('REQUEST_ID_CONFLICT')
      // 明细里的 id 用数据库返回的（ADR-014 的"请求里的 id"）
      await this.audit.record({
        action: 'documents.conflict_copied',
        actor: { type: 'user', id: userId },
        target: { type: 'document', id: copy.id },
        origin,
        details: { sourceId: source.document.id, spaceId: copy.spaceId },
      }, { transaction })
      // 副本是一份新文档、不带原文档的授权：按调用者在放进去的那个空间的访问给出（与新建、复制相同）
      return { ...toDetail(copy, documentAccessIn(placement.target), userId), replayed: false }
    })
  }

  /**
   * 锁下决定放在哪里（00 号计划书 §7.5）：取锁之前判断过能在原文档所在的空间新建、锁下再判断一次仍然能，就放进原文档现在所在的文件夹
   * （锁下读到的那一行；文件夹不在了放空间的根目录）；否则放进本人个人空间的根目录（锁下照新建的规则再判断一次）。
   * 取锁之前不能、锁下才能的（期间被升为编辑者）照旧放进个人空间：那个空间的树锁没有取，放进它的文件夹不安全，
   * 而"放进个人空间"对应的正是判断那一刻的权限
   */
  private async placementOf(actor: Actor, source: DocumentRow, intoSource: boolean, personalSpaceId: string, transaction: Transaction): Promise<Placement> {
    const sourceSpace = intoSource ? await creatableSpace(this.policy, actor, source.spaceId, transaction) : undefined
    if (sourceSpace !== undefined)
      return { target: sourceSpace, folderId: await this.activeFolderIn(source.spaceId, source.folderId, transaction) }
    return { target: await requireSpaceContent(this.policy, actor, personalSpaceId, 'createDocuments', transaction), folderId: null }
  }

  /**
   * 原文档所在的文件夹还在这个空间里、是正常状态时就是它，否则是空间的根目录（null）。持着这个空间的树锁：文件夹的状态与位置这时不会变
   * （文件夹行只被持有所在空间树锁的事务改动，ADR-014）
   */
  private async activeFolderIn(spaceId: string, folderId: string | null, transaction: Transaction): Promise<string | null> {
    if (folderId === null)
      return null
    const folder = await this.folders.findById(folderId, transaction)
    return folder?.spaceId === spaceId ? folder.id : null
  }

  /**
   * 重放预检（M3-P3 设计 §3.1 第 2 步）：事务之外，在连接池上按 requestId 查修订记录；是同一个人的同一次另存（摘要一致）、
   * 他仍能访问那份副本，就返回它现在的样子（标为重放）。否则什么也不回答，交给后面的检查与事务里的再查（requestId 的锁下）：
   * 看不到与不存在在这里执行同样的一条语句（查不到这个 requestId），之后走同一条路
   */
  private async replayBeforeChecks(userId: string, requestId: string, digest: Buffer): Promise<CreatedDocument | undefined> {
    const previous = await this.revisions.findByRequestId(requestId)
    return previous === undefined ? undefined : this.replayed(userId, previous, digest)
  }

  /**
   * 同一个 requestId 已经有修订记录（事务里，requestId 的锁下）：是同一个人、同一次另存（摘要一致），而且这个人仍能访问那份副本，
   * 才返回那份副本现在的样子（标为重放）；否则拒绝，不透露那份文档的任何信息（与新建、复制相同）
   */
  private async replay(userId: string, previous: RevisionRow, digest: Buffer, transaction: Transaction): Promise<CreatedDocument> {
    const replayed = await this.replayed(userId, previous, digest, transaction)
    if (replayed === undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    return replayed
  }

  /** 这条修订记录是这个人的同一次另存、他仍能访问那份副本时，副本现在的样子（标为重放）；否则 undefined */
  private async replayed(userId: string, previous: RevisionRow, digest: Buffer, transaction?: Transaction): Promise<CreatedDocument | undefined> {
    const sameRequest = previous.kind === 'created' && previous.savedBy === userId && previous.payloadDigest.equals(digest)
    const document: DocumentRow | undefined = sameRequest ? await this.documents.findById(previous.documentId, transaction) : undefined
    const access: DocumentAccess | undefined = document === undefined ? undefined : await this.policy.accessOf(userId, document, transaction)
    if (document === undefined || access === undefined)
      return undefined
    return { ...toDetail(document, access, userId), replayed: true }
  }

  private async personalSpaceIdOf(userId: string, transaction: Transaction): Promise<string> {
    const space = await this.spaces.personalSpaceOf(userId, { transaction })
    // 个人空间随账户一起创建；没有说明数据不一致，按意外错误处理
    if (space === undefined)
      throw new Error(`账户没有个人空间：${userId}`)
    return space.id
  }
}

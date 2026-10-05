// 写入请求的 requestId（ADR-011，00 号计划书 §7.4 第 2 步）：保存、新建、复制、另存为副本的结果记在修订记录里，内容相同、修订号没变的保存
// 记在回执里（M3-P3 设计 §3.7）。一个 requestId 只用于一次请求，两张表之间同样如此（M3-P3 审查 A3）——两张表各有自己的唯一约束，
// 管不到对方。做法是让每一种写入都经这里：
// - 事务的第一步取这个 requestId 的事务级 advisory lock（lock）：同一个 requestId 的写入排队执行，后到的一方在锁下查两张表（recorded），
//   看得到前一方的结果——不论它写在哪一张表、哪一份文档上。锁键用数据库规范化之后的 UUID：同一个 UUID 的大写与小写写法，
//   两张表的 uuid 列认作同一个，锁也必须认作同一个（Codex 评审 CX7）。不同的 requestId 哈希相同时只是多排一次队；
// - 取锁的先后（ADR-007 的顺序，ADR-014 的补充）：每个事务至多取一把这种锁，而且是它的第一把锁，所以等这把锁的事务手里没有别的锁，
//   它不会与文档行、空间行、空间树的锁成环；
// - 新建、复制、另存为副本（结果都是 created 的修订记录）用 lockForCreated：用在回执上的 requestId 一定是一次保存，按 REQUEST_ID_CONFLICT 拒绝；
//   保存在事务的第一步 lock，锁下判断过访问之后再 recorded（重放的判断在 save-outcomes.ts）。
// 两张表的唯一约束加 ON CONFLICT DO NOTHING（插入时回 REQUEST_ID_CONFLICT）留作兜底。
// 新建文件夹的 requestId 在 folders 表上，自成一套（由空间树的锁排队，FoldersService.create），不经这里
import type { Transaction } from '../database/index.ts'
import type { RevisionRow } from './document-revisions.repository.ts'
import type { ReceiptRow } from './document-save-receipts.repository.ts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { DocumentSaveReceiptsRepository } from './document-save-receipts.repository.ts'

/** 同一个 requestId 已经有的记录：修订记录（保存、新建、复制、另存为副本的都在这张表里）与回执，各至多一条 */
export interface RecordedRequest {
  readonly revision: RevisionRow | undefined
  readonly receipt: ReceiptRow | undefined
}

/** 这个 requestId 已经用过（不论是不是这一次请求） */
export function isRecorded(recorded: RecordedRequest): boolean {
  return recorded.revision !== undefined || recorded.receipt !== undefined
}

/** requestId 的锁与两张表里的记录（见文件开头） */
@Injectable()
export class RequestLedger {
  constructor(
    private readonly revisions: DocumentRevisionsRepository,
    private readonly receipts: DocumentSaveReceiptsRepository,
  ) {}

  /** 取这个 requestId 的锁：事务的第一把锁，事务结束时释放 */
  async lock(requestId: string, transaction: Transaction): Promise<void> {
    await this.revisions.lockRequest(requestId, transaction)
  }

  /**
   * 这个 requestId 在两张表里的记录。不带事务时在连接池上读（保存的重放预检在事务之外，M3-P3 设计 §3.1 第 2 步）：
   * 两种记录写下之后都不再改，单独的语句读出就是完整的
   */
  async recorded(requestId: string, transaction?: Transaction): Promise<RecordedRequest> {
    return {
      revision: await this.revisions.findByRequestId(requestId, transaction),
      receipt: await this.receipts.findByRequestId(requestId, transaction),
    }
  }

  /**
   * 新建、复制、另存为副本：取锁，给出这个 requestId 的修订记录（没有时为 undefined；有时调用方按自己的规则判断是不是重放）。
   * 没有修订记录、却有回执：那是一次内容相同的保存，不是这一类请求——REQUEST_ID_CONFLICT（审查 A3），不透露那份文档的任何信息
   */
  async lockForCreated(requestId: string, transaction: Transaction): Promise<RevisionRow | undefined> {
    await this.lock(requestId, transaction)
    const { revision, receipt } = await this.recorded(requestId, transaction)
    if (revision === undefined && receipt !== undefined)
      throw new AppError('REQUEST_ID_CONFLICT')
    return revision
  }
}

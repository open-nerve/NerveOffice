import type { DocumentHistorySummary, HistoryListQuery } from '@nerve-office/contracts'
import type { Buffer } from 'node:buffer'
import type { Transaction } from '../database/index.ts'
import type { Actor } from './document-access-policy.ts'
import type { HistoryRecord } from './document-history.repository.ts'
import { HISTORY_PAGE_SIZE } from '@nerve-office/contracts'
import { Injectable } from '@nestjs/common'
import { AppError } from '../../shared/errors/app-error.ts'
import { decodeTimeCursor, encodeTimeCursor } from '../../shared/time-cursor.ts'
import { documentTooNew } from './client-format-gate.ts'
import { DocumentAccessPolicy, requireDocumentContent } from './document-access-policy.ts'
import { DocumentCheckpointClock } from './document-checkpoint-clock.ts'
import { DocumentHistoryRepository } from './document-history.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'

/** Workspace 在同一个只读快照内将保存人 id 换成摘要。 */
export type HistoryMetadata = Omit<DocumentHistorySummary, 'savedBy'> & { readonly savedBy: string }
export interface HistoryPage {
  readonly items: readonly HistoryMetadata[]
  readonly nextCursor: string | null
  readonly canClearHistory: boolean
}

@Injectable()
export class DocumentHistoryService {
  constructor(
    private readonly history: DocumentHistoryRepository,
    private readonly documents: DocumentsRepository,
    private readonly policy: DocumentAccessPolicy,
    private readonly clock: DocumentCheckpointClock,
  ) {}

  async list(actor: Actor, documentId: string, query: HistoryListQuery, tx: Transaction): Promise<HistoryPage> {
    const after = query.cursor === undefined ? undefined : decodeTimeCursor(query.cursor)
    if (query.cursor !== undefined && after === undefined)
      throw new AppError('REQUEST_INVALID', '分页的游标不合法，请从第一页重新加载')
    const { permissions } = await this.requireHistory(actor.userId, documentId, tx)
    const rows = await this.history.list(documentId, await this.clock.now(tx), HISTORY_PAGE_SIZE + 1, after, tx)
    const page = rows.slice(0, HISTORY_PAGE_SIZE)
    const last = page.at(-1)
    return {
      items: page.map(metadataOf),
      canClearHistory: permissions.canClearHistory,
      nextCursor: rows.length > HISTORY_PAGE_SIZE && last !== undefined ? encodeTimeCursor({ position: last.position, id: last.id }) : null,
    }
  }

  async detail(actor: Actor, documentId: string, historyId: string, tx: Transaction): Promise<HistoryMetadata> {
    await this.requireHistory(actor.userId, documentId, tx)
    const row = await this.history.find(documentId, historyId, await this.clock.now(tx), tx)
    if (row === undefined)
      throw new AppError('NOT_FOUND')
    return metadataOf(row)
  }

  async content(actor: Actor, documentId: string, historyId: string, tx: Transaction): Promise<Buffer> {
    await this.requireHistory(actor.userId, documentId, tx)
    const snapshot = await this.history.content(documentId, historyId, await this.clock.now(tx), tx)
    if (snapshot === undefined)
      throw new AppError('NOT_FOUND')
    return snapshot
  }

  private async requireHistory(userId: string, documentId: string, tx: Transaction) {
    return requireDocumentContent(this.policy, userId, await this.documents.findById(documentId, tx), ['viewHistory'], tx)
  }
}

function metadataOf(row: HistoryRecord): HistoryMetadata {
  const { position: _position, ...metadata } = row
  return {
    ...metadata,
    savedAt: row.savedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    compatibility: documentTooNew(row) ? 'unsupported' : 'supported',
  }
}

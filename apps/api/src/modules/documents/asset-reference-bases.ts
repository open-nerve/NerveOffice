import type { Transaction } from '../database/index.ts'
import type { AssetReferenceBase } from './document-asset-references.ts'
import { Injectable } from '@nestjs/common'
import { AppLogger } from '../logging/index.ts'
import { unlinkedAssetIds } from './document-asset-references.ts'
import { DocumentAssetsRepository } from './document-assets.repository.ts'
import { DocumentContentsRepository } from './document-contents.repository.ts'
import { DocumentRevisionsRepository } from './document-revisions.repository.ts'
import { legacyAssetIds } from './legacy-asset-ids.ts'

/**
 * 授权比较基准的取得（M5-P7 设计 §3.2、S5 计划 §3，D-01；S14 审查 B1/B3 起只取“存在但未登记”的部分）：调用方已持基准文档的行锁。
 * 按顺序回退：
 * 1. 首选修订（另存为副本为草稿所基于的修订，须属于这份文档）记下的未登记标识；
 * 2. 当前修订记下的未登记标识；
 * 3. 当前修订是 P7 之前写的（未知）：在锁下解析当前正文（legacy-asset-ids.ts，每份文档至多一次），减去当前已登记的关系；
 * 4. 解析不了：当作没有未登记的标识，记一条警告——等于这一次沿用旧语义，此类存量本来就打不开。
 */
@Injectable()
export class AssetReferenceBases {
  readonly #logger: AppLogger

  constructor(
    private readonly revisions: DocumentRevisionsRepository,
    private readonly contents: DocumentContentsRepository,
    private readonly links: DocumentAssetsRepository,
    logger: AppLogger,
  ) {
    this.#logger = logger.with({ module: 'documents' })
  }

  async resolve(documentId: string, currentRevision: number, preferredRevision: number | undefined, transaction: Transaction): Promise<AssetReferenceBase> {
    if (preferredRevision !== undefined && preferredRevision !== currentRevision) {
      const preferred = await this.revisions.unlinkedAssetIdsOf(documentId, preferredRevision, transaction)
      if (preferred !== undefined && preferred !== null)
        return { unlinked: new Set(preferred) }
    }
    const current = await this.revisions.unlinkedAssetIdsOf(documentId, currentRevision, transaction)
    if (current !== undefined && current !== null)
      return { unlinked: new Set(current) }
    const content = await this.contents.findCurrent(documentId, transaction)
    const legacy = content === undefined ? undefined : legacyAssetIds(content.snapshot)
    if (legacy !== undefined)
      return { unlinked: new Set(unlinkedAssetIds(legacy, await this.links.current(documentId, transaction))) }
    this.#logger.warn('存量的正文解析不出图片标识，这一次以当前已登记的图片关系作授权基准', { documentId })
    return { unlinked: new Set() }
  }
}

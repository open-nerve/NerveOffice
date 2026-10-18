import type { Transaction } from '../database/index.ts'
import type { AccessTarget } from './document-access-policy.ts'
import type { HeldDocumentRow } from './documents.repository.ts'
import { Injectable } from '@nestjs/common'
import { AssetReferenceService } from '../assets/index.ts'
import { SpacesService } from '../spaces/index.ts'
import { documentPermissionsOf } from './access-rules.ts'
import { DocumentAccessPolicy } from './document-access-policy.ts'
import { DocumentAssetsRepository } from './document-assets.repository.ts'
import { DocumentsRepository } from './documents.repository.ts'

const PREPARED: unique symbol = Symbol('prepared asset references')
const HELD: unique symbol = Symbol('held asset references')

/** 仅此服务能生成，固定候选集合；预选结果不能直接当成授权。 */
export interface PreparedAssetReferences {
  readonly [PREPARED]: true
  readonly transaction: Transaction
  readonly userId: string
  readonly ids: readonly string[]
  readonly sources: readonly AccessTarget[]
  readonly preservedTarget: AccessTarget | undefined
}

/** 空间及全部既有文档已按顺序持锁；绑定事务，不能拿普通 ID 数组冒充。 */
export interface HeldAssetReferences {
  readonly [HELD]: true
  readonly prepared: PreparedAssetReferences
  readonly mode: 'update' | 'share'
  readonly spaceIds: ReadonlySet<string>
  readonly documents: ReadonlyMap<string, HeldDocumentRow>
}

export interface ReferenceLocks {
  readonly mode: 'update' | 'share'
  /** 复制流程必须持住的原文档：在取锁之前固定，也可在锁下证明当前引用。 */
  readonly documents?: readonly AccessTarget[]
  /** 新建副本目标空间；树锁由调用方在 hold 之前取得。 */
  readonly spaceIds?: readonly string[]
}

function sameTransaction(prepared: PreparedAssetReferences, transaction: Transaction): void {
  if (prepared.transaction !== transaction)
    throw new Error('资源引用事务不一致')
}

/** 当前引用的编排只使用调用方事务；Assets 不反向依赖文档。 */
@Injectable()
export class DocumentAssetReferences {
  constructor(
    private readonly assets: AssetReferenceService,
    private readonly links: DocumentAssetsRepository,
    private readonly documents: DocumentsRepository,
    private readonly spaces: SpacesService,
    private readonly policy: DocumentAccessPolicy,
  ) {}

  async prepare(userId: string, assetIds: readonly string[], transaction: Transaction, preservedTarget?: AccessTarget): Promise<PreparedAssetReferences> {
    const ids = [...new Set(assetIds)].sort()
    // 窗口和目标旧关系这里只减少候选锁，不授予权利。最终两者都必须在锁下重新读取。
    const metadata = await this.assets.inspect(ids, transaction)
    const available = new Set(metadata.filter(row => row.uploaderId === userId && row.withinUploadWindow).map(row => row.assetId))
    if (preservedTarget !== undefined) {
      for (const id of await this.links.referencedIds([preservedTarget.id], ids, transaction))
        available.add(id)
    }
    const remaining = metadata.filter(row => !available.has(row.assetId)).map(row => row.assetId)
    let sources: readonly AccessTarget[] = []
    if (remaining.length > 0) {
      const visible = await this.policy.visibleSpaces({ userId, systemAdmin: false }, transaction)
      const candidates = await this.documents.assetSources({ spaceIds: visible.map(row => row.space.id), grantsOf: userId }, remaining, transaction)
      sources = [...new Map(candidates.map(row => [row.id, row])).values()]
    }
    return { [PREPARED]: true, transaction, userId, ids, sources, preservedTarget }
  }

  async hold(prepared: PreparedAssetReferences, options: ReferenceLocks, transaction: Transaction): Promise<HeldAssetReferences> {
    sameTransaction(prepared, transaction)
    const targets = [...prepared.sources, ...(options.documents ?? []), ...(prepared.preservedTarget === undefined ? [] : [prepared.preservedTarget])]
    const spaceIds = [...new Set([...targets.map(row => row.spaceId), ...(options.spaceIds ?? [])])].sort()
    const spaces = await this.spaces.holdSpaces(spaceIds, transaction)
    const documentIds = [...new Set(targets.map(row => row.id))].sort()
    const rows = options.mode === 'update'
      ? await this.documents.lockByIds(documentIds, transaction)
      : await this.documents.holdByIds(documentIds, transaction)
    return {
      [HELD]: true,
      prepared,
      mode: options.mode,
      spaceIds: new Set(spaces.map(row => row.id)),
      documents: new Map(rows.map(row => [row.id, row])),
    }
  }

  async authorize(held: HeldAssetReferences, transaction: Transaction): Promise<readonly string[]> {
    const plan = held.prepared
    sameTransaction(plan, transaction)
    if (plan.ids.length === 0)
      return []
    // 行若在预选与取锁之间移到了未持锁的空间，就不用它；绝不补取更早顺序的空间锁。
    const stable = [...held.documents.values()].filter(row => held.spaceIds.has(row.spaceId))
    const granted = await this.documents.findManyWithGrants(plan.userId, stable.map(row => row.id), transaction)
    const access = await this.policy.accessOfMany(plan.userId, granted.map(row => ({ document: row, grant: row.grantRole ?? undefined })), transaction)
    // 副本原文档也是取锁之前已固定的来源；只在这份已持锁集合内复核，不在这里发现其他文档。
    const candidates = new Set(held.documents.keys())
    const allowedDocuments = granted.filter((row) => {
      const located = access.get(row.id)
      if (located === undefined)
        return false
      if (row.id === plan.preservedTarget?.id)
        return held.mode === 'update' && documentPermissionsOf(located.access, row, plan.userId).canEdit
      return candidates.has(row.id)
    })
    const referenced = new Set(await this.links.referencedIds(allowedDocuments.map(row => row.id), plan.ids, transaction))
    // 资源行最后取共享锁；窗口按该事务的数据库时刻判断，元数据在 P1 只追加。
    const metadata = await this.assets.hold(plan.ids, transaction)
    return metadata.filter(row => referenced.has(row.assetId) || (row.uploaderId === plan.userId && row.withinUploadWindow)).map(row => row.assetId)
  }

  /** 仅实际写入新正文时调用；unchanged 与重放不得调用。目标已持排他锁或是事务新建的私有行。 */
  async replace(documentId: string, authorizedIds: readonly string[], transaction: Transaction): Promise<void> {
    await this.links.replace(documentId, authorizedIds, transaction)
  }

  /** 普通复制的调用方已在空间/文档一致性锁下确认可读，只复制当前关系，不扫描或提升正文中其他地址。 */
  async copy(source: HeldDocumentRow, targetId: string, transaction: Transaction): Promise<void> {
    const ids = await this.links.current(source.id, transaction)
    await this.assets.hold(ids, transaction)
    await this.links.copyFrom(source.id, targetId, transaction)
  }
}

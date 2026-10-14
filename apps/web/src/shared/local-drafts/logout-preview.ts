import type { DocumentDraftFact } from '@nerve-office/contracts'
import type { createDraftInventory } from './draft-inventory.ts'
import type { LogoutPreview } from './logout-flow.ts'

interface LogoutPreviewOptions {
  readonly inventory: Pick<ReturnType<typeof createDraftInventory>, 'load' | 'check'>
  readonly readFacts: (ids: readonly string[]) => Promise<ReadonlyMap<string, DocumentDraftFact>>
}

/** 预览只列元数据，不触发逐份恢复/清理；标题请求前后均核对原许可。 */
export async function loadLogoutPreview({ inventory, readFacts }: LogoutPreviewOptions): Promise<LogoutPreview> {
  const listed = await inventory.load()
  if (listed.kind !== 'listed')
    return listed
  const before = await inventory.check()
  if (before !== 'active')
    return { kind: 'unavailable', reason: before }
  let facts: ReadonlyMap<string, DocumentDraftFact> = new Map()
  let incomplete = listed.incomplete
  try {
    if (listed.entries.length > 0)
      facts = await readFacts(listed.entries.map(entry => entry.documentId))
  }
  catch {
    incomplete = true
  }
  const after = await inventory.check()
  if (after !== 'active')
    return { kind: 'unavailable', reason: after }
  return { ...listed, incomplete, entries: listed.entries.map((entry) => {
    const fact = facts.get(entry.documentId)
    return { ...entry, title: fact?.status === 'accessible' ? fact.title : undefined }
  }) }
}

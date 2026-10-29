import type { SessionImageAccessController } from '../../shared/lib/session-image-access.ts'
import { createSessionImageAccess } from '../../shared/lib/session-image-access.ts'

export type { SessionImageAccessController as EditorImageAccessController } from '../../shared/lib/session-image-access.ts'

/** 失败图片属于本页，阅读/编辑实例重建和同身份复核不自动重试。 */
export function createEditorImageAccess(owner: string): SessionImageAccessController {
  return createSessionImageAccess(owner, { preserveReadFailures: true })
}

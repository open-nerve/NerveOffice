// 共用编辑会话层的测试入口（M6-P1 S6 spec §2）：表格编辑器的测试经它取假件，以及只有测试用到的内部常量与函数（重试与轮询的间隔、
// 锁与频道的名字……），公开入口不为测试加名字。生产代码引用不到它（测试与测试辅助只被测试引用，eslint.config.ts）；
// 模块边界只给表格编辑器的测试代码开这一个文件。写法照 api 的 app/integration.test-support.ts（只给集成测试的入口）
export { SAME_USER_RETRIES, SAME_USER_RETRY_DELAY_MS, UNKNOWN_OUTCOME_RETRY_DELAY_MS } from './edit-lease.ts'
export { memoryIssuedRequest } from './issued-request.test-support.ts'
export { DRAFT_KEY, DRAFT_OPTIONS, newKey, persistentHarness } from './outbox/persistent-working-draft.test-support.ts'
export { createPersistentWorkingDraft } from './outbox/persistent-working-draft.ts'
export { keyOf } from './pending-save-marker.ts'
export type { MarkerStorage, PendingSave } from './pending-save-marker.ts'
export { READING_CHECK_INTERVAL_MS } from './reading-checks.ts'
export { fakeBrowser } from './same-browser.test-support.ts'
export type { FakeBrowser } from './same-browser.test-support.ts'
export { channelNameOf, issuedRequestLockNameOf, lockNameOf, onReply } from './same-browser.ts'
export type { HeldLock } from './same-browser.ts'
export { PENDING_SAVE_POLL_MS, TAB_HANDOVER_BUSY_RETRY_MS } from './self-takeover.ts'

// 发件箱的浏览器层探针（M4-P1 设计 §3.1、§4；apps/web/src/features/sheet-editor/outbox/testing/outbox-probe.ts）：只在测试构建里，
// 编辑器页的地址带 outboxProbe 时挂在 window.__nerveOutboxProbe 上。E2E 这边看不到 web 的类型，这里声明用到的部分（与探针的写法相同）。
// 打开的是一份不存在的文档：页面只确认会话（拿到 CSRF 令牌）、说明"内容不存在"，不建编辑器——探针不依赖编辑器，用例快。
// 用到探针的用例打上 @test-build：外部模式测生产镜像，里面没有探针，按标签排除（playwright.config.ts）
import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { expect } from './fixtures.ts'

export interface DraftKey {
  readonly userId: string
  readonly documentId: string
}

export interface ContentFormat {
  readonly clientBuild: string
  readonly univerVersion: string
  readonly profile: string
  readonly formatVersion: number
}

export interface InFlightSave {
  readonly requestId: string
  readonly clientInstanceId: string
  readonly localSeq: number
  readonly sentAt: number
}

export interface DraftMeta extends DraftKey {
  readonly recordVersion: number
  readonly draftSeq: number
  readonly baseRevision: number
  readonly writeEpoch: number
  readonly writerId: string
  readonly writtenBy: string
  readonly format: ContentFormat
  readonly formulasPending: boolean
  readonly keyVersion: number
  readonly inFlight: InFlightSave | null
  readonly rawBytes: number
  readonly updatedAt: number
}

export interface WriterIdentity {
  readonly writeEpoch: number
  readonly writerId: string
}

export interface ProbeError {
  readonly name: string
  readonly message: string
}

/** 存储这一侧的问题（错误只带名字与消息） */
export type ProbeProblem
  = | { readonly kind: 'quota' }
    | { readonly kind: 'unavailable', readonly reason: 'unsupported' | 'denied' | 'newer-version' | 'blocked' }
    | { readonly kind: 'failed', readonly error: ProbeError }

export interface ProbeDraftInput {
  readonly meta: Omit<DraftMeta, 'keyVersion' | 'rawBytes'>
  readonly content: string | { readonly randomBase64Chars: number }
}

export type ProbeOpened
  = | { readonly kind: 'opened', readonly content: string }
    | { readonly kind: 'unreadable', readonly reason: 'revoked' | 'corrupted' }
    | { readonly kind: 'no-key' }

export type ProbeRead
  = | { readonly kind: 'draft', readonly meta: DraftMeta, readonly ivHex: string, readonly ciphertextBytes: number, readonly opened: ProbeOpened }
    | { readonly kind: 'newer-format', readonly recordVersion: number }
    | { readonly kind: 'malformed' }

export type ProbeRegisterOutcome
  = | { readonly kind: 'registered', readonly lastDraftSeq: number, readonly existing: ProbeRead | undefined }
    | { readonly kind: 'superseded', readonly currentEpoch: number, readonly sameEpoch: boolean }
    | ProbeProblem

export type ProbeWriteOutcome
  = | { readonly kind: 'written' }
    | { readonly kind: 'fenced', readonly reason: 'not-writer' | 'stale-seq' | 'foreign-draft' | 'changed' }
    | ProbeProblem

export type ProbeConfirmOutcome
  = | { readonly kind: 'deleted' | 'rebased' | 'absent' | 'needs-rebase' }
    | { readonly kind: 'fenced', readonly reason: 'not-writer' | 'foreign-draft' }
    | ProbeProblem

export type ListedDraft
  = | { readonly kind: 'draft', readonly meta: DraftMeta }
    | { readonly kind: 'newer-format', readonly key: DraftKey, readonly recordVersion: number }
    | { readonly kind: 'malformed', readonly key: DraftKey }

export interface ProbeDatabaseShape {
  readonly version: number
  readonly stores: readonly { readonly name: string, readonly keyPath: string | readonly string[] | null, readonly indexes: readonly string[] }[]
}

export interface ProbeTransaction {
  readonly stores: readonly string[]
  readonly mode: string
  readonly durability: string | undefined
}

export type ProbeLocalKey
  = | { readonly kind: 'fetched', readonly version: number, readonly extractable: boolean, readonly usages: readonly string[], readonly algorithm: { readonly name: string, readonly length: number }, readonly exportRejected: string }
    | { readonly kind: 'failed', readonly error: ProbeError & { readonly status?: number, readonly code?: string } }

export interface ProbeStoreOptions {
  readonly blockedTimeoutMs?: number
  readonly factory?: 'browser' | 'missing' | 'throws'
}

export interface OutboxProbe {
  readonly names: { readonly database: string, readonly version: number, readonly drafts: string, readonly writers: string }
  readonly chooseKey: (version: number, rawHex?: string) => Promise<void>
  readonly resetStore: (options?: ProbeStoreOptions) => void
  readonly register: (key: DraftKey, writer: WriterIdentity, options: { readonly now: number, readonly force: boolean }) => Promise<ProbeRegisterOutcome>
  readonly write: (input: ProbeDraftInput, options?: { readonly adoptSeq?: number }) => Promise<ProbeWriteOutcome>
  readonly startWrite: (input: ProbeDraftInput) => number
  readonly settled: (operation: number) => Promise<ProbeWriteOutcome>
  readonly replace: (input: ProbeDraftInput) => Promise<ProbeWriteOutcome>
  readonly confirm: (key: DraftKey, writer: WriterIdentity, confirmedSeq: number, rebased?: ProbeDraftInput) => Promise<ProbeConfirmOutcome>
  readonly read: (key: DraftKey) => Promise<ProbeRead | { readonly kind: 'absent' } | ProbeProblem>
  readonly list: (userId: string) => Promise<{ readonly kind: 'listed', readonly drafts: readonly ListedDraft[] } | ProbeProblem>
  readonly remove: (key: DraftKey, expectedSeq?: number) => Promise<{ readonly kind: 'removed' | 'changed' | 'absent' } | ProbeProblem>
  readonly removeUser: (userId: string) => Promise<{ readonly kind: 'cleared' } | ProbeProblem>
  readonly purge: (now: number) => Promise<{ readonly kind: 'purged', readonly drafts: readonly { readonly key: DraftKey, readonly record: 'draft' | 'newer-format' | 'malformed' }[] } | ProbeProblem>
  readonly close: () => void
  readonly draftIds: (userId: string) => Promise<readonly string[]>
  readonly database: {
    readonly describe: () => Promise<ProbeDatabaseShape | null>
    readonly getRaw: (store: string, key: DraftKey) => Promise<Record<string, unknown> | null>
    readonly patchDraft: (key: DraftKey, patch: Readonly<Record<string, unknown>>) => Promise<void>
    readonly putRaw: (store: string, value: Readonly<Record<string, unknown>>) => Promise<void>
    readonly upgrade: (version: number, waitMs: number) => Promise<'upgraded' | 'blocked' | ProbeError>
    readonly hold: (version: number) => Promise<number>
    readonly release: (held: number) => void
    readonly openWith: (version: number, blockedTimeoutMs: number) => Promise<string>
    readonly remove: (waitMs: number) => Promise<'deleted' | 'blocked' | ProbeError>
    readonly exists: () => Promise<boolean>
    readonly holdTransaction: () => Promise<number>
    readonly releaseTransaction: (held: number) => Promise<void>
  }
  readonly localKey: {
    readonly fetch: () => Promise<ProbeLocalKey>
    readonly encryptHex: (plainHex: string, ivHex: string) => Promise<string>
  }
  readonly recordTransactions: () => void
  readonly failTransactions: (count: number, name: string) => void
  readonly writeMalformed: (input: ProbeDraftInput) => Promise<ProbeWriteOutcome>
  readonly transactions: () => readonly ProbeTransaction[]
}

declare global {
  interface Window {
    /** 只在测试构建里有 */
    __nerveOutboxProbe?: OutboxProbe
  }
}

type Method = Exclude<keyof OutboxProbe, 'names' | 'database' | 'localKey'>
type DatabaseMethod = keyof OutboxProbe['database']
type LocalKeyMethod = keyof OutboxProbe['localKey']

/**
 * 打开编辑器页、等探针挂上（要先登录：编辑器页先确认会话，没登录时整页跳到登录页）。默认打开一份不存在的文档——页面只确认会话、
 * 说明"内容不存在"，不建编辑器
 */
export async function openOutboxProbe(page: Page, documentId: string = randomUUID()): Promise<void> {
  await page.goto(`/documents/${documentId}?outboxProbe`)
  await expect.poll(async () => page.evaluate(() => window.__nerveOutboxProbe !== undefined), { message: '页面里没有发件箱的探针：要跑测试构建（web 的 build:e2e），地址带 outboxProbe' }).toBe(true)
}

/** 在页面里调探针的一个方法（参数与结果经 page.evaluate 序列化） */
export async function probe<M extends Method>(page: Page, method: M, ...args: Parameters<OutboxProbe[M]>): Promise<Awaited<ReturnType<OutboxProbe[M]>>> {
  return page.evaluate(async ({ method, args }) => {
    const target = window.__nerveOutboxProbe
    if (target === undefined)
      throw new Error('页面里没有发件箱的探针')
    return (target[method] as unknown as (...values: unknown[]) => unknown)(...args)
  }, { method, args }) as Promise<Awaited<ReturnType<OutboxProbe[M]>>>
}

/** 在页面里调探针的库一侧的方法（直接看库、改库，扮演别的页面） */
export async function probeDatabase<M extends DatabaseMethod>(page: Page, method: M, ...args: Parameters<OutboxProbe['database'][M]>): Promise<Awaited<ReturnType<OutboxProbe['database'][M]>>> {
  return page.evaluate(async ({ method, args }) => {
    const target = window.__nerveOutboxProbe
    if (target === undefined)
      throw new Error('页面里没有发件箱的探针')
    return (target.database[method] as unknown as (...values: unknown[]) => unknown)(...args)
  }, { method, args }) as Promise<Awaited<ReturnType<OutboxProbe['database'][M]>>>
}

/** 在页面里调探针的本机密钥一侧的方法（经生产的 fetchLocalKey 取、用它加密） */
export async function probeLocalKey<M extends LocalKeyMethod>(page: Page, method: M, ...args: Parameters<OutboxProbe['localKey'][M]>): Promise<Awaited<ReturnType<OutboxProbe['localKey'][M]>>> {
  return page.evaluate(async ({ method, args }) => {
    const target = window.__nerveOutboxProbe
    if (target === undefined)
      throw new Error('页面里没有发件箱的探针')
    return (target.localKey[method] as unknown as (...values: unknown[]) => unknown)(...args)
  }, { method, args }) as Promise<Awaited<ReturnType<OutboxProbe['localKey'][M]>>>
}

/** 结果是 kind 这一种（不是就失败，说明里带上整个结果），交回收窄了类型的它：用例里不写条件判断 */
export function outcomeOf<T extends { readonly kind: string }, K extends T['kind']>(outcome: T, kind: K): Extract<T, { readonly kind: K }> {
  expect(outcome.kind, JSON.stringify(outcome)).toBe(kind)
  return outcome as Extract<T, { readonly kind: K }>
}

/** 2026-10-09T08:00:00.000Z：用例里的"现在"（保留期按它往前推） */
export const NOW = Date.UTC(2026, 9, 9, 8, 0, 0)

/** 一天（毫秒） */
export const DAY_MS = 24 * 60 * 60 * 1000

/** 草稿的元数据（密钥版本取自探针当前的密钥，解压后的字节数按内容算）：默认是 writer 写下的第 seq 份，基于第 1 版、不在途 */
export function metaFor(key: DraftKey, writer: WriterIdentity, draftSeq: number, overrides: Partial<ProbeDraftInput['meta']> = {}): ProbeDraftInput['meta'] {
  return {
    userId: key.userId,
    documentId: key.documentId,
    recordVersion: 1,
    draftSeq,
    baseRevision: 1,
    writeEpoch: writer.writeEpoch,
    writerId: writer.writerId,
    writtenBy: `instance-${writer.writerId}`,
    format: { clientBuild: '0.1.0', univerVersion: '0.12.4', profile: 'sheet-v1', formatVersion: 1 },
    formulasPending: false,
    inFlight: null,
    updatedAt: NOW,
    ...overrides,
  }
}

/** 一份草稿：内容默认按写入者与序号生成（读回时据此认出是哪一份） */
export function draftFor(key: DraftKey, writer: WriterIdentity, draftSeq: number, overrides: Partial<ProbeDraftInput['meta']> = {}, content: ProbeDraftInput['content'] = contentOf(writer, draftSeq)): ProbeDraftInput {
  return { meta: metaFor(key, writer, draftSeq, overrides), content }
}

/** 写入者 writer 的第 seq 份的内容（含多字节字符） */
export function contentOf(writer: WriterIdentity, draftSeq: number): string {
  return JSON.stringify({ writer: writer.writerId, seq: draftSeq, cells: { A1: `第 ${draftSeq} 份 · 本机草稿 😀` } })
}

/** 一个新的写入者：第 epoch 代、随机的 writerId */
export function writerOf(writeEpoch: number): WriterIdentity {
  return { writeEpoch, writerId: randomUUID() }
}

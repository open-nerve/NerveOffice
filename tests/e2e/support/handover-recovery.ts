// 只调整真实 Worker 消息的送达顺序：不占存储互斥，不伪造回包，不通过第二次点击绕开交接准备。
// 默认上下文与 mirror.spec.ts 的串行持久上下文共用完整正文链路；前者的 WebKit 是无 OPFS 对照，后者才验证真实 MirrorBusy。
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import type { TestUser } from './database.ts'
import type { Workbook } from './sheet.ts'
import { Buffer } from 'node:buffer'
import { expireEditLease } from './database.ts'
import { expect } from './fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from './local-draft.ts'
import { loginThroughApi } from './session.ts'
import { cellOf, createSheetThroughApi, disconnectTab, enterEditButton, isSaveRequest, lostNotice, openAndEnterEditing, openReader, saveAndWait, savedContent, typeInCell, waitForEditorAccess, waitForLostToReading } from './sheet.ts'

interface GateEvent {
  readonly type: string
  readonly kind?: string
  readonly record?: string
  readonly error?: string
  readonly mirror?: { readonly kind: string, readonly reason?: string }
}

interface GateState {
  readonly held: boolean
  readonly terminated: boolean
  readonly events: readonly GateEvent[]
  readonly gateEvents: readonly GateEvent[]
}

interface GateWindow {
  readonly __recoveryTransport: { readonly arm: () => void, readonly release: () => void, readonly state: () => GateState }
}

async function installGate(page: Page, operation: 'read' | 'observe', direction: 'call' | 'reply'): Promise<void> {
  await page.addInitScript(({ operation, direction }) => {
    let armed = false
    let held = false
    let terminated = false
    let deliver: (() => void) | undefined
    const events: GateEvent[] = []
    let gateEvents: GateEvent[] | undefined
    Object.assign(window, { __recoveryTransport: {
      arm: () => { armed = true },
      release: () => {
        armed = false
        const pending = deliver
        deliver = undefined
        pending?.()
      },
      state: () => ({ held, terminated, events: [...events], gateEvents: [...(gateEvents ?? [])] }),
    } })
    const NativeWorker = Worker
    globalThis.Worker = class extends NativeWorker {
      readonly calls = new Map<number, string>()
      readonly ownEvents: GateEvent[] = []
      readonly outbox: boolean
      registered = false
      ownsGate = false

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.outbox = options?.name === 'nerve-outbox'
        this.addEventListener('message', (event) => {
          const reply = event.data as { id?: number, ok?: boolean, result?: { kind?: string, record?: { kind?: string }, error?: { name?: string }, mirror?: GateEvent['mirror'] } }
          if (reply.id === undefined)
            return
          const type = this.calls.get(reply.id)
          this.calls.delete(reply.id)
          if (type === undefined)
            return
          this.recordEvent({ type, kind: reply.result?.kind, record: reply.result?.record?.kind, error: reply.result?.error?.name, mirror: reply.result?.mirror })
          if (type === 'register' && reply.result?.kind === 'registered')
            this.registered = true
          if (armed && this.registered && type === operation && direction === 'reply') {
            armed = false
            held = true
            this.ownsGate = true
            gateEvents = this.ownEvents
            event.stopImmediatePropagation()
            // 相同对象只送一次；gzip 已从 Worker 转移，不能再克隆、重建或替换结果。
            const data: unknown = event.data
            deliver = () => this.dispatchEvent(new MessageEvent('message', { data }))
          }
        })
      }

      recordEvent(event: GateEvent): void {
        events.push(event)
        this.ownEvents.push(event)
      }

      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const call = message as { id: number, type: string }
        if (this.outbox)
          this.calls.set(call.id, call.type)
        const send = (): void => {
          try {
            if (Array.isArray(options))
              super.postMessage(message, options)
            else
              super.postMessage(message, options)
          }
          catch (error) {
            this.recordEvent({ type: `send:${call.type}`, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
            throw error
          }
        }
        if (armed && this.outbox && this.registered && call.type === operation && direction === 'call') {
          armed = false
          held = true
          this.ownsGate = true
          gateEvents = this.ownEvents
          deliver = send
        }
        else {
          send()
        }
      }

      override terminate(): void {
        if (this.ownsGate)
          terminated = true
        this.recordEvent({ type: 'terminate' })
        super.terminate()
      }
    }
  }, { operation, direction })
}

async function gateState(page: Page): Promise<GateState> {
  return page.evaluate(() => (window as unknown as GateWindow).__recoveryTransport.state())
}

async function arm(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as GateWindow).__recoveryTransport.arm())
}

async function release(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as GateWindow).__recoveryTransport.release())
}

function expectedAtGate(ordering: 'before' | 'after', mirrored: boolean): GateEvent {
  if (ordering === 'before')
    return { type: 'register', kind: 'registered' }
  return mirrored
    ? { type: 'observe', kind: 'failed', error: 'MirrorBusy' }
    : { type: 'observe', kind: 'observed', record: 'draft' }
}

interface HandoverRecoveryOptions {
  readonly page: Page
  readonly context: BrowserContext
  readonly owner: TestUser
  readonly ordering: 'before' | 'after'
  readonly mirrored: boolean
}

/** 真实 A1 已落盘后交接；一次编辑接上 A1+B1，旧页副本只能包含旧页自己的 A1。 */
export async function handoverRecovery({ page, context, owner, ordering, mirrored }: HandoverRecoveryOptions, testInfo: TestInfo): Promise<{ readonly cloud: Workbook, readonly copy: Workbook }> {
  await loginThroughApi(page, owner)
  const documentId = await createSheetThroughApi(page)
  const key = { userId: owner.id, documentId }
  await page.clock.install()
  await installGate(page, 'read', 'reply')
  await openAndEnterEditing(page, documentId)
  const secret = await currentLocalKey(page)
  const asleep = await disconnectTab(page)
  // 先固定一份真实网络失败的旧上传；新捕获不能成为该上传的 pin，也不能被生产自动保存直接留住 gzip。
  // 不回车、由保存提交，保证第一份在两种自动保存模式下都是这次显式请求。
  await typeInCell(page, 'A1', '仍在等待确认的旧上传', false)
  const failedSave = page.waitForEvent('requestfailed', { predicate: isSaveRequest })
  await page.keyboard.press('ControlOrMeta+s')
  await failedSave
  const initial = (await readLocalDisk(page, key)).draft
  const unknown = initial?.inFlight
  expect(unknown).not.toBeNull()
  expect(unknown).not.toBeUndefined()
  if (unknown === undefined || unknown === null)
    throw new Error('测试需要真实失败请求仍有在途标记')
  let other: Page | undefined
  let otherReady = false
  await arm(page)
  try {
    await typeInCell(page, 'A1', '旧页已经落盘的 A1')
    try {
      await expect.poll(async () => {
        const draft = (await readLocalDisk(page, key)).draft
        return draft === null
          ? undefined
          : {
              value: cellOf(JSON.parse(diskSnapshot(draft, secret)) as Workbook, 'A1')?.v,
              newerThanUpload: draft.draftSeq > unknown.localSeq,
              inFlight: draft.inFlight,
            }
      }).toEqual({ value: '旧页已经落盘的 A1', newerThanUpload: true, inFlight: unknown })
      // IDB 提交早于 Worker 回包；页面也确认当前捕获已持久化，失锁才必然从存储读回新正文。
      await expect(page.locator('[data-slot="local-save-status"]')).toHaveAttribute('data-local-save-state', 'saved')
    }
    finally {
      const disk = await readLocalDisk(page, key)
      await testInfo.attach('local-save-prerequisite', { body: Buffer.from(JSON.stringify({ transport: await gateState(page), writer: disk.writer, draftSeq: disk.draft?.draftSeq, inFlight: disk.draft?.inFlight, status: await page.locator('[data-slot="local-save-status"]').textContent(), localState: await page.locator('[data-slot="local-save-status"]').getAttribute('data-local-save-state') }, null, 2)), contentType: 'application/json' })
    }
    expect((await gateState(page)).events).toContainEqual(expect.objectContaining({ type: 'register', kind: 'registered', mirror: mirrored ? { kind: 'mirrored' } : { kind: 'not-mirrored', reason: 'unsupported' } }))
    await expireEditLease(documentId)
    const nextPage = await context.newPage()
    other = nextPage
    await installGate(nextPage, 'observe', ordering === 'before' ? 'call' : 'reply')
    await openReader(nextPage, documentId)
    otherReady = true
    await arm(nextPage)
    await enterEditButton(other).click()
    // 不扣 Worker 内的执行：read 和 observe 均已放开同源存储锁，只有消息运输被延迟。
    await expect.poll(async () => (await gateState(page)).held).toBe(true)
    await expect.poll(async () => (await gateState(nextPage)).held).toBe(true)
    expect((await gateState(page)).gateEvents).toContainEqual({ type: 'read', kind: 'draft', record: undefined, error: undefined, mirror: undefined })
    // Reader、公式等 Worker 可同时结束；交错前提必须绑定真正扣住消息的那一个宿主。
    const held = await gateState(other)
    expect(held.terminated).toBe(false)
    expect(held.gateEvents.at(-1)).toMatchObject({ ...expectedAtGate(ordering, mirrored) })
    await release(page)
    await expect.poll(async () => (await gateState(page)).terminated).toBe(true)
    await release(other)
    await waitForEditorAccess(other, 'edit')
    await typeInCell(other, 'B1', '新页的 B1')
    await saveAndWait(other)
    const cloud = (await savedContent(other, documentId)).snapshot
    await asleep.reconnect()
    await page.clock.fastForward(10_000)
    await expect(lostNotice(page)).toBeVisible()
    await lostNotice(page).getByRole('button', { name: '另存为副本', exact: true }).click()
    await waitForLostToReading(page)
    const link = page.locator('#editor-chrome').getByRole('link', { name: '打开副本（新标签页）', exact: true })
    await expect(link).toBeVisible()
    const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
    const copy = (await savedContent(page, copyId)).snapshot
    return { cloud, copy }
  }
  finally {
    await release(page)
    if (other !== undefined && otherReady)
      await release(other)
    await testInfo.attach('worker-transport-order', { body: Buffer.from(JSON.stringify({ ordering, oldPage: await gateState(page), newPage: other !== undefined && otherReady ? await gateState(other) : undefined }, null, 2)), contentType: 'application/json' })
  }
}

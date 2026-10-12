// 只调整真实 Worker 消息的送达顺序：不占存储互斥，不伪造回包，不通过第二次点击绕开交接准备。
import type { Page } from '@playwright/test'
import type { Workbook } from '../../support/sheet.ts'
import { Buffer } from 'node:buffer'
import { createUser, expireEditLease } from '../../support/database.ts'
import { expect, test } from '../../support/fixtures.ts'
import { currentLocalKey, diskSnapshot, readLocalDisk } from '../../support/local-draft.ts'
import { loginThroughApi } from '../../support/session.ts'
import { cellOf, createSheetThroughApi, disconnectTab, EDITOR_TEST_TIMEOUT, enterEditButton, lostNotice, openAndEnterEditing, openReader, saveAndWait, savedContent, typeInCell, waitForEditorAccess, waitForLostToReading } from '../../support/sheet.ts'

interface GateEvent {
  readonly type: string
  readonly kind?: string
  readonly record?: string
  readonly error?: string
}

interface GateState {
  readonly held: boolean
  readonly terminated: boolean
  readonly events: readonly GateEvent[]
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
    Object.assign(window, { __recoveryTransport: {
      arm: () => { armed = true },
      release: () => {
        const pending = deliver
        deliver = undefined
        pending?.()
      },
      state: () => ({ held, terminated, events: [...events] }),
    } })
    const NativeWorker = Worker
    globalThis.Worker = class extends NativeWorker {
      readonly calls = new Map<number, string>()
      readonly outbox: boolean
      registered = false
      ownsGate = false

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.outbox = options?.name === 'nerve-outbox'
        this.addEventListener('message', (event) => {
          const reply = event.data as { id?: number, ok?: boolean, result?: { kind?: string, record?: { kind?: string }, error?: { name?: string } } }
          if (reply.id === undefined)
            return
          const type = this.calls.get(reply.id)
          this.calls.delete(reply.id)
          if (type === undefined)
            return
          events.push({ type, kind: reply.result?.kind, record: reply.result?.record?.kind, error: reply.result?.error?.name })
          if (type === 'register' && reply.result?.kind === 'registered')
            this.registered = true
          if (armed && this.registered && type === operation && direction === 'reply') {
            armed = false
            held = true
            this.ownsGate = true
            event.stopImmediatePropagation()
            // 相同对象只送一次；gzip 已从 Worker 转移，不能再克隆、重建或替换结果。
            const data: unknown = event.data
            deliver = () => this.dispatchEvent(new MessageEvent('message', { data }))
          }
        })
      }

      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
        const call = message as { id: number, type: string }
        if (this.outbox)
          this.calls.set(call.id, call.type)
        const send = (): void => {
          if (Array.isArray(options))
            super.postMessage(message, options)
          else
            super.postMessage(message, options)
        }
        if (armed && this.outbox && this.registered && call.type === operation && direction === 'call') {
          armed = false
          held = true
          this.ownsGate = true
          deliver = send
        }
        else {
          send()
        }
      }

      override terminate(): void {
        if (this.ownsGate)
          terminated = true
        events.push({ type: 'terminate' })
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

test.describe.configure({ timeout: EDITOR_TEST_TIMEOUT })

for (const ordering of ['before', 'after'] as const) {
  const atGate = ordering === 'before' ? { type: 'register', kind: 'registered' } : { type: 'observe', kind: 'failed', error: 'MirrorUnverified' }

  test(`US-M4-06 旧页正文读回与新页恢复观察交错 ${ordering}：一次编辑接上 A1，旧页副本仍保留自己的正文`, async ({ page, context }, testInfo) => {
    const owner = await createUser(`recovery-busy-${ordering}`)
    await loginThroughApi(page, owner)
    const documentId = await createSheetThroughApi(page)
    const key = { userId: owner.id, documentId }
    await page.clock.install()
    await installGate(page, 'read', 'reply')
    await openAndEnterEditing(page, documentId)
    const secret = await currentLocalKey(page)
    const asleep = await disconnectTab(page)
    await typeInCell(page, 'A1', '旧页已经落盘的 A1')
    await expect.poll(async () => {
      const draft = (await readLocalDisk(page, key)).draft
      return draft === null ? undefined : cellOf(JSON.parse(diskSnapshot(draft, secret)) as Workbook, 'A1')?.v
    }).toBe('旧页已经落盘的 A1')
    await arm(page)
    await expireEditLease(documentId)
    const other = await context.newPage()
    await installGate(other, 'observe', ordering === 'before' ? 'call' : 'reply')
    await openReader(other, documentId)
    await arm(other)
    try {
      await enterEditButton(other).click()
      // 不扣 Worker 内的执行：read 和 observe 均已放开同源存储锁，只有消息运输被延迟。
      await expect.poll(async () => (await gateState(page)).held).toBe(true)
      await expect.poll(async () => (await gateState(other)).held).toBe(true)
      expect((await gateState(page)).events).toContainEqual({ type: 'read', kind: 'draft', record: undefined, error: undefined })
      expect((await gateState(other)).events.at(-1)).toMatchObject(atGate)
      await release(page)
      await expect.poll(async () => (await gateState(page)).terminated).toBe(true)
      await release(other)
      await waitForEditorAccess(other, 'edit')
      await typeInCell(other, 'B1', '新页的 B1')
      await saveAndWait(other)
      const cloud = (await savedContent(other, documentId)).snapshot
      expect([cellOf(cloud, 'A1')?.v, cellOf(cloud, 'B1')?.v]).toEqual(['旧页已经落盘的 A1', '新页的 B1'])
      await asleep.reconnect()
      await page.clock.fastForward(10_000)
      await expect(lostNotice(page)).toBeVisible()
      await lostNotice(page).getByRole('button', { name: '另存为副本', exact: true }).click()
      await waitForLostToReading(page)
      const link = page.locator('#editor-chrome').getByRole('link', { name: '打开副本（新标签页）', exact: true })
      await expect(link).toBeVisible()
      const copyId = (await link.getAttribute('href') ?? '').split('/').at(-1) ?? ''
      const copy = (await savedContent(page, copyId)).snapshot
      expect([cellOf(copy, 'A1')?.v, cellOf(copy, 'B1')]).toEqual(['旧页已经落盘的 A1', undefined])
    }
    finally {
      await release(page)
      await release(other)
      await testInfo.attach('worker-transport-order', { body: Buffer.from(JSON.stringify({ ordering, oldPage: await gateState(page), newPage: await gateState(other) }, null, 2)), contentType: 'application/json' })
    }
  })
}

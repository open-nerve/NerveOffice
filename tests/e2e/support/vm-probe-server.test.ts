import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVmDurabilityRound } from './vm-durability.ts'
import { createVmJournal, startVmProbeServer } from './vm-probe-server.ts'

const RUN = '7f1f40c3-1579-4657-9902-9f1f804fdde1'
const BOOT = '8f1f40c3-1579-4657-9902-9f1f804fdde1'
const message = { kind: 'boot', runId: RUN, bootId: BOOT }

async function withServer(run: (server: Awaited<ReturnType<typeof startVmProbeServer>>, journalPath: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nerve-vm-server-'))
  const journalPath = join(directory, 'journal.jsonl')
  const journal = await createVmJournal(journalPath)
  const round = createVmDurabilityRound({ runId: RUN, mode: 'control', durability: 'strict', cutAtSeq: 10, digestFor: () => 'a'.repeat(64), append: journal.append })
  const server = await startVmProbeServer({ round })
  try {
    await run(server, journalPath)
  }
  finally {
    await server.close()
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('VM loopback 收集器与真实 journal', () => {
  it('同源完成入口实际落档后才回复；页面脚本独立同源加载，无外部资源', async () => {
    await withServer(async (server, journalPath) => {
      expect(new URL(server.origin).hostname).toBe('127.0.0.1')
      const page = await fetch(server.url)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain('connect-src \'self\'')
      const html = await page.text()
      expect(html).not.toContain('http://')
      const scriptPath = /<script src="([^"]+)"/.exec(html)?.[1]
      expect(scriptPath).toBeDefined()
      const script = await fetch(new URL(scriptPath!, server.origin))
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toContain('javascript')
      expect(await script.text()).toContain('indexedDB')
      const response = await fetch(server.controlUrl, { method: 'POST', headers: { 'origin': server.origin, 'content-type': 'application/json' }, body: JSON.stringify(message) })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ kind: 'write' })
      const saved = (await readFile(journalPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown)
      expect(saved).toEqual([expect.objectContaining(message)])
    })
  })

  it.each([
    { method: 'GET', expected: 405 },
    { origin: 'https://other.test', expected: 403 },
    { origin: '', expected: 403 },
    { type: 'text/plain', expected: 415 },
    { body: '{', expected: 400 },
    { body: 'x'.repeat(8193), expected: 413 },
    { path: '/__vm-probe/unknown', expected: 404 },
    { body: JSON.stringify({ ...message, runId: BOOT }), expected: 200 },
    { body: JSON.stringify({ ...message, secret: '不得落档' }), expected: 200 },
  ])('错误请求不落档：%j', async (change) => {
    await withServer(async (server, journalPath) => {
      const options = change as { method?: string, origin?: string, type?: string, body?: string, path?: string, expected: number }
      const method = options.method ?? 'POST'
      const response = await fetch(options.path === undefined ? server.controlUrl : new URL(options.path, server.origin), {
        method,
        headers: { 'origin': options.origin ?? server.origin, 'content-type': options.type ?? 'application/json' },
        body: method === 'GET' ? undefined : options.body ?? JSON.stringify(message),
      })
      expect(response.status).toBe(options.expected)
      expect(await response.json()).toEqual({ kind: 'stop' })
      expect(await readFile(journalPath, 'utf8')).toBe('')
    })
  })

  it('已有 journal 不允许覆盖；关闭后不能再追加', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nerve-vm-journal-'))
    const path = join(directory, 'journal.jsonl')
    try {
      const journal = await createVmJournal(path)
      await journal.append({ kind: 'first' })
      await expect(createVmJournal(path)).rejects.toThrow()
      await journal.close()
      await expect(journal.append({ kind: 'late' })).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('{"kind":"first"}\n')
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

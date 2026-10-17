import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { createVmDurabilityRound } from './vm-durability.ts'
import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { VM_FAILURE_NAMES } from './vm-durability.ts'
import { vmProbeBytes, vmProbePage } from './vm-probe-page.ts'

export async function createVmJournal(path: string) {
  const file = await open(path, 'wx', 0o600)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  }
  catch (error) {
    await file.close()
    throw error
  }
  finally {
    await directory.close()
  }
  let closed = false
  let queue = Promise.resolve()
  return {
    append: async (event: unknown): Promise<void> => {
      if (closed)
        throw new Error('VM journal 已关闭')
      const text = `${JSON.stringify(event)}\n`
      const written = queue.then(async () => {
        await file.appendFile(text, 'utf8')
        await file.sync()
      })
      // 失败后保持失败，不能在部分记录之后再拼接出貌似完整的 journal。
      queue = written
      await written
    },
    close: async (): Promise<void> => {
      if (closed)
        return
      closed = true
      try {
        await queue
      }
      finally {
        await file.close()
      }
    },
  }
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function bodyOf(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = part as Buffer
    size += chunk.length
    if (size <= 8192)
      chunks.push(chunk)
  }
  return size > 8192 ? undefined : Buffer.concat(chunks)
}

export async function startVmProbeServer(options: { readonly round: ReturnType<typeof createVmDurabilityRound> }) {
  const { round } = options
  const { runId, durability } = round.snapshot()
  const start = `/__vm-probe/${runId}`
  const controlPath = `${start}/control`
  let origin = ''
  const control = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      reply(response, 405, { kind: 'stop' })
      return
    }
    if (request.headers.origin !== origin || request.headers.host !== new URL(origin).host) {
      reply(response, 403, { kind: 'stop' })
      return
    }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      reply(response, 415, { kind: 'stop' })
      return
    }
    const body = await bodyOf(request)
    if (body === undefined) {
      reply(response, 413, { kind: 'stop' })
      return
    }
    let message: unknown
    try {
      message = JSON.parse(body.toString('utf8'))
    }
    catch {
      reply(response, 400, { kind: 'stop' })
      return
    }
    reply(response, 200, await round.receive(message))
  }
  const server = createServer((request, response) => {
    if (request.url === controlPath) {
      void control(request, response).catch(() => {
        if (!response.headersSent)
          reply(response, 400, { kind: 'stop' })
        else
          response.destroy()
      })
    }
    else if (request.method === 'GET' && request.url === start) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': 'default-src \'none\'; script-src \'self\'; connect-src \'self\'; base-uri \'none\'; frame-ancestors \'none\'',
        'x-content-type-options': 'nosniff',
      })
      response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>NerveOffice VM 存储实验</title><h1>专用 VM 存储实验</h1><p id="status">等待宿主</p><script src="${start}/page.js" defer></script></html>`)
    }
    else if (request.method === 'GET' && request.url === `${start}/page.js`) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(`const vmProbeBytes = ${vmProbeBytes.toString()};\nvoid (${vmProbePage.toString()})(${JSON.stringify({ runId, durability, controlPath, failureNames: VM_FAILURE_NAMES })});`)
    }
    else if (request.method === 'GET' && request.url === '/favicon.ico') {
      response.writeHead(204)
      response.end()
    }
    else {
      reply(response, 404, { kind: 'stop' })
    }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 15_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    origin,
    url: `${origin}${start}`,
    controlUrl: `${origin}${controlPath}`,
    close: async (): Promise<void> => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ActivityWatch } from './desktop.ts'
// 真实 Safari 存储边界探针。窗口由任务操作者经原生 UI 创建/确认；本入口只读窗口元数据。
// node safari/storage-boundary.ts --output <新目录>；准备后 stdin 输入 arm <caseId> <windowId>，四轮完成后输入 finish。
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { hidIdleSeconds, screenLocked, watchActivity } from './desktop.ts'
import { storageBoundaryResultsValid } from './storage-boundary-results.ts'
import { STORAGE_BOUNDARY_WORKER, storageBoundaryPage } from './storage-boundary-source.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { output: { type: 'string' }, profile: { type: 'string' } }, strict: true })
  if (process.platform !== 'darwin' || values.output === undefined || !values.profile?.startsWith('NerveOffice '))
    throw new Error('需要本机 macOS、任务场景名称与新输出目录')
  const output = resolve(values.output)
  mkdirSync(output, { mode: 0o700 })
  const runId = randomUUID()
  const cases = ['normal-write', 'normal-read', 'private-write', 'private-read'] as const
  const prefix = `/__nerve-storage-boundary/${runId}`
  const controlPath = `${prefix}/control`
  const workerPath = `${prefix}/worker.js`
  let origin = ''
  let current = 0
  let armed = false
  let startedAt = 0
  let bootId: string | undefined
  let windowId = 0
  let watcher: ActivityWatch | undefined
  let invalid: string | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  const desktop: {
    at: number
    idleSeconds: number
    locked: boolean
  }[] = []
  const observations: Record<string, unknown>[] = []
  const windows: number[] = []
  const deadline = Date.now() + 60 * 60000
  const requests = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('begin'), runId: z.uuid(), caseId: z.enum(cases), bootId: z.uuid() }),
    z.strictObject({ kind: z.literal('complete'), runId: z.uuid(), caseId: z.enum(cases), bootId: z.uuid(), report: z.record(z.string(), z.unknown()) }),
    z.strictObject({ kind: z.literal('failed'), runId: z.uuid(), caseId: z.enum(cases), bootId: z.uuid() }),
  ])
  const version = execFileSync('defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim()
  const macosVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
  const inputHashes = (): Record<string, string> => Object.fromEntries(['storage-boundary.ts', 'storage-boundary-source.ts', 'storage-boundary-results.ts', 'desktop.ts'].map(name => [name, createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex')]))
  const inputs = inputHashes()
  const save = (): void => writeFileSync(join(output, 'report.json'), `${JSON.stringify({ kind: 'real-safari-storage-boundary', runId, origin, safariVersion: version, macosVersion, normalProfile: values.profile, inputs, sourceUnchanged: JSON.stringify(inputs) === JSON.stringify(inputHashes()), current: cases[current] ?? null, invalid, observations }, null, 2)}\n`, { mode: 0o600 })
  const mapScript = `function run(a){const s=Application('Safari'),ws=s.windows(),old=JSON.parse(a[2]);return JSON.stringify({at:Date.now(),oldWindowsAbsent:old.every(id=>!ws.some(w=>w.id()===id)),target:ws.filter(w=>w.id()===Number(a[0])).map(w=>({windowId:w.id(),normalProfileMatches:w.name().startsWith(a[4]+' — '),tabs:w.tabs().map(t=>({matches:t.url()===a[1]}))})),sameOriginWindows:ws.filter(w=>w.tabs().some(t=>t.url().startsWith(a[3]+'/'))).map(w=>w.id())});}`
  const bindingSchema = z.object({ at: z.number(), oldWindowsAbsent: z.boolean(), target: z.array(z.object({ windowId: z.number(), normalProfileMatches: z.boolean(), tabs: z.array(z.object({ matches: z.boolean() })) })), sameOriginWindows: z.array(z.number()) })
  function binding(): z.infer<typeof bindingSchema> {
    const url = `${origin + prefix}/${cases[current]}`
    const value = bindingSchema.parse(JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', mapScript, String(windowId), url, JSON.stringify(windows), origin, values.profile!], { encoding: 'utf8', timeout: 5000 })))
    if (!value.oldWindowsAbsent || value.target.length !== 1 || value.target[0]?.tabs.length !== 1 || value.target[0].tabs[0]?.matches !== true || value.sameOriginWindows.length !== 1 || value.sameOriginWindows[0] !== windowId)
      throw new Error('本轮独占页面或前轮窗口已关闭的证据不符')
    if (cases[current]?.startsWith('normal-') && value.target[0].normalProfileMatches !== true)
      throw new Error('正常窗口不属于同一任务场景')
    return value
  }
  function guard(): void {
    const idleSeconds = hidIdleSeconds() ?? -1
    const locked = screenLocked()
    desktop.push({ at: Date.now(), idleSeconds, locked })
    if (locked || idleSeconds < 120 || watcher?.returnedAt() !== undefined)
      invalid ??= '桌面活动或锁屏使本轮作废'
    if (Date.now() >= deadline)
      invalid ??= '总时限到达'
    if (invalid !== undefined)
      throw new Error(invalid)
  }
  function stopWatch(): void {
    watcher?.stop()
    watcher = undefined
    if (monitor !== undefined)
      clearInterval(monitor)
    monitor = undefined
  }
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const reply = (status: number, value: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    if (request.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      reply(403, { kind: 'stop' })
      return
    }
    const url = request.url
    if (request.method === 'GET' && url === workerPath) {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      response.end(STORAGE_BOUNDARY_WORKER)
      return
    }
    if (request.method === 'GET' && cases.some(id => url === `${prefix}/${id}`)) {
      const caseId = cases.find(id => url === `${prefix}/${id}`)!
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'default-src \'none\'; script-src \'unsafe-inline\'; worker-src \'self\'; connect-src \'self\'' })
      response.end(storageBoundaryPage({ runId, caseId, operation: caseId.endsWith('write') ? 'write' : 'read', workerPath, controlPath }))
      return
    }
    if (url !== controlPath || request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
      reply(403, { kind: 'stop' })
      return
    }
    try {
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const data of request) {
        const chunk = data as Buffer
        bytes += chunk.length
        if (bytes > 32768) {
          reply(413, { kind: 'stop' })
          return
        }
        chunks.push(chunk)
      }
      const message = requests.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (message.runId !== runId || message.caseId !== cases[current] || invalid !== undefined) {
        reply(409, { kind: 'stop' })
        return
      }
      if (bootId !== undefined && message.bootId !== bootId)
        throw new Error('本轮页面重复启动')
      bootId ??= message.bootId
      if (message.kind === 'begin') {
        if (startedAt !== 0)
          throw new Error('已执行的探针重复请求开始')
        if (!armed || screenLocked() || (hidIdleSeconds() ?? 0) < 120) {
          reply(200, { kind: 'wait' })
          return
        }
        const initialBinding = binding()
        watcher = watchActivity()
        guard()
        startedAt = Date.now()
        observations.push({ caseId: cases[current], windowId, initialBinding, startedAt, uiModeVerification: '由操作者原生 UI 取证，回执另存' })
        monitor = setInterval(() => {
          try {
            guard()
          }
          catch {
            save()
          }
        }, 1000)
        reply(200, { kind: 'start' })
        return
      }
      if (message.kind === 'failed' || !armed || startedAt === 0)
        throw new Error('探针未执行或失败')
      guard()
      const finalBinding = binding()
      stopWatch()
      const report = message.report
      Object.assign(observations.at(-1)!, { receivedReport: report })
      if (!storageBoundaryResultsValid(report))
        throw new Error('Storage outcomes missing, malformed or timed out')
      if (report.origin !== origin || report.secureContext !== true || report.operation !== (cases[current]?.endsWith('write') ? 'write' : 'read') || typeof report.startedAt !== 'number' || report.startedAt < startedAt || typeof report.finishedAt !== 'number' || report.finishedAt < report.startedAt || report.finishedAt > Date.now() || !Array.isArray(report.visibility) || report.visibility.some((v: unknown) => typeof v !== 'object' || v === null || !('state' in v) || v.state !== 'visible'))
        throw new Error('页面报告身份、时间或可见性不符')
      Object.assign(observations.at(-1)!, { finishedAt: Date.now(), finalBinding, desktop: [...desktop], report })
      windows.push(windowId)
      current += 1
      armed = false
      startedAt = 0
      bootId = undefined
      desktop.length = 0
      save()
      process.stdout.write(`${JSON.stringify({ completed: message.caseId, next: cases[current] ?? null })}\n`)
      reply(200, { kind: 'recorded' })
    }
    catch {
      invalid ??= '探针协议、窗口或页面报告不完整'
      stopWatch()
      save()
      reply(400, { kind: 'stop' })
    }
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      invalid ??= '请求处理失败'
      stopWatch()
      save()
      response.destroy()
      process.exitCode = 1
    })
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  save()
  process.stdout.write(`${JSON.stringify({ output, runId, origin, visits: cases.map(caseId => ({ caseId, url: `${origin + prefix}/${caseId}` })) })}\n`)
  const reader = createInterface({ input: process.stdin })
  reader.on('line', (line) => {
    try {
      const [kind, id, windowText] = line.trim().split(/\s+/)
      if (kind === 'finish' && current === cases.length && invalid === undefined) {
        if (JSON.stringify(inputs) !== JSON.stringify(inputHashes()))
          throw new Error('探针源码变化')
        save()
        reader.close()
        server.close()
        return
      }
      if (kind !== 'arm' || id !== cases[current] || !Number.isSafeInteger(Number(windowText)) || Number(windowText) < 1 || armed || screenLocked())
        throw new Error('本轮 arm 参数或桌面状态不符')
      windowId = Number(windowText)
      binding()
      armed = true
      save()
      process.stdout.write(`${JSON.stringify({ armed: id, windowId, idleSeconds: hidIdleSeconds() })}\n`)
    }
    catch {
      process.stdout.write(`${JSON.stringify({ refused: true, current: cases[current] ?? null })}\n`)
    }
  })
  function halt(): void {
    invalid ??= '宿主退出或总时限到达'
    stopWatch()
    save()
    server.close()
    server.closeAllConnections()
    reader.close()
    process.exitCode = 1
  }
  reader.on('close', () => {
    if (current !== cases.length) {
      halt()
    }
    else {
      server.close()
      server.closeAllConnections()
    }
  })
  process.on('SIGINT', halt)
  process.on('SIGTERM', halt)
  const timer = setTimeout(halt, 60 * 60000)
  timer.unref()
}
main().catch(() => {
  process.stderr.write('Safari 存储探针无法初始化；请核对参数和新输出目录。\n')
  process.exitCode = 1
})

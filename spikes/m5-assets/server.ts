import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { SECURITY_HEADERS } from '../../apps/api/src/modules/security/security-headers.ts'

const { values } = parseArgs({ options: { build: { type: 'string' }, output: { type: 'string' }, port: { type: 'string', default: '0' } } })
if (!values.build || !values.output || !isAbsolute(values.build) || !isAbsolute(values.output))
  throw new Error('--build 与 --output 必须指定本轮绝对路径')
const output = values.output
if (existsSync(output)) throw new Error('拒绝覆盖已有运行目录；使用新 --output')
const build = values.build
const identity = JSON.parse(readFileSync(join(build, 'build-identity.json'), 'utf8'))
const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.json', 'application/json']])
const files = new Map<string, { bytes: Buffer, type: string }>()
function addFiles(directory: string, prefix: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const key = `${prefix}/${entry.name}`
    if (entry.isDirectory()) addFiles(join(directory, entry.name), key)
    else if (mime.has(extname(entry.name))) files.set(key, { bytes: readFileSync(join(directory, entry.name)), type: mime.get(extname(entry.name))! })
  }
}
addFiles(build, '')
addFiles(resolve(import.meta.dirname, 'fixtures'), '/fixtures')
mkdirSync(output, { recursive: true })
mkdirSync(join(output, 'images'))
writeFileSync(join(output, 'build-identity.json'), `${JSON.stringify(identity, null, 2)}\n`)
const recordsPath = join(output, 'records.ndjson')
writeFileSync(recordsPath, '')
const cookie = randomUUID()
let origin = ''
let recordBytes = 0
let imageBytes = 0
const images = new Map<string, { bytes: Buffer, type: string }>()

const server = createServer(async (req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value)
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  if (req.headers.host !== new URL(origin).host) { json(400, { error: 'loopback host required' }); return }
  let path: string
  try { path = new URL(req.url ?? '/', origin).pathname } catch { json(400, { error: 'url' }); return }
  appendFileSync(join(output, 'requests.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path, cookiePresent: req.headers.cookie?.split(';').some(value => value.trim() === `m5_probe=${cookie}`) ?? false, origin: req.headers.origin ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null })}\n`)
  try {
    if (req.method === 'POST') {
      if (req.headers.origin !== origin) { json(403, { error: 'same origin required' }); return }
      if (path !== '/records' && path !== '/probe-images') { json(404, { error: 'route' }); return }
      const limit = path === '/records' ? 65536 : 5 * 1024 * 1024
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > limit) { json(413, { error: 'body limit' }); req.resume(); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks)
      if (path === '/records') {
        const record = JSON.parse(body.toString('utf8'))
        if (record.schemaVersion !== 1 || record.buildId !== identity.buildId || record.sdkVersion !== '1.0.1' || !Number.isSafeInteger(record.seq) || typeof record.runId !== 'string') { json(400, { error: 'record identity' }); return }
        if (recordBytes + length > 64 * 1024 * 1024) { json(507, { error: 'record budget' }); return }
        recordBytes += length
        appendFileSync(recordsPath, `${JSON.stringify({ ...record, receivedAt: new Date().toISOString() })}\n`)
        json(201, { recorded: true }); return
      }
      const type = req.headers['content-type'] ?? ''
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)) { json(415, { error: 'fixture type' }); return }
      if (imageBytes + length > 32 * 1024 * 1024) { json(507, { error: 'fixture budget' }); return }
      const imageId = randomUUID()
      images.set(imageId, { bytes: body, type }); imageBytes += length
      writeFileSync(join(output, 'images', imageId), body, { flag: 'wx' })
      appendFileSync(join(output, 'images.ndjson'), `${JSON.stringify({ imageId, type, bytes: length, sha256: createHash('sha256').update(body).digest('hex') })}\n`)
      json(201, { imageId, source: `${origin}/probe-images/${imageId}` }); return
    }
    if (req.method !== 'GET') { json(405, { error: 'method' }); return }
    if (path === '/records') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.end(readFileSync(recordsPath)); return }
    if (path === '/health') { json(200, { buildId: identity.buildId, sdkVersion: identity.sdkVersion, recordBytes }); return }
    const file = path.startsWith('/probe-images/') ? images.get(path.slice('/probe-images/'.length)) : files.get(path === '/' ? '/index.html' : path)
    if (!file) { json(404, { error: 'not found' }); return }
    if (path === '/' || path === '/index.html') res.setHeader('Set-Cookie', `m5_probe=${cookie}; HttpOnly; SameSite=Strict; Path=/`)
    res.writeHead(200, { 'Content-Type': file.type }); res.end(file.bytes)
  }
  catch (error) { appendFileSync(join(output, 'errors.ndjson'), `${JSON.stringify({ at: new Date().toISOString(), path, error: String(error) })}\n`); if (!res.headersSent) json(500, { error: 'probe server' }); else res.end() }
})
server.listen(Number(values.port), '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen')
  origin = `http://127.0.0.1:${address.port}`
  const result = { origin, pid: process.pid, buildId: identity.buildId, output, startedAt: new Date().toISOString() }
  writeFileSync(join(output, 'server.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))

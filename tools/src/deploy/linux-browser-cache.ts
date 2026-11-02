import type { BoundedCapture } from './container-e2e-resources.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { parseContainerJson } from './container-e2e-json.ts'
import { GIB, PLAYWRIGHT_IMAGE } from './linux-browser.ts'

const FILE = 'linux-browser-image.json'
const MAX_AGE = 14 * 24 * 60 * 60 * 1000
const imageSchema = z.object({
  id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative().max(5 * GIB),
  os: z.literal('linux'),
  arch: z.literal('arm64'),
  tags: z.array(z.string()).nullable(),
  digests: z.array(z.string()),
}).strict()
const recordSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  daemon: z.string().min(1),
  ref: z.literal(PLAYWRIGHT_IMAGE),
  createdAt: z.number(),
  expiresAt: z.number(),
  maxBytes: z.literal(5 * GIB),
  state: z.enum(['intent', 'acquired', 'borrowed', 'released', 'shared', 'uncertain']),
  image: imageSchema.nullable(),
}).strict()
type Record = z.infer<typeof recordSchema>

const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex')
function read(path: string): { value: Record, sha: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > 64 * 1024)
      throw new Error('image-ledger-size')
    const bytes = Buffer.alloc(64 * 1024 + 1)
    let count = 0
    while (count < bytes.length) {
      const readBytes = readSync(fd, bytes, count, bytes.length - count, null)
      if (readBytes === 0)
        break
      count += readBytes
    }
    if (count > 64 * 1024)
      throw new Error('image-ledger-size')
    const payload = bytes.subarray(0, count)
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    return { value: recordSchema.parse(parseContainerJson(raw)), sha: hash(payload) }
  }
  finally { closeSync(fd) }
}

/**
 * Parent holds this worktree's container publication lock. Old uncertain pulls
 * are identified but never adopted or globally pruned after a forced stop.
 */
export function assertNoOutstandingImageCache(runs: string, now = Date.now()): void {
  for (const name of readdirSync(runs)) {
    const directory = join(runs, name)
    if (lstatSync(directory).isSymbolicLink())
      throw new Error('image-ledger-directory')
    if (!lstatSync(directory).isDirectory())
      continue
    if (!readdirSync(directory).includes(FILE))
      continue
    const record = read(join(directory, FILE)).value
    if (record.runId !== name)
      throw new Error('image-ledger-run')
    if (['intent', 'acquired', 'uncertain'].includes(record.state)
      || (record.state === 'shared' && record.expiresAt <= now)) {
      throw new Error('image-cache-requires-reconciliation')
    }
  }
}

export class LinuxBrowserCache {
  private readonly directory: string
  private readonly runId: string
  private readonly capture: BoundedCapture
  private record: Record | undefined
  private saved: string | undefined

  constructor(directory: string, runId: string, capture: BoundedCapture) {
    this.directory = directory
    this.runId = runId
    this.capture = capture
  }

  private query(args: readonly string[]): string {
    const result = this.capture(args)
    if (result.status !== 0 || result.stderr.trim() !== '')
      throw new Error('image-query-failed')
    return result.stdout.trim()
  }

  private image(): z.infer<typeof imageSchema> | null {
    const format = '{"id":{{json .Id}},"bytes":{{json .Size}},"os":{{json .Os}},"arch":{{json .Architecture}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}'
    const result = this.capture(['image', 'inspect', '--format', format, PLAYWRIGHT_IMAGE])
    if (result.status === 1 && !result.stdout.trim()
      && /^(?:Error response from daemon: |Error: )?No such image:/.test(result.stderr.trim())) {
      return null
    }
    if (result.status !== 0 || result.stderr.trim())
      throw new Error('image-query-failed')
    const value = imageSchema.parse(parseContainerJson(result.stdout))
    if (!value.digests.includes(PLAYWRIGHT_IMAGE))
      throw new Error('image-digest-mismatch')
    return value
  }

  private persist(initial = false): void {
    if (this.record === undefined)
      throw new Error('image-not-reserved')
    const path = join(this.directory, FILE)
    if (!initial)
      this.assertUnchanged()
    const temporary = initial ? path : `${path}.tmp`
    const raw = `${JSON.stringify(this.record, null, 2)}\n`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, raw)
      fsyncSync(fd)
    }
    finally { closeSync(fd) }
    if (!initial)
      renameSync(temporary, path)
    const directory = openSync(this.directory, 'r')
    try {
      fsyncSync(directory)
    }
    finally { closeSync(directory) }
    this.saved = hash(raw)
  }

  private assertUnchanged(): void {
    if (this.saved === undefined || read(join(this.directory, FILE)).sha !== this.saved)
      throw new Error('image-ledger-changed')
  }

  reserve(): boolean {
    const daemon = this.query(['info', '--format', '{{.ID}}'])
    const image = this.image()
    this.record = { version: 1, runId: this.runId, daemon, ref: PLAYWRIGHT_IMAGE, createdAt: Date.now(), expiresAt: Date.now() + MAX_AGE, maxBytes: 5 * GIB, state: image === null ? 'intent' : 'borrowed', image }
    this.persist(true)
    return image === null
  }

  acquired(): number {
    this.assertUnchanged()
    const record = this.record
    if (record === undefined || this.query(['info', '--format', '{{.ID}}']) !== record.daemon)
      throw new Error('image-daemon-changed')
    const image = this.image()
    if (image === null || (record.image !== null && record.image.id !== image.id))
      throw new Error('image-missing-or-changed')
    record.image = image
    if (record.state !== 'borrowed')
      record.state = 'acquired'
    this.persist()
    return record.state === 'borrowed' ? 0 : image.bytes
  }

  release(quiescent: boolean): boolean {
    const record = this.record
    if (record === undefined)
      return true
    try {
      this.assertUnchanged()
      if (record.state === 'released' || record.state === 'borrowed' || record.state === 'shared')
        return true
      if (!quiescent || record.state === 'intent' || record.state === 'uncertain')
        throw new Error('image-pull-not-proven')
      if (this.query(['info', '--format', '{{.ID}}']) !== record.daemon)
        throw new Error('image-daemon-changed')
      const image = this.image()
      if (image !== null) {
        if (image.id !== record.image?.id)
          throw new Error('image-replaced')
        const users = this.query(['container', 'ls', '-a', '--no-trunc', '--filter', `ancestor=${image.id}`, '--format', '{{.ID}}'])
        if (users || (image.tags?.length ?? 0) > 0 || image.digests.some(ref => ref !== PLAYWRIGHT_IMAGE)) {
          record.state = 'shared'
          this.persist()
          return true
        }
        this.query(['image', 'rm', PLAYWRIGHT_IMAGE])
        if (this.image() !== null)
          throw new Error('image-still-present')
      }
      record.state = 'released'
      this.persist()
      return true
    }
    catch {
      record.state = 'uncertain'
      try {
        this.persist()
      }
      catch {
        // Changed/unknown metadata stays untouched; the caller records failure.
      }
      return false
    }
  }
}

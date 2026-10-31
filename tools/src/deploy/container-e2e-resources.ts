/** 本轮 Docker 归属。只查询当前 UUID 命名空间；旧 PID/其他运行从不接管。 */
import type { ContainerE2eSettings } from './container-e2e.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import process from 'node:process'
import { TextDecoder } from 'node:util'
import { z } from 'zod'
import { parseContainerJson } from './container-e2e-json.ts'

const LIMIT = 64 * 1024
const FILE = 'container-resources.json'
const RUN_LABEL = 'org.nerve-office.test.run'
const REPO_LABEL = 'org.nerve-office.test.repo'
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
const boundedText = z.string().min(1).max(256)
const kinds = ['containers', 'networks', 'volumes', 'images'] as const
type Kind = typeof kinds[number]
type Inventory = Record<Kind, string[]>
const empty = (): Inventory => ({ containers: [], networks: [], volumes: [], images: [] })
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const objectSchema = z.object({
  id: boundedText,
  name: boundedText,
  run: z.string().nullable(),
  repo: z.string().nullable(),
  project: z.string().nullable(),
})

export interface ContainerRunContext {
  readonly directory: string
  readonly runId: string
  readonly repo: string
  readonly scratch: string
}
export interface ResourceCapture {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}
export type BoundedCapture = (args: readonly string[]) => ResourceCapture
interface Ledger extends ContainerRunContext {
  readonly version: 1
  state: 'reserved' | 'pending' | 'closed'
  readonly daemon: string
  readonly repoHash: string
  readonly project: string
  readonly image: string
  readonly temporaryDirectory: string
  producers: (number | null)[]
  observed: Inventory
  observedImageIds?: Record<string, string>
  cleanupFailures?: string[]
  problem?: string
  closure?: { daemon: string, observedAt: string, absent: Inventory }
}

function readBounded(path: string): { value: unknown, sha: string } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > LIMIT)
      throw new Error('container-ledger-file')
    const buffer = Buffer.alloc(LIMIT + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, null)
      if (count === 0)
        break
      size += count
    }
    if (size > LIMIT)
      throw new Error('container-ledger-size')
    const raw = buffer.subarray(0, size)
    return { value: parseContainerJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)), sha: hash(raw) }
  }
  finally {
    closeSync(descriptor)
  }
}

export class ContainerRunResources {
  readonly labels: readonly string[]
  readonly repoHash: string
  private readonly context: ContainerRunContext
  private readonly settings: ContainerE2eSettings
  private readonly capture: BoundedCapture
  private fingerprint: string
  private ledger: Ledger | undefined

  constructor(context: ContainerRunContext, settings: ContainerE2eSettings, capture: BoundedCapture) {
    this.context = context
    this.settings = settings
    this.capture = capture
    uuid.parse(context.runId)
    if (realpathSync(context.directory) !== context.directory || realpathSync(context.repo) !== context.repo
      || realpathSync(context.scratch) !== context.scratch || context.scratch !== join(context.directory, 'scratch')
      || context.directory !== join(context.repo, '.test-resources/runs', context.runId)
      || settings.project !== `nerve-office-e2e-${context.runId}` || settings.image !== `nerve-office:e2e-${context.runId}`) {
      throw new Error('container-parent-identity')
    }
    const parent = z.object({ runId: uuid, repo: z.string(), kind: z.literal('container'), containerResources: z.object({ version: z.literal(1), file: z.literal(FILE) }).strict() }).parse(readBounded(join(context.directory, 'run.json')).value)
    if (parent.runId !== context.runId || parent.repo !== context.repo)
      throw new Error('container-parent-identity')
    const initial = readBounded(join(context.directory, FILE))
    const record = z.object({ version: z.literal(1), runId: uuid, repo: z.string(), scratch: z.string(), state: z.literal('unclaimed') }).strict().parse(initial.value)
    if (record.runId !== context.runId || record.repo !== context.repo || record.scratch !== context.scratch)
      throw new Error('container-ledger-identity')
    this.fingerprint = initial.sha
    this.repoHash = hash(context.repo)
    this.labels = [`${RUN_LABEL}=${context.runId}`, `${REPO_LABEL}=${this.repoHash}`]
  }

  private query(args: readonly string[]): string {
    const result = this.capture(args)
    if (result.status !== 0 || Buffer.byteLength(result.stdout) > LIMIT || Buffer.byteLength(result.stderr) > LIMIT)
      throw new Error('docker-query-failed')
    return result.stdout.trim()
  }

  private daemon(): string {
    return boundedText.parse(this.query(['info', '--format', '{{.ID}}']))
  }

  private sameDaemon(): void {
    if (this.ledger === undefined || this.daemon() !== this.ledger.daemon)
      throw new Error('docker-daemon-changed')
  }

  private persist(): void {
    if (this.ledger === undefined)
      throw new Error('container-not-reserved')
    if (realpathSync(this.context.directory) !== this.context.directory
      || readBounded(join(this.context.directory, FILE)).sha !== this.fingerprint) {
      throw new Error('container-ledger-replaced')
    }
    // directory is context, not part of the cross-language file protocol.
    const { directory: _directory, ...value } = this.ledger
    const raw = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(raw) > LIMIT)
      throw new Error('container-ledger-size')
    const temporary = join(this.context.directory, `${FILE}.${process.pid}.tmp`)
    const descriptor = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(descriptor, raw)
      fsyncSync(descriptor)
    }
    finally {
      closeSync(descriptor)
    }
    try {
      if (lstatSync(join(this.context.directory, FILE)).isSymbolicLink())
        throw new Error('container-ledger-replaced')
      renameSync(temporary, join(this.context.directory, FILE))
      const directory = openSync(this.context.directory, 'r')
      try {
        fsyncSync(directory)
      }
      finally { closeSync(directory) }
      this.fingerprint = hash(raw)
    }
    catch (error) {
      unlinkSync(temporary)
      throw error
    }
  }

  private discover(kind: Kind): string[] {
    const type = { containers: 'container', networks: 'network', volumes: 'volume', images: 'image' }[kind]
    const filters = kind === 'images'
      ? [`reference=${this.settings.image}`, `label=${RUN_LABEL}=${this.context.runId}`]
      : [`name=${this.settings.project}`, `label=com.docker.compose.project=${this.settings.project}`, `label=${RUN_LABEL}=${this.context.runId}`]
    const format = kind === 'images' ? '{{.Repository}}:{{.Tag}}' : kind === 'volumes' ? '{{.Name}}' : '{{.ID}}'
    const values = filters.flatMap(filter => this.query([type, 'ls', ...(kind === 'containers' ? ['-a', '--no-trunc'] : kind === 'networks' ? ['--no-trunc'] : []), '--filter', filter, '--format', format]).split('\n').filter(Boolean))
    const result = [...new Set(values)].sort()
    if (result.length > 64 || result.some(value => !/^[\w:./-]{1,256}$/.test(value)))
      throw new Error('docker-namespace-invalid')
    return result
  }

  private inventory(): Inventory {
    return { containers: this.discover('containers'), networks: this.discover('networks'), volumes: this.discover('volumes'), images: this.discover('images') }
  }

  private owned(kind: Kind, id: string): string {
    const type = { containers: 'container', networks: 'network', volumes: 'volume', images: 'image' }[kind]
    const labels = kind === 'containers' || kind === 'images' ? '.Config.Labels' : '.Labels'
    const identifier = kind === 'volumes' ? '.Name' : '.Id'
    const name = kind === 'images' ? JSON.stringify(this.settings.image) : '{{json .Name}}'
    const format = `{"id":{{json ${identifier}}},"name":${name},"run":{{json (index ${labels} "${RUN_LABEL}")}},"repo":{{json (index ${labels} "${REPO_LABEL}")}},"project":{{json (index ${labels} "com.docker.compose.project")}}}`
    const found = objectSchema.parse(parseContainerJson(this.query([type, 'inspect', '--format', format, id])))
    const actualName = found.name.replace(/^\//, '')
    const correctName = kind === 'images'
      ? id === this.settings.image
      : kind === 'volumes'
        ? [`${this.settings.project}_pgdata`, `${this.settings.project}_assets`].includes(actualName)
        : kind === 'networks'
          ? actualName === `${this.settings.project}_default`
          : actualName.startsWith(`${this.settings.project}-`)
    if (!correctName || (kind !== 'images' && found.id !== id) || found.run !== this.context.runId || found.repo !== this.repoHash
      || (found.project !== null && found.project !== '' && found.project !== this.settings.project)) {
      throw new Error('docker-owner-mismatch')
    }
    return found.id
  }

  reserve(): void {
    const temporary = realpathSync(dirname(this.settings.envFile))
    const inside = relative(join(this.context.scratch, 'tmp'), temporary)
    if (inside === '' || inside.startsWith(`..${sep}`) || inside === '..' || inside.startsWith(sep))
      throw new Error('container-temp-outside-scratch')
    const daemon = this.daemon()
    if (kinds.some(kind => this.discover(kind).length !== 0))
      throw new Error('docker-namespace-not-empty')
    this.ledger = { ...this.context, version: 1, state: 'reserved', daemon, repoHash: this.repoHash, project: this.settings.project, image: this.settings.image, temporaryDirectory: temporary, producers: [], observed: empty() }
    this.persist()
  }

  producerIntent(): void {
    if (this.ledger === undefined || this.ledger.state === 'closed' || this.ledger.producers.length !== 0)
      throw new Error('container-producer-not-quiescent')
    this.sameDaemon()
    this.ledger.producers = [null]
    this.persist()
  }

  producerStarted(pid: number): void {
    if (this.ledger === undefined || this.ledger.producers.length !== 1 || this.ledger.producers[0] !== null || !Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('container-producer-identity')
    this.ledger.producers = [pid]
    this.persist()
  }

  producerStopped(pid: number | undefined, quiescent: boolean): void {
    if (this.ledger === undefined || this.ledger.producers.length !== 1 || this.ledger.producers[0] !== (pid ?? null))
      throw new Error('container-producer-identity')
    if (quiescent)
      this.ledger.producers = []
    else
      this.ledger.state = 'pending'
    this.persist()
  }

  canCollect(): boolean {
    if (this.ledger === undefined || this.ledger.producers.length !== 0)
      return false
    try {
      this.sameDaemon()
      for (const id of this.discover('containers'))
        this.owned('containers', id)
      return true
    }
    catch {
      this.ledger.state = 'pending'
      this.ledger.problem = 'container-resource-check-failed'
      this.persist()
      return false
    }
  }

  cleanup(): boolean {
    if (this.ledger === undefined)
      return false
    try {
      if (this.ledger.producers.length !== 0)
        throw new Error('container-producer-not-quiescent')
      this.sameDaemon()
      const inventory = this.inventory()
      // Validate the whole current set before destroying anything. Recreated app IDs are expected.
      const images: Record<string, string> = {}
      for (const kind of kinds) {
        for (const id of inventory[kind]) {
          const actual = this.owned(kind, id)
          if (kind === 'images')
            images[id] = actual
        }
      }
      this.ledger.observedImageIds = { ...this.ledger.observedImageIds, ...images }
      for (const kind of kinds) {
        const observed = [...new Set([...this.ledger.observed[kind], ...inventory[kind]])].sort()
        if (observed.length > 64)
          throw new Error('docker-namespace-invalid')
        this.ledger.observed[kind] = observed
      }
      this.persist()
      const failures: string[] = []
      const remove = (args: readonly string[]): boolean => {
        const result = this.capture(args)
        return result.status === 0 && Buffer.byteLength(result.stdout) <= LIMIT && Buffer.byteLength(result.stderr) <= LIMIT
      }
      for (const kind of kinds) {
        for (const id of inventory[kind]) {
          this.sameDaemon()
          this.owned(kind, id)
          if (kind === 'containers') {
            if (!remove(['container', 'stop', id])) {
              failures.push('container-stop-failed')
              continue
            }
            this.sameDaemon()
            // --rm one-off containers can disappear as stop completes. A successful
            // namespace list is absence evidence; a failed inspect alone never is.
            if (!this.discover('containers').includes(id))
              continue
            this.owned(kind, id)
          }
          // Docker refuses live endpoints, mounted volumes and referenced images. Never --force.
          if (!remove([{ containers: 'container', networks: 'network', volumes: 'volume', images: 'image' }[kind], 'rm', id]))
            failures.push(`${kind}-remove-failed`)
        }
      }
      this.ledger.cleanupFailures = failures
      this.sameDaemon()
      const absent = this.inventory()
      if (failures.length > 0 || kinds.some(kind => absent[kind].length !== 0))
        throw new Error('docker-resources-remain')
      this.ledger.state = 'closed'
      delete this.ledger.problem
      this.ledger.closure = { daemon: this.ledger.daemon, observedAt: new Date().toISOString(), absent }
      this.persist()
      return true
    }
    catch (error) {
      this.ledger.state = 'pending'
      this.ledger.problem = error instanceof Error && /^docker-[a-z-]+$|^container-producer-not-quiescent$/.test(error.message) ? error.message : 'container-resource-check-failed'
      this.persist()
      return false
    }
  }
}

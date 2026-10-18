import type { MaterialFile, NativeMaterials, NativeSource } from './native-image-materials.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { materialFilePath, materialFileSchema, noticeIndexSchema, sourceManifestSchema, uniqueMaterialPaths, validateNativeMaterials, validateNativeMetadata } from './native-image-materials.ts'

const receiptSchema = z.strictObject({
  format: z.literal(1),
  sharp: z.string(),
  sharpLibvips: z.string(),
  libvips: z.string(),
  sourceFiles: z.number().int().positive(),
  sourceBytes: z.number().int().positive(),
  files: z.array(materialFileSchema).min(1),
})
export type NativeBundleReceipt = z.infer<typeof receiptSchema>
export interface BundleOptions {
  readonly output: string
  readonly cache: string
  readonly fetcher?: typeof fetch
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function ensureDirectory(path: string): void {
  try {
    mkdirSync(path)
  }
  catch (error) {
    if (!hasCode(error, 'EEXIST'))
      throw error
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`材料目录不能是符号链接或普通文件：${path}`)
}

function destination(root: string, relative: string): string {
  const parts = relative.split('/')
  let parent = root
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    ensureDirectory(parent)
  }
  const name = parts.at(-1)
  if (name === undefined || name === '')
    throw new Error('材料路径缺少文件名')
  return join(parent, name)
}

async function* fileChunks(path: string): AsyncIterable<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    for await (const raw of handle.createReadStream({ autoClose: false })) {
      const chunk: unknown = raw
      if (!Buffer.isBuffer(chunk))
        throw new Error('材料读取不是字节流')
      yield chunk
    }
  }
  finally {
    await handle.close()
  }
}

async function checkStream(stream: AsyncIterable<Uint8Array>, expected: MaterialFile, output?: string): Promise<void> {
  const handle = output === undefined ? undefined : await open(output, 'wx', 0o644)
  let count = 0
  const hash = createHash('sha256')
  let complete = false
  try {
    for await (const chunk of stream) {
      count += chunk.length
      if (count > expected.bytes)
        throw new Error(`材料大小超过清单：${expected.path}`)
      hash.update(chunk)
      await handle?.writeFile(chunk)
    }
    if (count !== expected.bytes)
      throw new Error(`材料大小与清单不符：${expected.path}`)
    if (hash.digest('hex') !== expected.sha256)
      throw new Error(`材料摘要与清单不符：${expected.path}`)
    await handle?.sync()
    complete = true
  }
  finally {
    await handle?.close()
    // 只清理由本次 wx 创建的文件，未完成的输出不留下貌似有效的缓存条目。
    if (!complete && output !== undefined)
      rmSync(output)
  }
}

async function* responseChunks(response: Response): AsyncIterable<Uint8Array> {
  if (response.body === null)
    throw new Error('材料响应没有正文')
  const reader = response.body.getReader()
  try {
    while (true) {
      const next = await reader.read()
      if (next.done)
        return
      yield next.value
    }
  }
  finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

async function download(source: NativeSource, path: string, fetcher: typeof fetch): Promise<void> {
  let url = source.url
  const signal = AbortSignal.timeout(120_000)
  for (let redirects = 0; redirects <= 8; redirects += 1) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '')
      throw new Error('材料来源及重定向只接受不带凭据的 HTTPS')
    const response = await fetcher(url, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (location === null)
        throw new Error('材料重定向缺少地址')
      url = new URL(location, url).href
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`材料下载失败：${source.path} HTTP ${response.status}`)
    }
    await checkStream(responseChunks(response), source, path)
    return
  }
  throw new Error('材料重定向次数过多')
}

async function sourcePath(input: NativeMaterials, source: NativeSource, options: BundleOptions): Promise<string> {
  if (source.vendoredPath !== undefined)
    return materialFilePath(input.directory, source.vendoredPath)
  try {
    return materialFilePath(options.cache, source.path)
  }
  catch (error) {
    if (!hasCode(error, 'ENOENT'))
      throw error
  }
  const path = destination(options.cache, source.path)
  await download(source, path, options.fetcher ?? fetch)
  return path
}

/** 全新目录、至多四个流；所有工作线程结束后才返回或报错，避免失败后继续写已清理的目录。 */
export async function bundleNativeImages(input: NativeMaterials, options: BundleOptions): Promise<NativeBundleReceipt> {
  validateNativeMaterials(input)
  ensureDirectory(dirname(options.output))
  try {
    mkdirSync(options.output)
  }
  catch (error) {
    if (hasCode(error, 'EEXIST'))
      throw new Error('输出目录已存在，拒绝覆盖')
    throw error
  }
  ensureDirectory(options.cache)
  let next = 0
  let failed = false
  const workers = Array.from({ length: Math.min(4, input.manifest.sources.length) }, async () => {
    while (!failed) {
      const source = input.manifest.sources[next++]
      if (source === undefined)
        return
      try {
        const path = await sourcePath(input, source, options)
        await checkStream(fileChunks(path), source, destination(options.output, `sources/${source.path}`))
      }
      catch (error) {
        failed = true
        throw new Error(`材料收集失败（${source.path}）：${error instanceof Error ? error.message : '未知原因'}`, { cause: error })
      }
    }
  })
  const results = await Promise.allSettled(workers)
  for (const result of results) {
    if (result.status === 'rejected')
      throw result.reason instanceof Error ? result.reason : new Error('材料收集失败', { cause: result.reason })
  }
  const files: MaterialFile[] = input.manifest.sources.map(row => ({ path: `sources/${row.path}`, bytes: row.bytes, sha256: row.sha256 }))
  for (const [path, data] of [
    ['sources.json', Buffer.from(`${JSON.stringify(input.manifest, null, 2)}\n`)],
    ['notices-index.json', Buffer.from(`${JSON.stringify(input.index, null, 2)}\n`)],
    ['LICENSE', input.book],
    ['README.md', input.readme],
  ] as const) {
    writeFileSync(join(options.output, path), data, { flag: 'wx', mode: 0o644 })
    files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  const receipt: NativeBundleReceipt = {
    format: 1,
    sharp: input.manifest.sharp,
    sharpLibvips: input.manifest.sharpLibvips,
    libvips: input.manifest.libvips,
    sourceFiles: input.manifest.sources.length,
    sourceBytes: input.manifest.sources.reduce((sum, source) => sum + source.bytes, 0),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  }
  // 最后写回执；任何前置失败都没有可验收的完成标志。
  writeFileSync(join(options.output, 'BUNDLE.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  return verifyNativeImageBundle(options.output)
}

function actualFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink())
      throw new Error(`成品中不能有符号链接：${path}`)
    if (entry.isDirectory())
      return actualFiles(root, path)
    if (!entry.isFile())
      throw new Error(`成品中不是普通文件：${path}`)
    return [path]
  })
}

/** 不联网、不运行任何归档内容；核对成品实际字节、完整清单和声明，不能只信 BUNDLE.json 的状态字段。 */
export async function verifyNativeImageBundle(root: string): Promise<NativeBundleReceipt> {
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(materialFilePath(root, 'BUNDLE.json'), 'utf8')))
  uniqueMaterialPaths(receipt.files.map(row => row.path))
  const expected = [...receipt.files.map(row => row.path), 'BUNDLE.json'].sort()
  const actual = actualFiles(root).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error('成品文件集合与回执不符')
  for (const file of receipt.files)
    await checkStream(fileChunks(materialFilePath(root, file.path)), file)
  const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(materialFilePath(root, 'sources.json'), 'utf8')))
  const index = noticeIndexSchema.parse(JSON.parse(readFileSync(materialFilePath(root, 'notices-index.json'), 'utf8')))
  if (readFileSync(materialFilePath(root, 'README.md')).length === 0)
    throw new Error('成品缺少构建与替换说明')
  validateNativeMetadata({ manifest, index, book: readFileSync(materialFilePath(root, 'LICENSE')) })
  for (const key of ['sharp', 'sharpLibvips', 'libvips'] as const) {
    if (receipt[key] !== manifest[key])
      throw new Error('成品原生版本与来源清单不同')
  }
  const records = new Map(receipt.files.map(file => [file.path, file]))
  if (receipt.sourceFiles !== manifest.sources.length || receipt.sourceBytes !== manifest.sources.reduce((sum, row) => sum + row.bytes, 0) || receipt.files.length !== manifest.sources.length + 4)
    throw new Error('成品来源数量或字节数不符')
  for (const source of manifest.sources) {
    const record = records.get(`sources/${source.path}`)
    if (record?.sha256 !== source.sha256 || record.bytes !== source.bytes)
      throw new Error(`成品来源与回执不同：${source.path}`)
  }
  return receipt
}

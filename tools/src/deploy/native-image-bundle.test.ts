import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundleNativeImages, verifyNativeImageBundle } from './native-image-bundle.ts'
import { loadNativeMaterials } from './native-image-materials.ts'

const created: string[] = []
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
afterEach(() => {
  for (const path of created.splice(0))
    rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-image-materials-'))
  created.push(root)
  const directory = join(root, 'deploy/native-images')
  mkdirSync(directory, { recursive: true })
  const data = Buffer.from('known source archive bytes')
  const text = Buffer.from('original notice text\n')
  const sources = [
    { path: 'native/source', kind: 'source', url: 'https://source.invalid/source', bytes: data.length, sha256: sha(data) },
    { path: 'licenses/original', kind: 'license', url: 'https://source.invalid/license', bytes: text.length, sha256: sha(text), vendoredPath: 'inputs/license' },
  ]
  const book = Buffer.from(`intro\n\n\n${'='.repeat(72)}\nnotice\n来源：licenses/original\n原始 SHA-256：${sha(text)}\n\n${text.toString()}`)
  const noticeBook = { path: 'apps/api/third-party-licenses/native-images/LICENSE', bytes: book.length, sha256: sha(book) }
  const manifest = { format: 1, sharp: '0.35.5', sharpLibvips: '1.3.4', libvips: '8.18.7', platforms: ['linux-x64'], sources, rustLockBasis: 'fixture', noticeBook }
  const index = { format: 1, noticeBook, entries: [{ title: 'notice', source: 'licenses/original', member: null, bytes: text.length, sha256: sha(text), encoding: 'utf-8' }], missingStandaloneLicenseResolution: [], unresolved: [] }
  mkdirSync(join(directory, 'inputs'))
  writeFileSync(join(directory, 'inputs/license'), text)
  mkdirSync(join(root, 'apps/api/third-party-licenses/native-images'), { recursive: true })
  writeFileSync(join(root, noticeBook.path), book)
  writeFileSync(join(directory, 'sources.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, 'notices-index.json'), JSON.stringify(index))
  writeFileSync(join(directory, 'README.md'), 'build and replace instructions')
  const input = loadNativeMaterials(root)
  const output = join(root, 'bundle')
  const cache = join(root, 'cache')
  mkdirSync(join(cache, 'native'), { recursive: true })
  return { root, data, text, input, output, cache }
}

describe('原生图片源码的有界收集与离线复核', () => {
  it('下载失败保留具体材料路径与原始原因，构建日志能定位哪份原件失败', async () => {
    const f = fixture()
    const cause = new Error('download timed out')
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(cause)
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })).rejects.toMatchObject({ message: '材料收集失败（native/source）：download timed out', cause })
  })

  it('缺失或损坏仓库补件、缺少构建说明时，在收集前拒绝', async () => {
    const f = fixture()
    await expect(bundleNativeImages({ ...f.input, readme: Buffer.alloc(0) }, { output: f.output, cache: f.cache })).rejects.toThrow(/说明/u)
    writeFileSync(join(f.input.directory, 'inputs/license'), 'bad')
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache })).rejects.toThrow(/大小|摘要/u)
    rmSync(join(f.input.directory, 'inputs/license'))
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache })).rejects.toThrow()
  })

  it('已校验缓存与仓库补件无需网络；成品包含原始字节、元数据和回执，离线复验通过', async () => {
    const f = fixture()
    writeFileSync(join(f.cache, 'native/source'), f.data)
    const fetcher = vi.fn<typeof fetch>()
    await bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })
    expect(fetcher).not.toHaveBeenCalled()
    expect(readFileSync(join(f.output, 'sources/native/source'))).toEqual(f.data)
    expect(readFileSync(join(f.output, 'sources/licenses/original'))).toEqual(f.text)
    expect((await verifyNativeImageBundle(f.output)).sourceFiles).toBe(2)
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })).rejects.toThrow(/已存在/u)
  })

  it('缺失缓存时真实消费响应流，摘要核对后缓存；补件始终用仓库原件', async () => {
    const f = fixture()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(f.data))
    await bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(f.cache, 'native/source'))).toEqual(f.data)
    await verifyNativeImageBundle(f.output)
  })

  it.each(['过长', '过短', '同长度坏摘要', '网络失败', '响应失败'] as const)('%s：拒绝下载，不产生可验收成品', async (failure) => {
    const f = fixture()
    const changed = Buffer.from(f.data)
    changed[0] = changed[0]! ^ 1
    const fetcher = vi.fn<typeof fetch>()
    if (failure === '网络失败')
      fetcher.mockRejectedValue(new Error('network interrupted'))
    else
      fetcher.mockResolvedValue(new Response(failure === '过长' ? Buffer.concat([f.data, f.data]) : failure === '过短' ? f.data.subarray(1) : changed, { status: failure === '响应失败' ? 503 : 200 }))
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })).rejects.toThrow()
    await expect(verifyNativeImageBundle(f.output)).rejects.toThrow()
  })

  it('坏缓存不可被网络覆盖来掩盖；缓存路径符号链接也拒绝', async () => {
    const f = fixture()
    const path = join(f.cache, 'native/source')
    writeFileSync(path, 'bad')
    const fetcher = vi.fn<typeof fetch>()
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })).rejects.toThrow(/大小|摘要/u)
    expect(fetcher).not.toHaveBeenCalled()
    rmSync(path)
    symlinkSync(join(f.input.directory, 'inputs/license'), path)
    await expect(bundleNativeImages(f.input, { output: join(f.root, 'another-bundle'), cache: f.cache, fetcher })).rejects.toThrow(/符号链接/u)
  })

  it('只接受 HTTPS 重定向且有限次；重定向之后的字节仍完整核对', async () => {
    const f = fixture()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cdn.invalid/source' } }))
      .mockResolvedValueOnce(new Response(f.data))
    await bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const another = fixture()
    await expect(bundleNativeImages(another.input, { output: another.output, cache: another.cache, fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://cdn.invalid/source' } })) })).rejects.toThrow(/HTTPS/u)
  })

  it('循环重定向和正文中途断流都会停止并拒绝成品', async () => {
    const f = fixture()
    const redirects = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/source' } }))
    await expect(bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher: redirects })).rejects.toThrow(/重定向次数/u)
    expect(redirects).toHaveBeenCalledTimes(9)
    const another = fixture()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(another.data.subarray(0, 2))
      },
      pull(controller) {
        controller.error(new Error('connection closed during body'))
      },
    })
    await expect(bundleNativeImages(another.input, { output: another.output, cache: another.cache, fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) })).rejects.toThrow(/connection closed/u)
    await expect(verifyNativeImageBundle(another.output)).rejects.toThrow()
  })

  it('离线复验发现内容被改、回执缺失、额外文件和路径符号链接', async () => {
    const f = fixture()
    writeFileSync(join(f.cache, 'native/source'), f.data)
    await bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher: vi.fn<typeof fetch>() })
    const source = join(f.output, 'sources/native/source')
    writeFileSync(source, 'changed')
    await expect(verifyNativeImageBundle(f.output)).rejects.toThrow(/大小|摘要/u)
    writeFileSync(source, f.data)
    writeFileSync(join(f.output, 'unlisted'), 'not in receipt')
    await expect(verifyNativeImageBundle(f.output)).rejects.toThrow(/文件集合/u)
    rmSync(join(f.output, 'unlisted'))
    rmSync(source)
    symlinkSync(join(f.cache, 'native/source'), source)
    await expect(verifyNativeImageBundle(f.output)).rejects.toThrow(/符号链接/u)
    rmSync(join(f.output, 'BUNDLE.json'))
    await expect(verifyNativeImageBundle(f.output)).rejects.toThrow()
  })

  it('即使回执同步改名，丢失构建说明的成品仍被拒绝', async () => {
    const f = fixture()
    writeFileSync(join(f.cache, 'native/source'), f.data)
    const receipt = await bundleNativeImages(f.input, { output: f.output, cache: f.cache, fetcher: vi.fn<typeof fetch>() })
    writeFileSync(join(f.output, 'other.md'), readFileSync(join(f.output, 'README.md')))
    rmSync(join(f.output, 'README.md'))
    writeFileSync(join(f.output, 'BUNDLE.json'), JSON.stringify({ ...receipt, files: receipt.files.map(row => row.path === 'README.md' ? { ...row, path: 'other.md' } : row) }))
    await expect(verifyNativeImageBundle(f.output)).rejects.toThrow()
  })
})

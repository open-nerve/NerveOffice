import type { BundledPackage } from './third-party-licenses.ts'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { packageRootOf, readPackageRecord, thirdPartyLicenses } from './third-party-licenses.ts'

const temporary: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temporary)
    rmSync(dir, { recursive: true, force: true })
})

describe('packageRootOf', () => {
  it.each([
    ['/r/node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.production.js', '/r/node_modules/.pnpm/react@19.3.0/node_modules/react'],
    ['/r/node_modules/.pnpm/@univerjs+core@1.0.0/node_modules/@univerjs/core/lib/es/index.js', '/r/node_modules/.pnpm/@univerjs+core@1.0.0/node_modules/@univerjs/core'],
    ['\0/r/node_modules/a/index.js?commonjs-exports', '/r/node_modules/a'],
    ['/r/apps/web/src/main.ts', undefined],
    ['\0vite/preload-helper.js', undefined],
  ])('%s → %s', (id, root) => {
    expect(packageRootOf(id)).toBe(root)
  })
})

describe('readPackageRecord', () => {
  it('包里没有许可文件时，用仓库补齐的正文；都没有时标记为缺少', () => {
    const root = tempDir('nerve-pkg-')
    const supplements = tempDir('nerve-supplements-')
    const write = (dir: string, name: string, license: string): string => {
      const packageDir = join(root, 'node_modules', name)
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', license }))
      return packageDir
    }
    const withFile = write(root, 'with-file', 'MIT')
    writeFileSync(join(withFile, 'LICENSE.md'), 'MIT License text')
    const supplemented = write(root, '@scope/supplemented', 'ISC')
    mkdirSync(join(supplements, '@scope/supplemented'), { recursive: true })
    writeFileSync(join(supplements, '@scope/supplemented', 'LICENSE'), 'ISC License text')
    const missing = write(root, 'missing', 'MIT')
    const dual = write(root, 'dual', '(MIT OR Apache-2.0)')
    writeFileSync(join(dual, 'LICENSE-MIT'), 'MIT text')
    writeFileSync(join(dual, 'LICENSE-APACHE'), 'Apache text')

    expect(readPackageRecord(withFile, supplements)).toMatchObject({ name: 'with-file', licenseTextSource: 'package', text: 'MIT License text' })
    expect(readPackageRecord(dual, supplements)).toMatchObject({ licenseTextSource: 'package', text: 'Apache text\n\nMIT text' })
    expect(readPackageRecord(supplemented, supplements)).toMatchObject({ name: '@scope/supplemented', licenseTextSource: 'supplement', text: 'ISC License text' })
    expect(readPackageRecord(missing, supplements)).toMatchObject({ name: 'missing', licenseTextSource: null, text: null })
  })
})

async function buildFixture(collectWorker: boolean): Promise<{ packages: BundledPackage[], markdown: string }> {
  const outDir = tempDir('nerve-worker-build-')
  const licenses = thirdPartyLicenses({ supplementDir: tempDir('nerve-supplements-') })
  await build({
    configFile: false,
    logLevel: 'silent',
    root: join(import.meta.dirname, 'fixtures/worker-app'),
    plugins: [licenses.emit],
    worker: { format: 'es', plugins: () => (collectWorker ? [licenses.collect()] : []) },
    build: { outDir, emptyOutDir: true, minify: false },
  })
  return {
    packages: JSON.parse(readFileSync(join(outDir, '.vite/third-party-packages.json'), 'utf8')) as BundledPackage[],
    markdown: readFileSync(join(outDir, 'THIRD-PARTY-LICENSES.md'), 'utf8'),
  }
}

describe('US-M1-11 A01 第三方许可清单覆盖 Worker 的产物', () => {
  it('只在 Worker 里用到的第三方包也进入清单（真实的 Vite 构建）', async () => {
    const { packages, markdown } = await buildFixture(true)
    expect(packages).toContainEqual({ name: 'react', version: '19.3.0', license: 'MIT', licenseTextSource: 'package' })
    expect(markdown).toContain('## react 19.3.0（MIT）')
  }, 60_000)

  it('对照：Worker 的构建不挂收集插件时，清单里就没有它（Vite 自带的 build.license 同样如此）', async () => {
    const { packages } = await buildFixture(false)
    expect(packages.map(p => p.name)).not.toContain('react')
  }, 60_000)
})

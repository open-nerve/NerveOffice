import type { ModuleSources } from './module-sources.ts'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { MODULE_SOURCES_FILE, moduleSources, renderModuleSources, sourceOf } from './module-sources.ts'

const temporary: string[] = []

afterAll(() => {
  for (const dir of temporary)
    rmSync(dir, { recursive: true, force: true })
})

describe('模块的来源（M3-P2 复核 B2）', () => {
  it.each([
    ['/r/apps/web/src/editor/testing/switch-timing.ts', 'src/editor/testing/switch-timing.ts'],
    ['/r/apps/web/selftest.html', 'selftest.html'],
    ['/r/packages/contracts/src/index.ts', '../../packages/contracts/src/index.ts'],
    // 第三方的包去掉 pnpm 的存储路径与版本
    ['/r/node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.production.js', 'node_modules/react/cjs/react.production.js'],
    ['/r/node_modules/.pnpm/@univerjs+core@1.0.1/node_modules/@univerjs/core/lib/es/index.js', 'node_modules/@univerjs/core/lib/es/index.js'],
    // 查询串照原样留着（同一个文件的不同引入方式是不同的模块）
    ['/r/apps/web/src/editor/workers/formula.worker.ts?worker_file&type=module', 'src/editor/workers/formula.worker.ts?worker_file&type=module'],
    // 构建工具的虚拟模块
    ['\0rolldown/runtime.js', 'virtual:rolldown/runtime.js'],
  ])('%s → %s', (id, source) => {
    expect(sourceOf(id, '/r/apps/web')).toBe(source)
  })

  it('清单按脚本的文件名排序（两次构建便于比较）', () => {
    const text = renderModuleSources([['assets/b.js', { name: 'b', modules: ['src/b.ts'] }], ['assets/a.js', { name: 'a', modules: ['src/a.ts'] }]])
    expect(Object.keys(JSON.parse(text) as ModuleSources)).toEqual(['assets/a.js', 'assets/b.js'])
  })
})

async function buildFixture(collectWorker: boolean): Promise<{ sources: ModuleSources, scripts: string[] }> {
  const outDir = mkdtempSync(join(tmpdir(), 'nerve-module-sources-'))
  temporary.push(outDir)
  const root = join(import.meta.dirname, 'fixtures/worker-app')
  const plugin = moduleSources({ root })
  await build({
    configFile: false,
    logLevel: 'silent',
    root,
    plugins: [plugin.emit],
    worker: { format: 'es', plugins: () => (collectWorker ? [plugin.collect()] : []) },
    build: { outDir, emptyOutDir: true, minify: false },
  })
  const scripts = readdirSync(join(outDir, 'assets')).filter(name => name.endsWith('.js')).map(name => `assets/${name}`).sort()
  return { sources: JSON.parse(readFileSync(join(outDir, MODULE_SOURCES_FILE), 'utf8')) as ModuleSources, scripts }
}

describe('US-M1-11 A01 模块来源清单覆盖主构建与 Worker 的产物（真实的 Vite 构建，M3-P2 复核 B2）', () => {
  it('每个脚本都在清单里：入口块有入口页与它的脚本，Worker 的块有 Worker 的脚本与它用到的第三方包', async () => {
    const { sources, scripts } = await buildFixture(true)
    expect(Object.keys(sources).sort()).toEqual(scripts)
    const entry = Object.values(sources).find(script => script.modules.includes('index.html'))
    expect(entry?.modules).toContain('src/main.ts')
    const worker = Object.values(sources).find(script => script.modules.includes('src/worker.ts'))
    expect(worker?.modules).toContain('node_modules/react/index.js')
  }, 60_000)

  it('对照：Worker 的构建不挂收集插件时，清单里没有 Worker 的块（门禁按"产物里有清单没记下的脚本"报出）', async () => {
    const { sources, scripts } = await buildFixture(false)
    expect(scripts.filter(script => sources[script] === undefined)).toHaveLength(1)
  }, 60_000)
})

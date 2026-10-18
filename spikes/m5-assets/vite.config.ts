import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname
const repo = resolve(root, '../..')
const web = resolve(repo, 'apps/web')
const webRequire = createRequire(join(web, 'package.json'))
const coreEntry = webRequire.resolve('@univerjs/core')
const output = process.env.M5_PROBE_OUTPUT
if (!output || !isAbsolute(output))
  throw new Error('M5_PROBE_OUTPUT 必须是本轮专用的绝对输出目录')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  }).sort()
}
const sourcePaths = [
  ...sourceFiles(root),
  ...sourceFiles(join(web, 'src/editor/profile')),
  join(repo, 'pnpm-lock.yaml'),
  join(repo, 'pnpm-workspace.yaml'),
  join(web, 'package.json'),
  join(repo, 'apps/api/src/modules/security/security-headers.ts'),
]
const sources = Object.fromEntries(sourcePaths.map(path => [
  relative(repo, path), createHash('sha256').update(readFileSync(path)).digest('hex'),
]))
const webPackage = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'))
const dependencies = Object.fromEntries(Object.keys(webPackage.dependencies).filter(name => name.startsWith('@univerjs/')).sort().map(name => {
  const path = realpathSync(join(web, 'node_modules', name, 'package.json'))
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (pkg.version !== '1.0.1') throw new Error(`${name} 不是 1.0.1`)
  return [name, { version: pkg.version, packageSha256: createHash('sha256').update(readFileSync(path)).digest('hex') }]
}))
const buildId = createHash('sha256').update(JSON.stringify({ sources, dependencies })).digest('hex')
const identity = { schemaVersion: 1, buildId, sdkVersion: '1.0.1', sources, dependencies }
const outDir = join(output, buildId)

export default defineConfig({
  root,
  define: { __M5_PROBE_BUILD__: JSON.stringify(identity) },
  plugins: [{
    name: 'm5-probe-locked-dependencies',
    enforce: 'pre',
    async resolveId(source) {
      if (source.startsWith('@univerjs/') || /^(?:react|react-dom)(?:\/|$)/.test(source))
        return this.resolve(source, join(web, 'package.json'), { skipSelf: true })
      if (source === 'rxjs' || source.startsWith('rxjs/'))
        return this.resolve(source, coreEntry, { skipSelf: true })
      return null
    },
    closeBundle() {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'build-identity.json'), `${JSON.stringify(identity, null, 2)}\n`)
      console.log(`M5_PROBE_BUILD=${outDir}`)
    },
  }],
  build: { outDir, emptyOutDir: false, target: 'es2022', manifest: true, license: true, modulePreload: { polyfill: false }, chunkSizeWarningLimit: 20000 },
})

// 第三方许可清单（00 号计划书 §3.3）：收集打进构建产物的第三方包，包括 Worker 单独打包的产物；
// 写出随部署包分发的 THIRD-PARTY-LICENSES.md，以及供门禁检查的 .vite/third-party-packages.json。
// Vite 自带的 build.license 不收集 Worker 的产物（它以 asset 的形式并入主构建），所以不用它。
import type { Plugin } from 'vite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

export interface BundledPackage {
  name: string
  version: string
  license: string
  /** 许可正文的来源：包自带的许可文件、仓库补齐的文件，或者都没有 */
  licenseTextSource: 'package' | 'supplement' | null
}

interface PackageRecord extends BundledPackage {
  text: string | null
}

const NODE_MODULES = '/node_modules/'
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.\-_]|$)/i

/** 模块路径所在的 npm 包根目录：node_modules 之后的第一段（带作用域时是两段）。不在 node_modules 里的返回 undefined。 */
export function packageRootOf(moduleId: string): string | undefined {
  const path = moduleId.replace(/^\0/, '').split('?')[0] ?? ''
  const index = path.lastIndexOf(NODE_MODULES)
  if (index < 0)
    return undefined
  const segments = path.slice(index + NODE_MODULES.length).split('/')
  const nameSegments = segments[0]?.startsWith('@') === true ? segments.slice(0, 2) : segments.slice(0, 1)
  if (nameSegments.length === 0 || nameSegments.includes(''))
    return undefined
  return `${path.slice(0, index + NODE_MODULES.length)}${nameSegments.join('/')}`
}

/** 目录里全部的许可文件，按文件名排序后合并：双许可的包（LICENSE-MIT 与 LICENSE-APACHE）两份都要收。 */
function readLicenseText(dir: string): string | null {
  if (!existsSync(dir))
    return null
  const files = readdirSync(dir).filter(name => LICENSE_FILE.test(name)).sort()
  return files.length === 0 ? null : files.map(file => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n')
}

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  // license 应是 SPDX 字符串；写成对象（旧格式）或没有写的，一律记为 Unknown，由门禁拦下
  license: z.unknown().optional(),
})

/** 读取一个包的名称、版本、许可与许可正文；包里没有许可文件时，到 supplementDir/<包名>/ 下找仓库补齐的正文。 */
export function readPackageRecord(root: string, supplementDir: string): PackageRecord {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
  const own = readLicenseText(root)
  const supplement = own === null ? readLicenseText(join(supplementDir, manifest.name)) : null
  return {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : 'Unknown',
    licenseTextSource: own !== null ? 'package' : supplement !== null ? 'supplement' : null,
    text: own ?? supplement,
  }
}

export function renderLicenses(records: readonly PackageRecord[]): string {
  const sections = records.map(r => `## ${r.name} ${r.version}（${r.license}）\n\n${r.text ?? '（缺少许可正文）'}\n`)
  return `# 第三方许可\n\n本产品的前端构建产物（含 Worker）包含以下第三方软件。\n\n${sections.join('\n')}`
}

/**
 * collect 放进 worker.plugins，收集 Worker 的产物；emit 放进主构建的 plugins，
 * 收集主构建的产物并写出清单。Worker 在主构建处理到 `new Worker(new URL(...))` 时打包，早于主构建的 generateBundle。
 */
export function thirdPartyLicenses(options: { supplementDir: string }): { collect: () => Plugin, emit: Plugin } {
  const records = new Map<string, PackageRecord>()
  const record = (moduleIds: Iterable<string>): void => {
    for (const id of moduleIds) {
      const root = packageRootOf(id)
      if (root === undefined || records.has(root))
        continue
      records.set(root, readPackageRecord(root, options.supplementDir))
    }
  }
  const chunksOf = (bundle: Record<string, { type: string }>): Iterable<string> =>
    Object.values(bundle).flatMap(output => ('modules' in output && output.type === 'chunk' ? Object.keys(output.modules as Record<string, unknown>) : []))

  return {
    collect: () => ({
      name: 'nerve:collect-bundled-packages',
      generateBundle(_options, bundle) {
        record(chunksOf(bundle))
      },
    }),
    emit: {
      name: 'nerve:third-party-licenses',
      enforce: 'post',
      generateBundle(_options, bundle) {
        record(chunksOf(bundle))
        const unique = new Map([...records.values()].map(r => [`${r.name}@${r.version}`, r]))
        const list = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
        this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-LICENSES.md', source: renderLicenses(list) })
        const summary: BundledPackage[] = list.map(({ name, version, license, licenseTextSource }) => ({ name, version, license, licenseTextSource }))
        this.emitFile({ type: 'asset', fileName: '.vite/third-party-packages.json', source: `${JSON.stringify(summary, null, 2)}\n` })
      },
    },
  }
}

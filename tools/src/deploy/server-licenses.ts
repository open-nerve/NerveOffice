// 服务端的第三方许可清单（P5 设计 §3.2.1，00 号计划书 §3.3）：镜像构建时按 api 的生产依赖图逐个读取许可正文，
// 写成随镜像分发的 THIRD-PARTY-LICENSES-server.md。前端的清单由 web 构建的插件生成（apps/web/build/third-party-licenses.ts），
// 两边认许可文件的规则相同。包里没有许可文件时到补充目录（apps/api/third-party-licenses/<包名>/）里找，仍然没有就失败，不静默跳过。
import type { CollectedGraph, InstalledPackage } from '../gates/dependency-graph.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { REPO_ROOT } from '../shared/repo.ts'

/** 服务端：镜像里运行的就是这个包与它的生产依赖 */
export const API_PACKAGE = '@nerve-office/api'
/** api 的依赖里缺许可正文时，仓库补齐的正文放在这里（与前端的 apps/web/third-party-licenses 同样的做法） */
export const SERVER_LICENSE_SUPPLEMENT = join(REPO_ROOT, 'apps/api/third-party-licenses')

/** 许可文件：LICENSE、LICENCE、COPYING 开头的文件（与前端的插件同一个规则） */
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.\-_]|$)/i

export interface LicensedPackage {
  readonly name: string
  readonly version: string
  /** package.json 的 license（SPDX）；没有写或写成旧格式的对象时是 Unknown */
  readonly license: string
  /** 许可正文：包自带的，或者补充目录里的；都没有时为 null */
  readonly text: string | null
}

/** 目录里全部的许可文件，按文件名排序后合并：双许可的包（LICENSE-MIT 与 LICENSE-APACHE）两份都要收。 */
export function readLicenseText(dir: string): string | null {
  if (!existsSync(dir))
    return null
  const files = readdirSync(dir).filter(name => LICENSE_FILE.test(name)).sort()
  return files.length === 0 ? null : files.map(file => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n')
}

const manifestSchema = z.object({ license: z.unknown().optional() })

/** 读取一个安装实例的许可与正文；包里没有许可文件时到 supplementDir/<包名>/ 下找。 */
export function readPackage(installed: InstalledPackage, supplementDir: string): LicensedPackage {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(installed.path, 'package.json'), 'utf8')))
  const text = readLicenseText(installed.path) ?? readLicenseText(join(supplementDir, installed.name))
  return {
    name: installed.name,
    version: installed.version,
    license: typeof manifest.license === 'string' ? manifest.license : 'Unknown',
    text,
  }
}

/** 同名同版本的多个安装实例（peer 依赖不同）只列一次，按包名与版本排序 */
export function uniquePackages(packages: readonly LicensedPackage[]): LicensedPackage[] {
  const unique = new Map(packages.map(item => [`${item.name}@${item.version}`, item]))
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

/**
 * api 的生产依赖图里装上了的包（同名同版本只列一次）。可选依赖里别的平台的预编译包（例如 argon2 的各个平台）
 * 只出现在依赖图里，没有安装，也就不在镜像里；notInstalled 是这类实例的个数
 */
export function serverPackages(graph: CollectedGraph, supplementDir: string, isInstalled: (path: string) => boolean = existsSync): { packages: LicensedPackage[], notInstalled: number } {
  const installed = graph.installed.filter(item => isInstalled(item.path))
  return { packages: uniquePackages(installed.map(item => readPackage(item, supplementDir))), notInstalled: graph.installed.length - installed.length }
}

/** 没有许可正文的包（名称@版本） */
export function missingTexts(packages: readonly LicensedPackage[]): string[] {
  return packages.filter(item => item.text === null).map(item => `${item.name}@${item.version}`)
}

export function renderServerLicenses(packages: readonly LicensedPackage[]): string {
  const sections = packages.map(item => `## ${item.name} ${item.version}（${item.license}）\n\n${item.text ?? '（缺少许可正文）'}\n`)
  return `# 第三方许可（服务端）\n\n本产品的服务端（容器镜像里的后端）包含以下第三方软件。前端的清单见网站根目录的 THIRD-PARTY-LICENSES.md。\n\n${sections.join('\n')}`
}

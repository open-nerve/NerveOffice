// 构建产物里每个脚本由哪些源码模块组成（M3-P2 复核 B2）：写出 .vite/module-sources.json，供门禁按来源核对。
// - artifacts：只属于测试构建的源码（编辑器的 testing/、自检与 CSP 探针的入口页）不能出现在生产构建里。按模块的来源认：
//   分块改了名、被并进别的分块、被生产代码直接动态引入成了自己的分块，都认得出（只按分块名与关键字认时，认不出直接动态引入的
//   testing/switch-timing.ts 一类）；
// - test-build：测试构建里平台页面与编辑器页的入口块要与生产构建的相同，按分块里的模块比较（M3-P2 复核 B4）。
// 主构建与 Worker 各自打包，Worker 的产物在主构建里只是一份 asset：collect 放进 worker.plugins 记下 Worker 的分块，emit 放进主构建的
// plugins，记下主构建的分块并写出清单（同第三方许可清单的做法：Worker 在主构建处理到 new Worker(new URL(...)) 时打包，早于主构建的 generateBundle）。
// 模块的写法（sourceOf）：相对 web 应用目录的路径（src/…、editor.html；工作区的包是 ../../packages/…）；第三方的包写成
// node_modules/<包名>/<包里的路径>（去掉 pnpm 的存储路径与版本：同一份锁文件的两份构建相同）；构建工具的虚拟模块写成 virtual:<名字>
import type { Plugin } from 'vite'
import { relative, sep } from 'node:path'

/** 一个脚本：分块的名字（不带哈希）与组成它的模块（排好序） */
export interface ScriptSources {
  readonly name: string
  readonly modules: readonly string[]
}

/** 清单：产物里的脚本（相对产物目录的路径）→ 它的名字与模块 */
export type ModuleSources = Readonly<Record<string, ScriptSources>>

/** 清单在产物里的位置（门禁按它读，tools/src/gates/run.ts） */
export const MODULE_SOURCES_FILE = '.vite/module-sources.json'

const NODE_MODULES = '/node_modules/'

/** 一个模块的来源：root 是 web 应用的目录（绝对路径） */
export function sourceOf(moduleId: string, root: string): string {
  if (moduleId.startsWith('\0'))
    return `virtual:${moduleId.slice(1)}`
  const [path = '', ...query] = moduleId.split('?')
  const suffix = query.length === 0 ? '' : `?${query.join('?')}`
  const posix = path.split(sep).join('/')
  const index = posix.lastIndexOf(NODE_MODULES)
  if (index >= 0)
    return `node_modules/${posix.slice(index + NODE_MODULES.length)}${suffix}`
  return `${relative(root, path).split(sep).join('/')}${suffix}`
}

interface BundleChunk {
  readonly type: string
  readonly name?: string
  readonly modules?: Readonly<Record<string, unknown>>
}

/** bundle 里的脚本：文件名 → 名字与模块 */
function scriptsOf(bundle: Readonly<Record<string, BundleChunk>>, root: string): [string, ScriptSources][] {
  return Object.entries(bundle).flatMap(([fileName, output]) => output.type === 'chunk' && output.modules !== undefined
    ? [[fileName, { name: output.name ?? '', modules: [...new Set(Object.keys(output.modules).map(id => sourceOf(id, root)))].sort() }]]
    : [])
}

/** 清单的文本：按文件名排序，便于比较两次构建 */
export function renderModuleSources(scripts: Iterable<[string, ScriptSources]>): string {
  const sorted = [...scripts].sort(([a], [b]) => a.localeCompare(b))
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`
}

/** collect 放进 worker.plugins，emit 放进主构建的 plugins（见文件开头）；root 是 web 应用的目录 */
export function moduleSources(options: { root: string }): { collect: () => Plugin, emit: Plugin } {
  const workers = new Map<string, ScriptSources>()
  return {
    collect: () => ({
      name: 'nerve:collect-worker-module-sources',
      generateBundle(_options, bundle) {
        for (const [fileName, script] of scriptsOf(bundle, options.root))
          workers.set(fileName, script)
      },
    }),
    emit: {
      name: 'nerve:module-sources',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const scripts = [...scriptsOf(bundle, options.root), ...workers]
        this.emitFile({ type: 'asset', fileName: MODULE_SOURCES_FILE, source: renderModuleSources(scripts) })
      },
    },
  }
}

// web 构建写出的模块来源清单（apps/web/build/module-sources.ts，M3-P2 复核 B2）：产物里每个脚本由哪些源码模块组成。
// 门禁 artifacts 按它认测试专用的模块。测试构建与生产构建的入口块相同（M3-P2 复核 B4）不靠它自动核对：跨两份构建的比较没有自动化
// （ADR-015），源头由 lint 规则 nerve/selftest-entry-self-contained 拦住。
// 模块的写法：相对 web 应用目录的路径（src/…、editor.html）、node_modules/<包名>/<包里的路径>、virtual:<名字>
import { z } from 'zod'

/** 清单在产物里的位置（与 apps/web/build/module-sources.ts 的 MODULE_SOURCES_FILE 相同） */
export const MODULE_SOURCES_FILE = '.vite/module-sources.json'

export const moduleSourcesSchema = z.record(z.string(), z.object({
  /** 分块的名字（不带哈希） */
  name: z.string(),
  modules: z.array(z.string()),
}))

export type ModuleSources = z.infer<typeof moduleSourcesSchema>

/** 产物里的脚本：门禁按来源核对时，每一个都要在清单里 */
export function isScript(path: string): boolean {
  return /\.m?js$/i.test(path)
}

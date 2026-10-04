// web 构建写出的模块来源清单（apps/web/build/module-sources.ts，M3-P2 复核 B2）：产物里每个脚本由哪些源码模块组成。
// 门禁 artifacts 按它认测试专用的模块，test-build 按它比较测试构建与生产构建的入口块（M3-P2 复核 B4）。
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

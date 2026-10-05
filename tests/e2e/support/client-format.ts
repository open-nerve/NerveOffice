// 页面上报的构建与数据格式（M3-P3 设计 §3.5）：保存、另存为副本（查询参数）与申请编辑权、心跳（请求体）都带上，缺了按过旧（CLIENT_OUTDATED）。
// E2E 里不经页面、自己拼请求的用例照现在的页面的写法带上；伪造旧页面的用例（specs/editor/save-protocol.spec.ts）改写页面发出的请求。
// 构建取根 package.json 的版本：与测试构建注入页面的相同（apps/web/build/client-build.ts；镜像里的页面另附 +提交号，服务端比较时不看它）
import type { ClientFormat } from '@nerve-office/contracts'
import { readFileSync } from 'node:fs'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'

/** 根 package.json 的 version：页面的构建版本 */
const CLIENT_BUILD = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** 现在的页面上报的四项 */
export const CURRENT_CLIENT = {
  clientBuild: CLIENT_BUILD,
  univerVersion: UNIVER_SDK_VERSION,
  profile: DOCUMENT_PROFILE_OF.sheet,
  formatVersion: PLATFORM_FORMAT_VERSION,
} as const satisfies ClientFormat

/** 同样的四项写成查询参数（保存、另存为副本） */
export function clientFormatQuery(): Record<string, string> {
  return Object.fromEntries(Object.entries(CURRENT_CLIENT).map(([key, value]) => [key, String(value)]))
}

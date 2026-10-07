// 页面上报的构建与数据格式（M3-P3 设计 §3.5）：保存、另存为副本（查询参数）与申请编辑权、心跳（请求体）都带上，缺了按过旧（CLIENT_OUTDATED）。
// 集成测试扮演的是现在的页面：构建取根 package.json 的版本（与页面构建时注入的相同），数据格式取 contracts 的常量。
// 要扮演旧页面的用例另外改写其中的一项，或者干脆不带（P3 之前的页面）
import type { ClientFormat } from '@nerve-office/contracts'
import { readFileSync } from 'node:fs'
import { DOCUMENT_PROFILE_OF, PLATFORM_FORMAT_VERSION, UNIVER_SDK_VERSION } from '@nerve-office/contracts'

/** 根 package.json 的 version：页面的构建版本（apps/web/build/client-build.ts 经 Vite 注入同一个值） */
export const CLIENT_BUILD = (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** 现在的页面上报的四项 */
export const CURRENT_CLIENT: ClientFormat = {
  clientBuild: CLIENT_BUILD,
  univerVersion: UNIVER_SDK_VERSION,
  profile: DOCUMENT_PROFILE_OF.sheet,
  formatVersion: PLATFORM_FORMAT_VERSION,
}

/** 同样的四项写成查询参数（保存、另存为副本） */
export function clientFormatQuery(format: ClientFormat = CURRENT_CLIENT): Record<string, string> {
  return Object.fromEntries(Object.entries(format).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
}

/** 申请编辑权的请求体：这个标签页，带着现在的页面的构建与数据格式 */
export function acquireBody(clientInstanceId: string, format: ClientFormat = CURRENT_CLIENT): Record<string, unknown> {
  return { clientInstanceId, ...format }
}

/** 心跳的请求体：多久没有操作，带着现在的页面的构建与数据格式 */
export function renewBody(idleSeconds: number, format: ClientFormat = CURRENT_CLIENT): Record<string, unknown> {
  return { idleSeconds, ...format }
}

/** 发出请求编辑的请求体（M3-P5）：只有页面的构建与数据格式 */
export function requestBody(format: ClientFormat = CURRENT_CLIENT): Record<string, unknown> {
  return { ...format }
}

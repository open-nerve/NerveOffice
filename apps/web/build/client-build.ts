// 页面的构建版本（M3-P3 设计 §3.5）：vite.config.ts 经 define 注入为 __NERVE_CLIENT_BUILD__，编辑器页经 features/sheet-editor/client-format.ts
// 读它，保存、另存为副本、申请编辑权与心跳都上报；服务端按运维开关 NERVE_MIN_CLIENT_BUILD 比较（数据格式另外比较）。
// 取仓库根目录 package.json 的 version（x.y.z，发布时递增）。生产构建、测试构建与 vite dev 都注入同一个值：两份构建的入口块照样相同
// （不按构建的时刻取值）。镜像构建由 deploy/Dockerfile 经环境变量 CLIENT_BUILD_REVISION 传进提交号，附在 + 之后作诊断信息
// （服务端比较时不看它，修订记录里看得到是哪一次构建写的）；没有或写法不对时不附
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 附在 + 之后的提交号：十六进制，7 到 40 位，取前 12 位、小写 */
const REVISION = /^[\da-f]{7,40}$/i
const REVISION_LENGTH = 12

/** 由版本与提交号得出构建版本；提交号没有或不是十六进制的提交号时只有版本 */
export function clientBuildOf(version: string, revision: string | undefined): string {
  const trimmed = revision?.trim() ?? ''
  return REVISION.test(trimmed) ? `${version}+${trimmed.slice(0, REVISION_LENGTH).toLowerCase()}` : version
}

/** 本次构建的构建版本：repositoryRoot 是仓库根目录（绝对路径），提交号取 env 的 CLIENT_BUILD_REVISION */
export function clientBuild(repositoryRoot: string, env: Readonly<Record<string, string | undefined>>): string {
  const { version } = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as { version: string }
  return clientBuildOf(version, env.CLIENT_BUILD_REVISION)
}

// 只给集成测试用的程序接口（包的出口 @nerve-office/api/testing，M2-P6 复验 R-S4）：这里转出的东西，生产代码经各自模块的
// 公开入口本来拿不到（lint 按引用的路径拦下）。放进 app/index.ts 的话，命令行与 app 层的其他文件经 app/index.ts 转手引用它们时，
// 按路径生效的限制认不出来。所以单独一个入口，而且是测试辅助（*.test-support.ts）：
// - 不进构建产物（tsconfig.build.json 排除测试辅助），包的出口也只给源码条件，生产环境里解析不到；
// - 只有 tests/integration 能引用它：apps/api 里的任何文件（包括单元测试）引用都由 lint 拦下（eslint 的 nerve/api-integration-entry），
//   别的元素由模块边界拦下。
// 只放这类东西（数据库句柄、documents 的仓储与全部的表定义）；集成测试用到的其余程序接口（建应用、迁移、各模块的服务）照旧经 app/index.ts
import { auditEvents } from '../db/schema/audit/index.ts'
import { authInvitations, authLoginThrottles, authPasswordResets, authSessions } from '../db/schema/auth/index.ts'
import { documentContents, documentGrants, documentRevisions, documents, folders, trashEntries } from '../db/schema/documents/index.ts'
import { spaceMembers, spaces } from '../db/schema/spaces/index.ts'
import { users } from '../db/schema/users/index.ts'

/**
 * 全部的表（与 drizzle.config.ts 的 schema 是同一组模块，src/db/schema/<模块>/index.ts）：集成测试按它用 drizzle-kit 生成建库语句，
 * 建出的库与执行全部迁移建出的库逐项比较（database/schema-parity.test.ts，M2-P6 复核 B 的 B4）。门禁 schema 只比较表定义与快照、
 * 不看迁移的 SQL，手写或改过的迁移与表定义不一致要靠这一步发现。
 * 按名字列出（不用命名空间导入：documents 的模块入口与它同名，受限导入的名单会把命名空间导入当作引用了受限的服务）。
 * 新加一张表时一并加在这里：漏了的话，迁移建出的库里多出它，那条用例会失败并列出来
 */
export const TABLE_DEFINITIONS: Readonly<Record<string, unknown>> = {
  auditEvents,
  authInvitations,
  authLoginThrottles,
  authPasswordResets,
  authSessions,
  documentContents,
  documentGrants,
  documentRevisions,
  documents,
  folders,
  trashEntries,
  spaceMembers,
  spaces,
  users,
}
// 集成测试的探针直接拿数据库句柄：连接池与关闭顺序的用例（database/pool、api/shutdown）
export { DATABASE } from '../modules/database/index.ts'
export type { Database } from '../modules/database/index.ts'
// 直接核对 documents 的仓储只查给定范围里的文档（搜索的范围回归，M2-P6 复核 A 的 S3）
export { DocumentsRepository } from '../modules/documents/index.ts'
// 取应用的 HTTP 适配器，列出它注册的全部路由：核对每个接口的认证与"看不到与不存在"的覆盖（support/routes.ts，M2-P6 第 6 片复核 S5）
export { HttpAdapterHost } from '@nestjs/core'

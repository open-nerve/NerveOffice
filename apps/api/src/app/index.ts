// api 对外的程序接口（P2 设计 §3.2）：命令行与集成测试经这里建应用，走的是与进程入口相同的管线。
// 只放各模块经公开入口本来就能拿到的东西：数据库句柄与 documents 的仓储只给集成测试，在 integration.test-support.ts
// （包的出口 @nerve-office/api/testing）。放在这里的话，命令行与 app 层的其他文件经这里转手引用它们，lint 按路径的限制认不出来（M2-P6 复验 R-S4）
export { AuditModule, AuditService, RequestOrigin } from '../modules/audit/index.ts'
export type { AuditEvent, AuditOrigin } from '../modules/audit/index.ts'
export { ConfigError, loadConfig, loadConfigFromEnvironment, loadServerConfig, loadServerConfigFromEnvironment } from '../modules/config/index.ts'
export type { AppConfig, ServerConfig } from '../modules/config/index.ts'
export { DatabaseModule, MigrationError, MIGRATIONS_FOLDER, readExpectedMigrations, runMigrations, TransactionRunner } from '../modules/database/index.ts'
export type { MigrationOutcome, SchemaStatus, Transaction } from '../modules/database/index.ts'
// 集成测试用：按给定的时刻跑一轮回收站的清理、修订记录与回执的保留期清理（假时钟推进 30 天，不必真的等）；核对生产的时钟取的是数据库的时间
export { Clock, JobsModule, REVISION_PURGE_LOCK, RevisionPurgeJob, TRASH_PURGE_LOCK, TrashPurgeJob } from '../modules/jobs/index.ts'
export type { RevisionPurgeEnding, RevisionPurgeRound, TrashPurgeRound } from '../modules/jobs/index.ts'
export { AppLogger } from '../modules/logging/index.ts'
// 集成测试的探针用：在一个事务里直接调用空间的服务（名称撞上唯一约束之后事务仍可继续，M2-P2 审查 A6）
export { SpacesModule, SpacesService } from '../modules/spaces/index.ts'
export type { AdminInitializationInput, InitializedAdmin } from '../modules/users/index.ts'
export { AppError } from '../shared/errors/app-error.ts'
export { Public } from '../shared/public.ts'
export { ApplicationRuntime } from './application-runtime.ts'
export { createApplication } from './create-application.ts'
export type { ApplicationOptions } from './create-application.ts'
export { initializeAdmin } from './initialize-admin.ts'
export type { InitializeAdminOptions } from './initialize-admin.ts'
export { issueResetLink } from './issue-reset-link.ts'
export type { IssueResetLinkOptions } from './issue-reset-link.ts'
export type { ShutdownResult } from './shutdown.ts'

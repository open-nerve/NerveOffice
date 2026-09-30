// 只给集成测试用的程序接口（包的出口 @nerve-office/api/testing，M2-P6 复验 R-S4）：这里转出的东西，生产代码经各自模块的
// 公开入口本来拿不到（lint 按引用的路径拦下）。放进 app/index.ts 的话，命令行与 app 层的其他文件经 app/index.ts 转手引用它们时，
// 按路径生效的限制认不出来。所以单独一个入口，而且是测试辅助（*.test-support.ts）：
// - 不进构建产物（tsconfig.build.json 排除测试辅助），包的出口也只给源码条件，生产环境里解析不到；
// - 只有 tests/integration 能引用它：apps/api 里的任何文件（包括单元测试）引用都由 lint 拦下（eslint 的 nerve/api-integration-entry），
//   别的元素由模块边界拦下。
// 只放这类东西（数据库句柄与 documents 的仓储）；集成测试用到的其余程序接口（建应用、迁移、各模块的服务）照旧经 app/index.ts
// 集成测试的探针直接拿数据库句柄：连接池与关闭顺序的用例（database/pool、api/shutdown）
export { DATABASE } from '../modules/database/index.ts'
export type { Database } from '../modules/database/index.ts'
// 直接核对 documents 的仓储只查给定范围里的文档（搜索的范围回归，M2-P6 复核 A 的 S3）
export { DocumentsRepository } from '../modules/documents/index.ts'

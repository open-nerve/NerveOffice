// 测试构建里记下事务的发件箱 Worker（M4-P1 设计 §4 的"Worker 的整条管道与 strict"）：先包住 Worker 里的 IDBDatabase.prototype.transaction
// （transaction-recorder.ts，每开一个事务经 BroadcastChannel 告诉页面里的探针），再引入生产的入口——管道、存储、处理与空定时器都是生产的。
// 模块按引入的先后求值：包住在先；生产的入口求值时不开事务，第一个事务来自第一个请求。只在测试构建里（探针创建它）
import './transaction-recorder.ts'
import '../outbox.worker.ts'

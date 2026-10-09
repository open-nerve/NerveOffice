// 崩溃用例的发件箱 Worker（M4-P1 设计 §3.7、§3.8；只在测试构建里，崩溃探针 crash-probe.ts 创建它）：先包住 Worker 里的开事务
// （transaction-recorder.ts）与镜像的同步访问句柄的操作（mirror-recorder.ts），两样都经以 Worker 的名字为名的 BroadcastChannel 报给页面；
// 再引入生产的入口——管道、存储、OPFS 的镜像、处理与空定时器都是生产的。模块按引入的先后求值：包住在先，生产的入口求值时不开事务、不碰 OPFS
import './transaction-recorder.ts'
import './mirror-recorder.ts'
import '../outbox.worker.ts'
